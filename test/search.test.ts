import { describe, expect, it } from "vitest";
import { and, parseQuery, tokenize } from "../server/mail/search.ts";

describe("tokenize", () => {
  it("keeps quoted phrases and quoted operator values together", () => {
    expect(tokenize('from:ann "board meeting" subject:"q3 plan" -spam')).toEqual(['from:ann', '"board meeting"', 'subject:"q3 plan"', "-spam"]);
  });
});

describe("parseQuery", () => {
  it("maps Gmail operators to IMAP SEARCH keys", () => {
    const q = parseQuery("from:ann to:bob subject:invoice is:unread");
    expect(q.criteria).toEqual({ from: "ann", to: "bob", subject: "invoice", seen: false });
  });

  it("handles scope, attachments and labels", () => {
    const q = parseQuery("in:trash has:attachment label:Work report");
    expect(q.scope).toBe("trash");
    expect(q.hasAttachment).toBe(true);
    expect(q.criteria).toEqual({ keyword: "work", text: "report" });
  });

  it("ANDs repeated keys and negations with nested NOT/OR", () => {
    const q = parseQuery("alpha beta -gamma");
    expect(q.criteria).toEqual({ text: "alpha", not: { or: [{ not: { text: "beta" } }, { text: "gamma" }] } });
  });

  it("parses dates and relative ages", () => {
    const q = parseQuery("after:2024/01/31 older_than:2d");
    expect((q.criteria.since as Date).toISOString()).toBe("2024-01-31T00:00:00.000Z");
    expect(q.criteria.before).toBeInstanceOf(Date);
    expect(Date.now() - (q.criteria.before as Date).getTime()).toBeGreaterThan(2 * 86_400_000 - 5000);
  });

  it("treats unknown operators as text (URLs, 're:')", () => {
    expect(parseQuery("https://example.com").criteria).toEqual({ text: "https://example.com" });
  });

  it("an empty AND is ALL", () => {
    expect(and([])).toEqual({ all: true });
  });
});
