// Gmail-style labels are IMAP keywords: a message can carry any number of them, they
// live on the server (so they follow the mail to every device), and Thunderbird and
// Apple Mail show them as tags. Keywords are ASCII atoms, so a label name is encoded:
// lowercased, spaces and IMAP specials become "_", and non-ASCII text uses the same
// modified UTF-7 that IMAP uses for folder names.

const SYSTEM = new Set(["junk", "nonjunk", "notjunk", "forwarded", "old", "redirected", "nonphishing", "phishing"]);

/** Keywords that are client bookkeeping, not labels a person applied. */
export function isSystemKeyword(keyword: string): boolean {
  const k = keyword.toLowerCase();
  return k.startsWith("$") || k.startsWith("\\") || SYSTEM.has(k);
}

function encodeModifiedUtf7(text: string): string {
  let out = "";
  let pending = "";
  const flush = () => {
    if (!pending) return;
    const utf16 = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) utf16.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += "&" + utf16.toString("base64").replace(/=+$/, "").replace(/\//g, ",") + "-";
    pending = "";
  };
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === "&" ? "&-" : ch;
    } else {
      pending += ch;
    }
  }
  flush();
  return out;
}

function decodeModifiedUtf7(text: string): string {
  return text.replace(/&([A-Za-z0-9+,]*)-/g, (_, b64: string) => {
    if (!b64) return "&";
    const buf = Buffer.from(b64.replace(/,/g, "/"), "base64");
    let s = "";
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  });
}

export function labelToKeyword(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[\s(){}%*"\\\]\x00-\x1f\x7f]+/g, "_");
  let keyword = encodeModifiedUtf7(ascii);
  // "$" and "\" prefixes are reserved for system flags.
  if (/^[$\\]/.test(keyword)) keyword = "_" + keyword.slice(1);
  return keyword || "_";
}

/** A readable name for a keyword another client created. */
export function keywordToLabel(keyword: string): string {
  return decodeModifiedUtf7(keyword).replace(/_/g, " ");
}

/** Stored form for LIKE matching: " a b c ". */
export function packKeywords(flags: Iterable<string>): string {
  const kws = [...flags].filter((f) => !f.startsWith("\\")).map((f) => f.toLowerCase());
  return ` ${[...new Set(kws)].join(" ")} `.replace(/^ {2}$/, " ");
}

export function unpackKeywords(packed: string): string[] {
  return packed.trim() ? packed.trim().split(" ") : [];
}
