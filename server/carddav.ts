// A small CardDAV client (RFC 6352, on WebDAV, RFC 4918): what syncing an address book
// needs and no more. It finds the person's address books (RFC 6764 discovery), lists
// what changed (sync-collection, RFC 6578, or every ETag where a server lacks it),
// fetches cards (addressbook-multiget), and writes with If-Match / If-None-Match, so a
// change made elsewhere is never overwritten unseen.
import { XMLParser } from "fast-xml-parser";
import { VERSION } from "./config.ts";

export interface DavAuth {
  username: string;
  password: string;
}

export interface AddressBook {
  url: string;
  name: string;
  syncToken: string | null;
}

export class DavError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 20_000;
const MULTIGET_BATCH = 50;
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => ["response", "propstat", "href"].includes(name),
});

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface DavResponse {
  href: string;
  /** The response's own status (a removed member in a sync report has one). */
  status: number | null;
  /** Properties that came back 200. */
  props: Record<string, unknown>;
}

const statusCode = (s: unknown) => {
  const m = /HTTP\/[\d.]+\s+(\d{3})/.exec(String(s ?? ""));
  return m ? Number(m[1]) : null;
};

/** A property's text, whether the parser gave a string or an element with text in it. */
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "#text" in (value as object)) return String((value as { "#text": unknown })["#text"]);
  return null;
}

export class DavClient {
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(auth: DavAuth, timeoutMs = TIMEOUT_MS) {
    this.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
    this.timeoutMs = timeoutMs;
  }

  async request(method: string, url: string, opts: { body?: string; headers?: Record<string, string>; depth?: "0" | "1" } = {}) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authorization,
          "User-Agent": `Viauna/${VERSION}`,
          ...(opts.body !== undefined ? { "Content-Type": opts.headers?.["Content-Type"] ?? 'application/xml; charset="utf-8"' } : {}),
          ...(opts.depth ? { Depth: opts.depth } : {}),
          ...opts.headers,
        },
        body: opts.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DavError(`The contacts server didn't answer (${(err as Error).message}).`, 0);
    }
    if (res.status === 401) throw new DavError("The contacts server didn't accept this mailbox's password.", 401);
    return { status: res.status, headers: res.headers, url: res.url || url, text: await res.text() };
  }

  /** A 207 multistatus, parsed; anything else is an error. */
  async multistatus(method: string, url: string, body: string, depth: "0" | "1"): Promise<{ responses: DavResponse[]; syncToken: string | null }> {
    const res = await this.request(method, url, { body, depth });
    if (res.status !== 207) throw new DavError(`The contacts server refused ${method} (HTTP ${res.status}).`, res.status);
    let doc: Record<string, any>;
    try {
      doc = parser.parse(res.text);
    } catch {
      throw new DavError("The contacts server sent something that isn't WebDAV.", 502);
    }
    const ms = doc.multistatus ?? {};
    const responses: DavResponse[] = (ms.response ?? []).map((r: Record<string, any>) => {
      const props: Record<string, unknown> = {};
      for (const ps of r.propstat ?? []) {
        if ((statusCode(ps.status) ?? 200) === 200 && ps.prop && typeof ps.prop === "object") Object.assign(props, ps.prop);
      }
      return { href: new URL(String(text(r.href?.[0]) ?? ""), res.url).toString(), status: statusCode(r.status), props };
    });
    return { responses, syncToken: text(ms["sync-token"]) };
  }

  private async hrefProp(url: string, prop: string, ns: "d" | "c"): Promise<string | null> {
    try {
      const { responses } = await this.multistatus("PROPFIND", url, `<?xml version="1.0"?><d:propfind ${NS}><d:prop><${ns}:${prop}/></d:prop></d:propfind>`, "0");
      const value = responses[0]?.props[prop] as { href?: string[] } | undefined;
      const href = value?.href?.[0];
      return href ? new URL(href, url).toString() : null;
    } catch (err) {
      if (err instanceof DavError && err.status === 401) throw err;
      return null;
    }
  }

  /** The address books in a collection (Depth 1), or the URL itself if it is one. */
  private async booksIn(url: string, depth: "0" | "1"): Promise<AddressBook[]> {
    const { responses } = await this.multistatus(
      "PROPFIND",
      url,
      `<?xml version="1.0"?><d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><d:sync-token/></d:prop></d:propfind>`,
      depth,
    );
    return responses
      .filter((r) => r.props.resourcetype && typeof r.props.resourcetype === "object" && "addressbook" in (r.props.resourcetype as object))
      .map((r) => ({
        url: r.href.endsWith("/") ? r.href : `${r.href}/`,
        name: text(r.props.displayname) || decodeURIComponent(r.href.replace(/\/$/, "").split("/").pop() ?? "Contacts"),
        syncToken: text(r.props["sync-token"]),
      }));
  }

  /**
   * The person's address books, found from the server's address: its principal (the
   * address itself, or the server's /.well-known/carddav), the principal's address book
   * home, and the books in it. An address that is itself a book or a home works too.
   */
  async discover(start: string): Promise<{ home: string; books: AddressBook[] }> {
    const origin = new URL(start).origin;
    const principal = (await this.hrefProp(start, "current-user-principal", "d")) ?? (await this.hrefProp(`${origin}/.well-known/carddav`, "current-user-principal", "d"));
    const home = (principal && (await this.hrefProp(principal, "addressbook-home-set", "c"))) ?? start;
    let books = await this.booksIn(home, "1");
    if (!books.length && home !== start) books = await this.booksIn(start, "1");
    if (!books.length) books = await this.booksIn(start, "0").catch(() => []);
    return { home: home.endsWith("/") ? home : `${home}/`, books };
  }

  /** Makes an address book (extended MKCOL, RFC 5689) under the home; returns its URL. */
  async createBook(home: string, name: string): Promise<string> {
    const url = new URL("contacts/", home).toString();
    const res = await this.request("MKCOL", url, {
      body: `<?xml version="1.0"?><d:mkcol ${NS}><d:set><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>${xmlEscape(name)}</d:displayname></d:prop></d:set></d:mkcol>`,
    });
    if (res.status !== 201 && res.status !== 200) throw new DavError(`The contacts server wouldn't make an address book (HTTP ${res.status}).`, res.status);
    return url;
  }

  /**
   * What changed in a book since `token`: members to fetch (with their ETags) and
   * members gone. Without a token, or if the server forgot it, every member is listed
   * (full: true). A server without sync-collection is listed by ETag instead.
   */
  async changes(book: string, token: string | null): Promise<{ token: string | null; changed: { href: string; etag: string | null }[]; removed: string[]; full: boolean }> {
    const report = (t: string) =>
      this.multistatus(
        "REPORT",
        book,
        `<?xml version="1.0"?><d:sync-collection ${NS}><d:sync-token>${xmlEscape(t)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        "1",
      );
    const members = (responses: DavResponse[]) => responses.filter((r) => r.href.replace(/\/$/, "") !== book.replace(/\/$/, "") && !r.href.endsWith("/"));
    if (token) {
      try {
        const { responses, syncToken } = await report(token);
        const list = members(responses);
        return {
          token: syncToken,
          changed: list.filter((r) => r.status !== 404).map((r) => ({ href: r.href, etag: text(r.props.getetag) })),
          removed: list.filter((r) => r.status === 404).map((r) => r.href),
          full: false,
        };
      } catch (err) {
        // A token the server no longer knows (403/409/410/412): start again from nothing.
        if (!(err instanceof DavError) || err.status === 0 || err.status === 401 || err.status >= 500) throw err;
      }
    }
    try {
      const { responses, syncToken } = await report("");
      return { token: syncToken, changed: members(responses).filter((r) => r.status !== 404).map((r) => ({ href: r.href, etag: text(r.props.getetag) })), removed: [], full: true };
    } catch (err) {
      if (!(err instanceof DavError) || err.status === 0 || err.status === 401 || err.status >= 500) throw err;
    }
    const { responses } = await this.multistatus("PROPFIND", book, `<?xml version="1.0"?><d:propfind ${NS}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`, "1");
    return { token: null, changed: members(responses).map((r) => ({ href: r.href, etag: text(r.props.getetag) })), removed: [], full: true };
  }

  /** The cards at these URLs, with their ETags. */
  async fetchCards(book: string, hrefs: string[]): Promise<{ href: string; etag: string | null; data: string }[]> {
    const out: { href: string; etag: string | null; data: string }[] = [];
    for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
      const batch = hrefs.slice(i, i + MULTIGET_BATCH).map((h) => `<d:href>${xmlEscape(new URL(h).pathname)}</d:href>`).join("");
      const { responses } = await this.multistatus(
        "REPORT",
        book,
        `<?xml version="1.0"?><c:addressbook-multiget ${NS}><d:prop><d:getetag/><c:address-data/></d:prop>${batch}</c:addressbook-multiget>`,
        "1",
      );
      for (const r of responses) {
        const data = text(r.props["address-data"]);
        if (data) out.push({ href: r.href, etag: text(r.props.getetag), data });
      }
    }
    return out;
  }

  /** Writes a card: a new one only if nothing is there (etag null), else only if unchanged. */
  async putCard(url: string, vcard: string, etag: string | null): Promise<{ etag: string | null }> {
    const res = await this.request("PUT", url, {
      body: vcard,
      headers: { "Content-Type": "text/vcard; charset=utf-8", ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }) },
    });
    if (res.status === 412) throw new DavError("Changed on the contacts server since it was last fetched.", 412);
    if (res.status < 200 || res.status >= 300) throw new DavError(`The contacts server refused to save a contact (HTTP ${res.status}).`, res.status);
    return { etag: res.headers.get("etag") };
  }

  async deleteCard(url: string, etag: string | null): Promise<void> {
    const res = await this.request("DELETE", url, { headers: etag ? { "If-Match": etag } : {} });
    if (res.status === 412) throw new DavError("Changed on the contacts server since it was last fetched.", 412);
    if (res.status === 404 || res.status === 410) return;
    if (res.status < 200 || res.status >= 300) throw new DavError(`The contacts server refused to delete a contact (HTTP ${res.status}).`, res.status);
  }
}
