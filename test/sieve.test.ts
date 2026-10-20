// Filters as Sieve (server/sieve.ts), checking what the page sends (server/filters.ts),
// and reading ManageSieve's responses (server/managesieve.ts).
import { afterEach, describe, expect, it } from "vitest";
import { readEnvironment } from "../server/config.ts";
import { FilterError, cleanFilter, cleanVacation } from "../server/filters.ts";
import { parseResponse } from "../server/managesieve.ts";
import { EMPTY_VACATION, type Filter, type SieveModel, alternatives, generate, readModel, str, words } from "../server/sieve.ts";

const ctx = { archive: "Archive", trash: "Trash", addresses: ["me@example.com", "me@alias.example"] };
const criteria = { from: "", to: "", subject: "", hasWords: "", doesntHave: "", hasAttachment: false, largerThan: null, smallerThan: null };
const actions = { skipInbox: false, markRead: false, star: false, label: null, moveTo: null, delete: false, forwardTo: null };
const filter = (c: Partial<Filter["criteria"]>, a: Partial<Filter["actions"]>, id = "f1"): Filter => ({ id, criteria: { ...criteria, ...c }, actions: { ...actions, ...a } });
const model = (over: Partial<SieveModel>): SieveModel => ({ filters: [], vacation: EMPTY_VACATION, include: [], ...over });
const rules = (script: string) => script.split("\r\n\r\n").slice(1).join("\r\n\r\n");

describe("filters as Sieve", () => {
  it("quotes strings, and splits alternatives and words", () => {
    expect(str('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
    expect(alternatives("ann@example.com, bob@example.com OR carol")).toEqual(["ann@example.com", "bob@example.com", "carol"]);
    expect(words('invoice "due today" now')).toEqual(["invoice", "due today", "now"]);
  });

  it("writes a Gmail-style filter: label, mark read, skip the inbox", () => {
    const { script, uses } = generate(model({ filters: [filter({ from: "billing@shop.example, accounts@shop.example", subject: "Invoice" }, { label: "finance", markRead: true, skipInbox: true })] }), ctx);
    expect(rules(script)).toBe(
      [
        'require ["fileinto", "imap4flags"];',
        "",
        "# Filter 1",
        'if allof (header :contains "from" ["billing@shop.example", "accounts@shop.example"], header :contains "subject" "Invoice") {',
        '  addflag "\\\\Seen";',
        '  addflag "finance";',
        '  fileinto "Archive";',
        "}",
        "",
      ].join("\r\n"),
    );
    expect([...uses]).toEqual(["imap4flags", "fileinto"]);
  });

  it("covers words, attachments, size, star, a folder, deleting and forwarding", () => {
    const { script } = generate(
      model({
        filters: [
          filter({ hasWords: 'urgent "due today"', doesntHave: "newsletter unsubscribe", hasAttachment: true, largerThan: 1_000_000 }, { star: true, moveTo: "Work/Reports" }),
          filter({ to: "team@example.com", smallerThan: 5000 }, { delete: true, forwardTo: "archive@example.net" }, "f2"),
        ],
      }),
      ctx,
    );
    const r = rules(script);
    expect(r).toContain('require ["body", "copy", "fileinto", "imap4flags", "mime"];');
    expect(r).toContain(
      'if allof (body :text :contains "urgent", body :text :contains "due today", not body :text :contains ["newsletter", "unsubscribe"], header :mime :anychild :contains "Content-Disposition" "attachment", size :over 1000000) {',
    );
    expect(r).toContain('  addflag "\\\\Flagged";\r\n  fileinto "Work/Reports";');
    expect(r).toContain('if allof (header :contains ["to", "cc"] "team@example.com", size :under 5000) {\r\n  redirect :copy "archive@example.net";\r\n  fileinto "Trash";\r\n}');
  });

  it("makes Archive only when the mailbox has none", () => {
    const { script, uses } = generate(model({ filters: [filter({ subject: "x" }, { skipInbox: true })] }), { ...ctx, archive: null });
    expect(rules(script)).toContain('fileinto :create "Archive";');
    expect(uses.has("mailbox")).toBe(true);
  });

  it("writes the vacation responder first, between its days, for every address", () => {
    const { script } = generate(
      model({
        vacation: { on: true, start: "2026-12-20", end: "2026-12-31", subject: "Away", message: 'Back in January.\nUrgent? Call "Ann".', zone: "+0800" },
        filters: [filter({ subject: "x" }, { star: true })],
      }),
      ctx,
    );
    const r = rules(script);
    expect(r.indexOf("vacation")).toBeLessThan(r.indexOf("# Filter 1"));
    expect(r).toContain('require ["date", "imap4flags", "relational", "vacation"];');
    expect(r).toContain(
      'if allof (currentdate :zone "+0800" :value "ge" "date" "2026-12-20", currentdate :zone "+0800" :value "le" "date" "2026-12-31") {\r\n  vacation :days 4 :subject "Away" :addresses ["me@example.com", "me@alias.example"] "Back in January.\r\nUrgent? Call \\"Ann\\".";\r\n}',
    );
    // Without dates it simply replies.
    const always = rules(generate(model({ vacation: { ...EMPTY_VACATION, on: true, message: "Away." } }), ctx).script);
    expect(always).toContain('require "vacation";');
    expect(always).toContain('vacation :days 4 :addresses ["me@example.com", "me@alias.example"] "Away.";');
  });

  it("keeps another app's rules running after Viauna's", () => {
    const r = rules(generate(model({ filters: [filter({ subject: "x" }, { star: true })], include: ["roundcube"] }), ctx).script);
    expect(r).toContain('require ["imap4flags", "include"];');
    expect(r.trimEnd().endsWith('include :personal :optional "roundcube";')).toBe(true);
  });

  it("reads back the model it wrote, and notices an edit made elsewhere", () => {
    const m = model({ filters: [filter({ from: "ann@example.com" }, { label: "friends" })], vacation: { ...EMPTY_VACATION, on: true, message: "Line one\nline two" } });
    const { script } = generate(m, ctx);
    expect(readModel(script)).toEqual({ model: m, changedElsewhere: false });
    expect(readModel(script.replace('addflag "friends";', 'addflag "family";'))?.changedElsewhere).toBe(true);
    expect(readModel('require "fileinto";\r\nif true { fileinto "X"; }\r\n')).toBeNull();
  });
});

describe("checking a filter from the page", () => {
  const folders = new Set(["INBOX", "Archive", "Receipts"]);
  afterEach(() => readEnvironment());

  it("needs something to match and something to do", () => {
    expect(() => cleanFilter({ criteria: {}, actions: { star: true } }, folders)).toThrow(/which messages/);
    expect(() => cleanFilter({ criteria: { from: "a" }, actions: {} }, folders)).toThrow(/what the filter does/);
    expect(cleanFilter({ criteria: { from: " ann " }, actions: { moveTo: "Receipts" } }, folders)).toMatchObject({ criteria: { from: "ann" }, actions: { moveTo: "Receipts" } });
  });

  it("refuses a folder that isn't there, a label that can't be one, and control characters", () => {
    expect(() => cleanFilter({ criteria: { from: "a" }, actions: { moveTo: "Nope" } }, folders)).toThrow(/folder doesn't exist/);
    expect(() => cleanFilter({ criteria: { from: "a" }, actions: { label: "two words" } }, folders)).toThrow(FilterError);
    expect(() => cleanFilter({ criteria: { subject: "a\nb" }, actions: { star: true } }, folders)).toThrow(/one line/);
    // Read back from the server, a folder that has since gone is kept.
    expect(cleanFilter({ criteria: { from: "a" }, actions: { moveTo: "Nope" } }, null).actions.moveTo).toBe("Nope");
  });

  it("forwards only when the server allows it", () => {
    const fwd = { criteria: { from: "a" }, actions: { forwardTo: "me@elsewhere.example" } };
    expect(() => cleanFilter(fwd, folders)).toThrow(/Forwarding in filters is turned off/);
    readEnvironment({ ...process.env, FILTER_FORWARDING: "true" });
    expect(cleanFilter(fwd, folders).actions.forwardTo).toBe("me@elsewhere.example");
    expect(() => cleanFilter({ ...fwd, actions: { forwardTo: "not an address" } }, folders)).toThrow(/isn't an email address/);
  });

  it("checks the vacation responder's days and message", () => {
    expect(cleanVacation({ on: true, message: "Away", start: "2026-12-20", end: "2026-12-31", zone: "+0800" })).toMatchObject({ on: true, zone: "+0800" });
    expect(() => cleanVacation({ on: true, message: "Away", start: "2026-12-31", end: "2026-12-20" })).toThrow(/before the first/);
    expect(() => cleanVacation({ on: true, message: "" })).toThrow(/Write the message/);
    expect(() => cleanVacation({ on: false, start: "31/12/2026" })).toThrow(/must be a date/);
    expect(cleanVacation({ on: false, zone: "Asia/Singapore" }).zone).toBeNull();
  });
});

describe("reading ManageSieve", () => {
  const parse = (s: string) => parseResponse(Buffer.from(s, "utf8"));

  it("reads lines, quoted strings and literals, and the final status", () => {
    const r = parse('"viauna" ACTIVE\r\n"roundcube"\r\nOK "Listscripts completed."\r\n');
    expect(r?.response).toMatchObject({ status: "OK", code: null, message: "Listscripts completed." });
    expect(r?.response.lines.map((l) => l.map((t) => ("v" in t ? t.v : t.t)))).toEqual([["viauna", "ACTIVE"], ["roundcube"]]);
    const script = 'require "fileinto";\r\n# Grüße "quoted"\r\n';
    const lit = parse(`{${Buffer.byteLength(script)}}\r\n${script}\r\nOK\r\n`);
    expect((lit?.response.lines[0][0] as { v: string }).v).toBe(script);
  });

  it("reads response codes and escapes, and waits for a whole response", () => {
    expect(parse('NO (QUOTA/MAXSIZE) "Script too \\"large\\"."\r\n')?.response).toMatchObject({ status: "NO", code: "QUOTA/MAXSIZE", message: 'Script too "large".' });
    expect(parse('"viauna" ACTIVE\r\nOK "Lists')).toBeNull();
    expect(parse("{20}\r\nnot all here")).toBeNull();
  });
});
