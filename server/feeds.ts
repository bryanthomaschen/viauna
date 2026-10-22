// Fetching a calendar from elsewhere by its address: public holidays, fixtures, another
// service's calendar. The address is anyone's to type, so the server fetches it the way it
// reaches a mail server someone typed at sign-in (netpolicy.ts): only at public addresses,
// each checked as the name is looked up and the connection made to the address checked,
// so a name that changes its answer in between can't point it inside; redirects are
// checked the same way. Limits on time and size, and conditional requests (ETag,
// Last-Modified), so a calendar that hasn't changed costs one small answer.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { VERSION, config } from "./config.ts";
import { isPrivateAddress } from "./netpolicy.ts";

export class FeedError extends Error {}

/** Fixed limits (docs/how-it-works/limits.md). */
export const FEED_LIMITS = {
  /** The file, after decompressing. */
  bytes: 10 * 1024 * 1024,
  /** One fetch, redirects and all. */
  timeoutMs: 30_000,
  redirects: 5,
  url: 2000,
  /** How often a calendar is fetched again. */
  refreshMs: 6 * 3_600_000,
  /** After a fetch that failed. */
  retryMs: 3_600_000,
  /** Refresh now, at most this often for one calendar. */
  manualMs: 60_000,
};

/**
 * An address as Viauna fetches it: webcal:// (what calendar apps call a calendar's
 * address) as https://. One with a name and password in it is refused: they'd be kept,
 * and shown, as part of the address.
 */
export function feedUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new FeedError("Give the calendar's address.");
  if (raw.length > FEED_LIMITS.url) throw new FeedError(`An address can be at most ${FEED_LIMITS.url.toLocaleString("en")} characters.`);
  let url: URL;
  try {
    url = new URL(raw.replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new FeedError("That isn't a web address. A calendar's starts with https:// or webcal://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeedError("A calendar's address starts with https://, http:// or webcal://.");
  if (url.username || url.password) throw new FeedError("An address with a name and password in it can't be used. Use the calendar's secret address instead.");
  url.hash = "";
  return url.toString();
}

const BLOCKED = "That address isn't allowed: it's on a private network.";

/** The name looked up, every address it has checked, and the connection made to one of them. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, found) => {
    if (err) return callback(err, "", 0);
    const list = found as unknown as dns.LookupAddress[];
    if (!list.length) return callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), "", 0);
    if (!config.allowPrivateServers && list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(BLOCKED), { code: "EVIAUNAPRIVATE" }), "", 0);
    }
    if (options.all) (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

/** What went wrong, in words for the page. */
function describe(err: unknown, url: URL): FeedError {
  if (err instanceof FeedError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  if (code === "EVIAUNAPRIVATE") return new FeedError(BLOCKED);
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "ABORT_ERR") return new FeedError("The calendar's server took too long to answer.");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new FeedError(`Couldn't find the server "${url.hostname}".`);
  if (code === "ECONNREFUSED") return new FeedError("The calendar's server refused the connection.");
  if (code === "ECONNRESET" || code === "EPIPE") return new FeedError("The calendar's server closed the connection.");
  if (code === "EPROTO") return new FeedError("The calendar's server doesn't answer over https.");
  if (/CERT|SSL|TLS|SELF_SIGNED|ERR_TLS/i.test(code)) return new FeedError("The calendar's server's certificate isn't valid.");
  if (/^Z_|^ERR__ERROR/.test(code)) return new FeedError("The calendar's server sent a file that wouldn't decompress.");
  return new FeedError(`Couldn't fetch the calendar (${e?.message ?? String(err)}).`);
}

/** Whether a failure was in reaching the server (so plain http might do), not in what it said. */
const unreachable = (err: unknown) => /refused the connection|closed the connection|certificate|over https|took too long/.test((err as Error).message);

function request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An address written as one isn't looked up, so it's checked here.
  if (net.isIP(host) && !config.allowPrivateServers && isPrivateAddress(host)) return Promise.reject(new FeedError(BLOCKED));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "GET", headers, lookup: publicLookup, signal }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** The body, decompressed, refused once it's over the limit. */
async function readBody(res: http.IncomingMessage): Promise<Buffer> {
  const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  const declared = Number(res.headers["content-length"]);
  if (encoding === "identity" && declared > FEED_LIMITS.bytes) {
    res.destroy();
    throw new FeedError("That calendar is too large: over 10 MB.");
  }
  let body: Readable = res;
  if (encoding === "gzip" || encoding === "x-gzip") body = res.pipe(zlib.createGunzip());
  else if (encoding === "deflate") body = res.pipe(zlib.createInflate());
  else if (encoding === "br") body = res.pipe(zlib.createBrotliDecompress());
  else if (encoding !== "identity") {
    res.destroy();
    throw new FeedError(`The calendar's server sent it encoded as "${encoding}", which Viauna can't read.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > FEED_LIMITS.bytes) {
      res.destroy();
      body.destroy();
      throw new FeedError("That calendar is too large: over 10 MB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface Fetched {
  /** The server said it hasn't changed since the validators given. */
  notModified: boolean;
  text: string;
  etag: string | null;
  lastModified: string | null;
}

async function fetchOnce(start: URL, previous: { etag?: string | null; lastModified?: string | null }): Promise<Fetched> {
  const signal = AbortSignal.timeout(FEED_LIMITS.timeoutMs);
  let url = start;
  for (let hop = 0; hop <= FEED_LIMITS.redirects; hop++) {
    const headers: Record<string, string> = {
      "User-Agent": `Viauna/${VERSION} (calendar; +https://github.com/bryanthomaschen/viauna)`,
      Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
    };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;
    let res: http.IncomingMessage;
    try {
      res = await request(url, headers, signal);
    } catch (err) {
      throw describe(err, url);
    }
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume();
      const location = res.headers.location;
      let next: URL | null = null;
      try {
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      if (!next || (next.protocol !== "https:" && next.protocol !== "http:")) throw new FeedError("The calendar's server sent it somewhere Viauna can't follow.");
      url = next;
      continue;
    }
    if (status === 304) {
      res.resume();
      return { notModified: true, text: "", etag: previous.etag ?? null, lastModified: previous.lastModified ?? null };
    }
    if (status !== 200) {
      res.resume();
      throw new FeedError(`The calendar's server answered ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""}.`);
    }
    let body: Buffer;
    try {
      body = await readBody(res);
    } catch (err) {
      throw describe(err, url);
    }
    const header = (name: string) => {
      const v = res.headers[name];
      return typeof v === "string" && v.length <= 255 ? v : null;
    };
    return { notModified: false, text: body.toString("utf8"), etag: header("etag"), lastModified: header("last-modified") };
  }
  throw new FeedError("The address redirects too many times.");
}

/**
 * Fetches a calendar's address, asking only for a change since `previous` if given. A
 * webcal:// address is tried over https, then over plain http if its server can't be
 * reached that way: webcal names neither.
 */
export async function fetchFeed(address: string, previous: { etag?: string | null; lastModified?: string | null } = {}): Promise<Fetched> {
  const url = new URL(feedUrl(address));
  try {
    return await fetchOnce(url, previous);
  } catch (err) {
    if (!/^webcal:/i.test(address.trim()) || !unreachable(err)) throw err;
    url.protocol = "http:";
    return fetchOnce(url, previous);
  }
}
