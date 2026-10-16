import { describe, expect, it } from "vitest";
import { isSystemKeyword, keywordToLabel, labelToKeyword, packKeywords, unpackKeywords } from "../server/mail/keywords.ts";

describe("labels as IMAP keywords", () => {
  it("encodes names as valid IMAP atoms", () => {
    for (const name of ["Work", "Receipts & Bills", "Travel (2026)", "日本", "Café", "$weird", 'say "hi"', "a%b*c"]) {
      const kw = labelToKeyword(name);
      expect(kw).toMatch(/^[^\s(){}%*"\\\]\x00-\x1f\x7f$][^\s(){}%*"\\\]\x00-\x1f\x7f]*$/);
    }
  });

  it("round-trips non-ASCII names", () => {
    expect(keywordToLabel(labelToKeyword("日本"))).toBe("日本");
    expect(keywordToLabel(labelToKeyword("café"))).toBe("café");
    expect(keywordToLabel(labelToKeyword("To Do"))).toBe("to do");
  });

  it("hides client bookkeeping keywords", () => {
    expect(isSystemKeyword("$Forwarded")).toBe(true);
    expect(isSystemKeyword("NonJunk")).toBe(true);
    expect(isSystemKeyword("work")).toBe(false);
  });

  it("packs flags for LIKE/instr matching", () => {
    const packed = packKeywords(new Set(["\\Seen", "Work", "travel"]));
    expect(packed).toBe(" work travel ");
    expect(unpackKeywords(packed)).toEqual(["work", "travel"]);
    expect(packKeywords([])).toBe(" ");
  });
});
