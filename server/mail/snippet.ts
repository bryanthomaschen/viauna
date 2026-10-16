// The grey preview text after the subject in the list. Built from the first couple of
// kilobytes of the text part, so a list of 50 conversations never downloads 50 bodies.
import { decodeHTML } from "entities";

export const SNIPPET_LENGTH = 200;

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label === "us-ascii" || label === "ascii" ? "utf-8" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Undo the transfer encoding of a (possibly truncated) body part. */
export function decodeTransfer(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding || "").toLowerCase()) {
    case "base64": {
      const clean = raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
      return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
    }
    case "quoted-printable": {
      const text = raw.toString("latin1").replace(/=\r?\n/g, "");
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          out.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else if (c === "=" && i >= text.length - 2) {
          break; // a sequence cut off by the partial fetch
        } else {
          out.push(text.charCodeAt(i) & 0xff);
        }
      }
      return Buffer.from(out);
    }
    default:
      return raw;
  }
}

export function htmlToPlain(html: string): string {
  return decodeHTML(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?(<\/\1>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*(>|$)/g, " "),
  );
}

/** Reduce body text to a one-line preview: no quoted reply, no whitespace runs. */
export function cleanSnippet(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (/^>/.test(t)) continue;
    // Where the quoted original starts: "On Tue, Bob wrote:" and its translations.
    if (/^(on|am|le|el|il|op|em|den)\b.{0,200}(wrote|schrieb|a écrit|escribió|ha scritto|schreef|escreveu|skrev)\s*:?$/i.test(t)) break;
    if (/^-{2,}\s*(original message|forwarded message|ursprüngliche nachricht)/i.test(t)) break;
    if (/^_{8,}$/.test(t)) break;
    lines.push(t);
  }
  const flat = lines
    .join(" ")
    .replace(/[\u200b-\u200f\u2028\u2029\u00ad\ufeff\u034f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\uFFFD+$/, "")
    .trim();
  if (flat.length <= SNIPPET_LENGTH) return flat;
  return flat.slice(0, SNIPPET_LENGTH).replace(/\s+\S*$/, "") + "…";
}

export function buildSnippet(
  raw: Buffer,
  part: { type: string; charset?: string; encoding?: string },
  alreadyDecoded: boolean,
): string {
  const bytes = alreadyDecoded ? raw : decodeTransfer(raw, part.encoding);
  const text = decodeCharset(bytes, part.charset);
  return cleanSnippet(part.type === "text/html" ? htmlToPlain(text) : text);
}
