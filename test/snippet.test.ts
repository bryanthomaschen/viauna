import { describe, expect, it } from "vitest";
import { buildSnippet, cleanSnippet, decodeTransfer, htmlToPlain } from "../server/mail/snippet.ts";

describe("snippets", () => {
  it("decodes truncated base64 and quoted-printable", () => {
    const b64 = Buffer.from(Buffer.from("Hello there, world").toString("base64").slice(0, 11));
    // 11 base64 chars: the last 3 are an incomplete group, so 8 chars -> 6 bytes.
    expect(decodeTransfer(b64, "base64").toString()).toBe("Hello ");
    // A character cut off by the partial fetch must not leave a replacement glyph behind.
    const qp = Buffer.from("caf=C3=A9 =\r\nlong line=E2=8");
    expect(buildSnippet(qp, { type: "text/plain", charset: "utf-8", encoding: "quoted-printable" }, false)).toBe("café long line");
  });

  it("decodes legacy charsets", () => {
    const raw = Buffer.from([0x93, 0x51, 0x94]);
    expect(buildSnippet(raw, { type: "text/plain", charset: "windows-1252" }, true)).toBe("“Q”");
  });

  it("drops quoted replies and collapses whitespace", () => {
    expect(cleanSnippet("Yes!\n\n  Sounds  good.\n\nOn Tue, Bob wrote:\n> Lunch?")).toBe("Yes! Sounds good.");
  });

  it("strips HTML, styles and entities", () => {
    expect(cleanSnippet(htmlToPlain("<style>p{x}</style><p>Fish &amp; chips</p><p>tonight</p>"))).toBe("Fish & chips tonight");
  });

  it("truncates at a word boundary", () => {
    const s = cleanSnippet("word ".repeat(100));
    expect(s.length).toBeLessThanOrEqual(201);
    expect(s.endsWith("…")).toBe(true);
  });
});
