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

  beforeAll(async () => {
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
});
