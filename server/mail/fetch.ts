// Full messages are downloaded on demand and kept in a size-bounded disk cache: a
// message under a given UID never changes, so re-opening a conversation is a local
// read. Parsed messages are also held briefly in memory, because one message with
// ten inline images is eleven requests.
import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedMail } from "mailparser";
import { config } from "../config.ts";
import type { AccountRuntime } from "../imap/runtime.ts";
import type { MailboxRow } from "../imap/store.ts";
import { log } from "../log.ts";
import { parseMessage } from "./render.ts";

const MAX_MESSAGE = 200 * 1024 * 1024;
const cacheRoot = () => path.join(config.dataDir, "cache");
let writesSinceTrim = 0;

function cachePath(accountId: number, mb: MailboxRow, uid: number): string {
  return path.join(cacheRoot(), String(accountId), `${mb.id}-${mb.uidvalidity ?? 0}-${uid}.eml`);
}

export async function getRaw(rt: AccountRuntime, mb: MailboxRow, uid: number): Promise<Buffer | null> {
  const file = cachePath(rt.account.id, mb, uid);
  try {
    const buf = await fs.readFile(file);
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => {});
    return buf;
  } catch {
    // not cached
  }
  const buf = await rt.withMailbox(
    mb.path,
    async (client) => {
      const dl = await client.download(String(uid), undefined, { uid: true, maxBytes: MAX_MESSAGE });
      if (!dl.content) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of dl.content) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    },
    true,
  );
  if (!buf) return null;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    await fs.rename(tmp, file);
    if (++writesSinceTrim >= 50) {
      writesSinceTrim = 0;
      void trimCache();
    }
  } catch (err) {
    log.warn("cache write failed", { error: (err as Error).message });
  }
  return buf;
}

/** Deletes least-recently-used cached messages until the cache fits CACHE_MB. */
export async function trimCache() {
  const files: { file: string; size: number; mtime: number }[] = [];
  try {
    for (const dir of await fs.readdir(cacheRoot())) {
      const full = path.join(cacheRoot(), dir);
      for (const name of await fs.readdir(full)) {
        const file = path.join(full, name);
        const st = await fs.stat(file).catch(() => null);
        if (st?.isFile()) files.push({ file, size: st.size, mtime: st.mtimeMs });
      }
    }
  } catch {
    return;
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= config.cacheBytes) break;
    await fs.rm(f.file, { force: true });
    total -= f.size;
  }
}

export async function dropAccountCache(accountId: number) {
  await fs.rm(path.join(cacheRoot(), String(accountId)), { recursive: true, force: true });
}

const parsedCache = new Map<string, Promise<ParsedMail | null>>();
const PARSED_MAX = 24;

export function getParsed(rt: AccountRuntime, mb: MailboxRow, uid: number): Promise<ParsedMail | null> {
  const key = `${rt.account.id}:${mb.id}:${mb.uidvalidity}:${uid}`;
  let entry = parsedCache.get(key);
  if (entry) {
    parsedCache.delete(key);
    parsedCache.set(key, entry);
    return entry;
  }
  entry = getRaw(rt, mb, uid).then((raw) => (raw ? parseMessage(raw) : null));
  entry.catch(() => parsedCache.delete(key));
  parsedCache.set(key, entry);
  while (parsedCache.size > PARSED_MAX) parsedCache.delete(parsedCache.keys().next().value!);
  return entry;
}
