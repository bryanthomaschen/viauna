// End-to-end against a real IMAP server: the dev Dovecot from dev/compose.yml and
// the dev SMTP sink (`npm run dev:mail`). Skipped unless VIAUNA_IT=1. The state store
// is SQLite unless VIAUNA_TEST_DATABASE_URL names a throwaway server database.
//
//   VIAUNA_IT=1 npx vitest run test/integration.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.VIAUNA_IT === "1";

Object.assign(process.env, {
  IMAP_HOST: process.env.IT_IMAP_HOST ?? "127.0.0.1",
  IMAP_PORT: process.env.IT_IMAP_PORT ?? "1143",
  IMAP_SECURITY: "none",
  SMTP_HOST: process.env.IT_SMTP_HOST ?? "127.0.0.1",
  SMTP_PORT: process.env.IT_SMTP_PORT ?? "1587",
  SMTP_SECURITY: "none",
  PUBLIC_URL: "http://localhost",
});

const user = `it-${crypto.randomBytes(4).toString("hex")}@example.test`;
const ORIGIN = { Origin: "http://localhost" };

async function append(folder: string, opts: Record<string, unknown>, flags: string[] = []) {
  const client = new ImapFlow({ host: "127.0.0.1", port: Number(process.env.IMAP_PORT), secure: false, doSTARTTLS: false, auth: { user, pass: "pass" }, logger: false });
  await client.connect();
  const raw = await new MailComposer(opts as never).compile().build();
  await client.append(folder, raw, flags);
  await client.logout();
}

const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!enabled)("against a real IMAP server", { timeout: 30_000 }, () => {
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let cookie = "";
  let stop: () => Promise<void>;
  let dataDir = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...ORIGIN, Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  // The operator's password command, for the last test: it records what it's given.
  let pwOut = "";

  beforeAll(async () => {
    const pwDir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-it-pw-"));
    pwOut = path.join(pwDir, "request.json");
    const script = path.join(pwDir, "change.mjs");
    fs.writeFileSync(script, `import fs from "node:fs"; let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => fs.writeFileSync(${JSON.stringify(pwOut)}, s));`);
    Object.assign(process.env, { PASSWORD_CHANGE: "command", PASSWORD_CHANGE_COMMAND: `"${process.execPath}" "${script}"` });
    if (process.env.VIAUNA_TEST_CARDDAV) process.env.CARDDAV_URL = `${process.env.VIAUNA_TEST_CARDDAV}/{login}/`;
    const url = process.env.VIAUNA_TEST_DATABASE_URL || undefined;
    if (url) await (await import("./databases.ts")).emptyDatabase(url);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-it-"));
    await (await import("../server/storage.ts")).initStorage({ dataDir, databaseUrl: url });
    const { createApp } = await import("../server/app.ts");
    const pool = await import("../server/imap/pool.ts");
    app = createApp();
    stop = pool.stopAll;
    const parent = `<parent-${Date.now()}@example.org>`;
    await append("INBOX", { from: "Ann <ann@example.org>", to: user, subject: "Lunch?", messageId: parent, text: "Noon at the usual place?" });
    await append("Sent", { from: user, to: "ann@example.org", subject: "Re: Lunch?", inReplyTo: parent, references: [parent], text: "Yes please" }, ["\\Seen"]);
    await append("INBOX", { from: "News <news@example.com>", to: user, subject: "Weekly digest", html: '<p>Hi</p><img src="https://t.example.com/p.gif">' });
  }, 30_000);

  afterAll(async () => {
    await stop?.();
    await (await import("../server/storage.ts")).closeStorage().catch(() => {});
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a wrong password, then signs in", async () => {
    expect((await call("POST", "/api/auth/login", { email: user, password: "nope" })).status).toBe(401);
    const ok = await call("POST", "/api/auth/login", { email: user, password: "pass" });
    expect(ok.status).toBe(200);
    expect(cookie).toMatch(/^viauna_session=/);
  });

  it("sends the cookie again when the session is extended, so a session in use doesn't lapse", async () => {
    const { state } = await import("../server/state/db.ts");
    await state().updateTable("sessions").set({ seen_at: Date.now() - 2 * 3600_000 }).execute();
    const res = await app.request("/api/session", { headers: { ...ORIGIN, Cookie: cookie } });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set.split(";")[0]).toBe(cookie);
    expect(set).toMatch(/Max-Age=2592000/);
    // At most hourly, not on every request.
    const again = await app.request("/api/session", { headers: { ...ORIGIN, Cookie: cookie } });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses cross-origin writes", async () => {
    const res = await app.request("/api/u/0/actions", { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("syncs folders and threads replies from Sent into the conversation", async () => {
    await until(async () => (await call("GET", "/api/u/0/mailboxes")).json.status.ready);
    const list = await until(async () => {
      const r = await call("GET", "/api/u/0/threads?view=inbox");
      return r.json.threads.length === 2 && r.json;
    });
    const lunch = list.threads.find((t: any) => t.subject === "Lunch?");
    expect(lunch.count).toBe(2);
    expect(lunch.participants.map((p: any) => p.name)).toEqual(["Ann", "me"]);
    // Snippets are filled in by the background pass, a moment after the list.
    const withSnippet = await until(async () => {
      const r = await call("GET", "/api/u/0/threads?view=inbox");
      return r.json.threads.find((t: any) => t.id === lunch.id && t.snippet);
    });
    expect(withSnippet.snippet).toBe("Yes please");
  });

  it("blocks remote images in the rendered message", async () => {
    const list = (await call("GET", "/api/u/0/threads?view=inbox")).json;
    const digest = list.threads.find((t: any) => t.subject === "Weekly digest");
    const conv = (await call("GET", `/api/u/0/threads/${digest.id}?view=inbox`)).json;
    const m = conv.messages[0];
    const r = (await call("GET", `/api/u/0/messages/${m.mailboxId}/${m.uid}`)).json;
    expect(r.remoteContent).toBe(true);
    expect(r.html).not.toContain("t.example.com");

    await call("POST", "/api/u/0/trusted-senders", { address: "news@example.com" });
    const trusted = (await call("GET", `/api/u/0/messages/${m.mailboxId}/${m.uid}`)).json;
    expect(trusted.trustedSender).toBe(true);
    expect(trusted.html).toContain("t.example.com");
  });

  it("keeps settings with the mailbox", async () => {
    await call("PUT", "/api/u/0/settings", { name: "Ivy Tester", pageSize: 25 });
    expect((await call("GET", "/api/u/0/settings")).json.settings).toMatchObject({ name: "Ivy Tester", pageSize: 25 });
    expect((await call("GET", "/api/session")).json.accounts[0].name).toBe("Ivy Tester");
  });

  it("keeps the admin page to admins, and applies their changes at once", async () => {
    expect((await call("GET", "/api/admin")).status).toBe(403);
    expect((await call("GET", "/api/session")).json.accounts[0].admin).toBe(false);
    const { COMMAND_LINE, changeSettings } = await import("../server/instance.ts");
    await changeSettings({ ADMIN_ADDRESSES: user }, COMMAND_LINE);
    expect((await call("GET", "/api/session")).json.accounts[0].admin).toBe(true);

    const page = await call("GET", "/api/admin");
    expect(page.status).toBe(200);
    expect(page.json.you).toBe(user);
    expect(page.json.settings.find((s: any) => s.env === "APP_NAME")).toMatchObject({ value: "Viauna", source: "default" });
    expect(page.json.server).toMatchObject({ imap: "127.0.0.1:1143, unencrypted", passwordCommand: true, passwordWebhook: false });
    expect(page.json.changes[0]).toMatchObject({ actor: "command line", env: "ADMIN_ADDRESSES", newValue: [user] });

    const saved = await call("PUT", "/api/admin/settings", { appName: "Team Mail" });
    expect(saved.status).toBe(200);
    expect(saved.json.changes[0]).toMatchObject({ actor: user, env: "APP_NAME", oldValue: null, newValue: "Team Mail" });
    expect((await call("GET", "/api/config")).json.appName).toBe("Team Mail");

    expect((await call("PUT", "/api/admin/settings", { admins: [] })).json.error).toMatch(/at least one admin/);
    expect((await call("PUT", "/api/admin/settings", { maxAccounts: 0 })).json.error).toMatch(/whole number from 1/);
    const forged = await app.request("/api/admin/settings", {
      method: "PUT",
      headers: { Origin: "https://evil.example", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Hijacked" }),
    });
    expect(forged.status).toBe(403);
    expect((await call("PUT", "/api/admin/settings", { appName: null })).status).toBe(200);
    expect((await call("GET", "/api/config")).json.appName).toBe("Viauna");
  });

  it("archives with undo, labels, and stars", async () => {
    const list = (await call("GET", "/api/u/0/threads?view=inbox")).json;
    const lunch = list.threads.find((t: any) => t.subject === "Lunch?");
    const archived = await call("POST", "/api/u/0/actions", { action: "archive", threads: [lunch.id], view: "inbox" });
    expect(archived.json.undo).toBeTruthy();
    expect((await call("GET", "/api/u/0/threads?view=inbox")).json.total).toBe(1);
    expect((await call("GET", "/api/u/0/threads?view=archive")).json.total).toBe(1);
    await call("POST", "/api/u/0/undo", { token: archived.json.undo });
    expect((await call("GET", "/api/u/0/threads?view=inbox")).json.total).toBe(2);

    await call("POST", "/api/u/0/labels", { name: "Food", color: "#16a766" });
    expect((await call("POST", "/api/u/0/labels", { name: "food" })).status).toBe(400);
    await call("POST", "/api/u/0/actions", { action: "label", threads: [lunch.id], keyword: "food", view: "inbox" });
    expect((await call("GET", "/api/u/0/threads?view=label:food")).json.total).toBe(1);
    const labels = (await call("GET", "/api/u/0/labels")).json.labels;
    expect(labels).toEqual([expect.objectContaining({ keyword: "food", name: "Food", color: "#16a766", total: 1 })]);
    await call("POST", "/api/u/0/actions", { action: "star", threads: [lunch.id], view: "inbox" });
    expect((await call("GET", "/api/u/0/threads?view=starred")).json.total).toBe(1);
  });

  it("searches on the server with Gmail syntax", async () => {
    const r = await call("GET", `/api/u/0/threads?q=${encodeURIComponent("from:ann noon")}`);
    expect(r.json.threads.map((t: any) => t.subject)).toEqual(["Lunch?"]);
    const none = await call("GET", `/api/u/0/threads?q=${encodeURIComponent("from:nobody")}`);
    expect(none.json.total).toBe(0);
  });

  it("renames a folder with its subfolders, and they stay listed", async () => {
    const folders = async () =>
      (await call("GET", "/api/u/0/mailboxes")).json.mailboxes.filter((m: any) => !m.specialUse).map((m: any) => m.path).sort();
    await call("POST", "/api/u/0/mailboxes", { name: "Projects" });
    const parent = await until(async () => (await call("GET", "/api/u/0/mailboxes")).json.mailboxes.find((m: any) => m.path === "Projects"));
    await call("POST", "/api/u/0/mailboxes", { name: "2026", parentId: parent.id });
    await until(async () => (await folders()).includes("Projects/2026"));
    expect((await call("PATCH", `/api/u/0/mailboxes/${parent.id}`, { name: "Work" })).status).toBe(200);
    expect(await until(async () => {
      const now = await folders();
      return now.includes("Work") && now.includes("Work/2026") && !now.includes("Projects") && now;
    })).toEqual(["Work", "Work/2026"]);

    const child = (await call("GET", "/api/u/0/mailboxes")).json.mailboxes.find((m: any) => m.path === "Work/2026");
    expect((await call("PATCH", `/api/u/0/mailboxes/${child.id}`, { name: "Q4" })).status).toBe(200);
    expect(await until(async () => {
      const now = await folders();
      return now.includes("Work/Q4") && !now.includes("Work/2026") && now;
    })).toEqual(["Work", "Work/Q4"]);
  });

  it("sends a reply: files it in Sent, threads it, flags the original", async () => {
    const list = (await call("GET", "/api/u/0/threads?view=inbox")).json;
    const lunch = list.threads.find((t: any) => t.subject === "Lunch?");
    const conv = (await call("GET", `/api/u/0/threads/${lunch.id}?view=inbox`)).json;
    const original = conv.messages[0];
    const sent = await call("POST", "/api/u/0/send", {
      from: user,
      to: [{ address: "ann@example.org" }],
      subject: "Re: Lunch?",
      html: "<p>See you there</p>",
      replyTo: { mailboxId: original.mailboxId, uid: original.uid },
      quote: { mailboxId: original.mailboxId, uid: original.uid, kind: "reply", header: "On Monday, Ann wrote:" },
    });
    expect(sent.status).toBe(200);
    expect(sent.json.threadId).toBe(lunch.id);
    const after = (await call("GET", `/api/u/0/threads/${lunch.id}?view=inbox`)).json;
    expect(after.messages).toHaveLength(3);
    expect(after.messages[0].answered).toBe(true);
  });

  it("tells open pages when a setting changes, so nothing waits for a reload", async () => {
    // Read the live-updates stream as a page does, collecting event names.
    const res = await app.request("/api/events", { headers: { Cookie: cookie } });
    const reader = res.body!.getReader();
    const seen: string[] = [];
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
        for (const m of text.matchAll(/^event: (\S+)$/gm)) seen.push(m[1]);
        text = text.slice(text.lastIndexOf("\n") + 1);
      }
    })();
    await until(async () => seen.includes("ready"));
    const { COMMAND_LINE, changeSettings } = await import("../server/instance.ts");
    await changeSettings({ appName: "Renamed" }, COMMAND_LINE);
    await until(async () => seen.includes("settings"));
    await call("PUT", "/api/u/0/settings", { pageSize: 100 });
    await until(async () => seen.includes("account-settings"));
    await changeSettings({ appName: null }, COMMAND_LINE);
    await call("PUT", "/api/u/0/settings", { pageSize: 50 });
    await reader.cancel();
    await pump.catch(() => {});
  });

  it("keeps an address book: create, suggest, import, export, and turn it off", async () => {
    expect((await call("GET", "/api/config")).json.contacts).toBe(true);
    const created = await call("POST", "/api/u/0/contacts", { firstName: "Ann", lastName: "Ong", emails: [{ address: "ann@example.org", label: "work" }] });
    expect(created.json.contact).toMatchObject({ name: "Ann Ong", fields: { emails: [{ address: "ann@example.org", label: "work" }] } });
    // The saved name wins over the one in her mail ("Ann"), and she isn't listed twice.
    const s = (await call("GET", "/api/u/0/suggestions?q=ann")).json.contacts;
    expect(s[0]).toEqual({ address: "ann@example.org", name: "Ann Ong" });
    expect(s.filter((x: any) => x.address === "ann@example.org")).toHaveLength(1);
    expect((await call("GET", "/api/u/0/contacts/lookup?address=ANN@example.org")).json.id).toBe(created.json.contact.id);

    const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Raj Kumar\r\nEMAIL:raj@example.in\r\nEND:VCARD\r\n";
    const imported = await app.request("/api/u/0/contacts/import", { method: "POST", headers: { ...ORIGIN, Cookie: cookie, "Content-Type": "text/vcard" }, body: vcf });
    expect(await imported.json()).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 0 });
    const list = (await call("GET", "/api/u/0/contacts")).json;
    expect(list.contacts.map((c: any) => c.name)).toEqual(["Ann Ong", "Raj Kumar"]);
    const exported = await app.request("/api/u/0/contacts/export", { headers: { Cookie: cookie } });
    expect(exported.headers.get("content-type")).toMatch(/^text\/vcard/);
    expect((await exported.text()).match(/BEGIN:VCARD/g)).toHaveLength(2);

    const { COMMAND_LINE, changeSettings } = await import("../server/instance.ts");
    await changeSettings({ contacts: false }, COMMAND_LINE);
    expect((await call("GET", "/api/config")).json.contacts).toBe(false);
    expect((await call("GET", "/api/u/0/contacts")).status).toBe(404);
    expect((await call("GET", "/api/u/0/suggestions?q=ann")).json.contacts[0]).toMatchObject({ address: "ann@example.org", name: "Ann" });
    await changeSettings({ contacts: null }, COMMAND_LINE);
    expect((await call("DELETE", `/api/u/0/contacts/${created.json.contact.id}`)).json).toEqual({ ok: true });
  });

  it.skipIf(!process.env.VIAUNA_TEST_CARDDAV)("syncs contacts with the CardDAV server as the mailbox", async () => {
    const created = await call("POST", "/api/u/0/contacts", { firstName: "Mo", emails: [{ address: "mo@example.net" }] });
    expect(created.status).toBe(200);
    const synced = await call("POST", "/api/u/0/contacts/sync");
    expect(synced.json.sync).toMatchObject({ server: new URL(process.env.VIAUNA_TEST_CARDDAV!).host, error: null, syncing: false });
    expect(synced.json.sync.books[0]).toMatchObject({ name: "Contacts" });
    const { DavClient } = await import("../server/carddav.ts");
    const dav = new DavClient({ username: user, password: "pass" });
    const { books } = await dav.discover(`${process.env.VIAUNA_TEST_CARDDAV}/`);
    const { changed } = await dav.changes(books[0].url, null);
    const cards = await dav.fetchCards(books[0].url, changed.map((c) => c.href));
    expect(cards.some((c) => c.data.includes("FN:Mo"))).toBe(true);
    expect((await call("GET", "/api/u/0/contacts")).json.sync.at).toBeGreaterThan(Date.now() - 60_000);
  });

  // Last: afterwards this session holds a password the dev server doesn't accept.
  it("changes the password with the operator's command, and signs the mailbox out elsewhere", async () => {
    expect((await call("GET", "/api/u/0/settings")).json.password).toEqual({ method: "form" });
    const other = await app.request("/api/auth/login", {
      method: "POST",
      headers: { ...ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ email: user, password: "pass" }),
    });
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0];
    const signedIn = async (c: string) => ((await (await app.request("/api/session", { headers: { Cookie: c } })).json()) as any).accounts.length;
    expect(await signedIn(otherCookie)).toBe(1);

    expect((await call("POST", "/api/u/0/password", { current: "wrong", next: "a new password" })).json.error).toBe("Your current password isn't right.");
    expect((await call("POST", "/api/u/0/password", { current: "pass", next: "short" })).json.error).toMatch(/at least 8/);
    expect(fs.existsSync(pwOut)).toBe(false);

    const changed = await call("POST", "/api/u/0/password", { current: "pass", next: "a new password" });
    expect(changed.json).toEqual({ ok: true, signedOut: 1 });
    expect(JSON.parse(fs.readFileSync(pwOut, "utf8"))).toEqual({ login: user, email: user, currentPassword: "pass", newPassword: "a new password" });
    expect(await signedIn(otherCookie)).toBe(0);
    expect(await signedIn(cookie)).toBe(1);
  });
});
