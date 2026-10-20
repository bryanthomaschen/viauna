import fs from "node:fs";
import path from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  type AuthContext,
  COOKIE_NAME,
  type SessionAccount,
  changePassword,
  credentialsFor,
  isSignedIn,
  loadSession,
  signIn,
  signOutAccount,
  signOutAll,
} from "./auth.ts";
import { VERSION, config, parseSetting, settingDef } from "./config.ts";
import type { Credentials } from "./crypto.ts";
import { db } from "./db.ts";
import { MailboxAuthError, runtimeFor, stillProven } from "./imap/pool.ts";
import { type AccountRuntime, type ChangeEvent, syncable } from "./imap/runtime.ts";
import { type MailboxRow, getMailbox, getMailboxes, specialUseName } from "./imap/store.ts";
import { changeSettings, describeSettings, isAdmin, recentChanges, serverFacts } from "./instance.ts";
import { log } from "./log.ts";
import { ActionError, type ActionInput, perform, undo } from "./mail/actions.ts";
import { ComposeError, type ComposeInput, discardDraft, saveDraft, saveUpload, sendMessage } from "./mail/compose.ts";
import { getParsed, getRaw } from "./mail/fetch.ts";
import { LabelError, createLabel, deleteLabel, listLabels, searchContacts, updateLabel } from "./mail/labels.ts";
import { attachmentList, editorHtml, render } from "./mail/render.ts";
import { parseQuery, searchThreads } from "./mail/search.ts";
import { type View, conversation, listThreads, parseView } from "./mail/views.ts";
import { passwordChangeFor } from "./password.ts";
import { getSettings, isTrustedSender, myAddresses, trustSender, updateSettings } from "./settings.ts";

type Env = {
  Bindings: HttpBindings;
  Variables: {
    auth: AuthContext | null;
    sa: SessionAccount;
    rt: AccountRuntime;
    creds: Credentials;
  };
};

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Remote images inside messages are allowed here and restricted per message by the
  // iframe's own CSP (srcdoc documents inherit this policy, so it must be the looser one).
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https: http:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function clientIp(c: Context<Env>): string {
  if (config.trustProxy) {
    // The last entry is the one our own proxy appended; anything to its left came
    // from the client and can say whatever it likes.
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return fwd.split(",").pop()!.trim();
  }
  return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * Whether a state-changing request came from our own pages. With PUBLIC_URL set
 * the origin must match it exactly; without it, the origin's host must be the host
 * the request was addressed to (the scheme isn't knowable behind a TLS proxy).
 */
function sameOrigin(c: Context<Env>, origin: string | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (config.publicUrl) return parsed.origin === new URL(config.publicUrl).origin;
  const host = (config.trustProxy && c.req.header("x-forwarded-host")) || c.req.header("host") || "";
  return !!host && parsed.host === host;
}

function setSessionCookie(c: Context<Env>, value: string) {
  setCookie(c, COOKIE_NAME, value, {
    path: "/",
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    maxAge: config.sessionDays * 86_400,
  });
}

function int(value: string | undefined, fallback = NaN): number {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function mailboxJson(mb: MailboxRow, accountId: number) {
  const use = specialUseName(mb.special_use);
  const unread = db().get<{ n: number }>(
    "SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE mailbox_id = ? AND seen = 0",
    mb.id,
  )!.n;
  const total = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?", mb.id)!.n;
  return {
    id: mb.id,
    path: mb.path,
    name: mb.name,
    parentPath: mb.parent_path,
    delimiter: mb.delimiter,
    specialUse: use,
    selectable: !!mb.selectable,
    subscribed: !!mb.subscribed,
    // Before the folder is fully indexed, the server's count is the honest one.
    unread: mb.backfill_done ? unread : Math.max(unread, mb.unseen ?? 0),
    total: mb.backfill_done ? total : (mb.total ?? total),
    indexed: total,
    syncing: !!mb.selectable && !mb.backfill_done,
    accountId,
  };
}

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

export function createApp() {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof MailboxAuthError) return c.json({ error: err.message, reauth: true }, 401);
    if (err instanceof ActionError || err instanceof ComposeError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof LabelError) return c.json({ error: err.message }, 400);
    log.error("request failed", { path: c.req.path, error: (err as Error).message, stack: (err as Error).stack });
    const message = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection not available|closed/i.test((err as Error).message)
      ? "The mail server isn't responding. Try again in a moment."
      : "Something went wrong.";
    return c.json({ error: message }, 500);
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    if (!c.res.headers.get("Content-Security-Policy")) c.header("Content-Security-Policy", APP_CSP);
  });

  // CSRF: state-changing requests must come from our own pages.
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin") ?? c.req.header("referer") ?? null;
      if (!sameOrigin(c, origin)) return c.json({ error: "Cross-origin request refused." }, 403);
    }
    c.set("auth", await loadSession(getCookie(c, COOKIE_NAME)));
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/api/config", (c) =>
    c.json({ appName: config.appName, version: VERSION, customServers: config.allowCustomServers, configured: !!config.imap }),
  );

  app.get("/api/session", async (c) => {
    const auth = c.get("auth");
    if (!auth || !auth.accounts.length) return c.json({ accounts: [] });
    return c.json({
      accounts: await Promise.all(
        auth.accounts.map(async (sa) => ({
          index: sa.index,
          email: sa.account.email,
          name: (await getSettings(sa.account.id)).name,
          admin: isAdmin(sa.account),
        })),
      ),
    });
  });

  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const auth = c.get("auth");
    const result = await signIn(body, body.add && auth ? auth : null, {
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400);
    if (result.cookie) setSessionCookie(c, result.cookie);
    return c.json({ index: result.index });
  });

  app.post("/api/auth/logout", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ ok: true });
    const body = await c.req.json().catch(() => ({}));
    const index = typeof body.index === "number" ? body.index : null;
    const sa = index !== null ? auth.accounts[index] : null;
    if (sa) {
      if (await signOutAccount(auth, sa.account.id)) deleteCookie(c, COOKIE_NAME, { path: "/" });
    } else {
      await signOutAll(auth);
      deleteCookie(c, COOKIE_NAME, { path: "/" });
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- per-account

  const acct = new Hono<Env>();

  acct.use("*", async (c, next) => {
    const auth = c.get("auth");
    const index = int(c.req.param("a"));
    const sa = auth?.accounts[index];
    if (!auth || !sa) return c.json({ error: "Not signed in.", reauth: true }, 401);
    const creds = credentialsFor(auth, sa);
    if (!creds) return c.json({ error: "Your session has expired. Sign in again.", reauth: true }, 401);
    c.set("sa", sa);
    c.set("creds", creds);
    c.set("rt", await runtimeFor(sa.account, creds));
    await next();
  });

  acct.get("/mailboxes", async (c) => {
    const rt = c.get("rt");
    const boxes = getMailboxes(rt.account.id).filter((m) => syncable(m) || !m.selectable);
    return c.json({
      mailboxes: boxes.map((m) => mailboxJson(m, rt.account.id)),
      labels: await listLabels(rt.account.id),
      status: { error: rt.lastError, ready: boxes.some((b) => b.synced_uidnext > 0) },
    });
  });

  acct.post("/mailboxes", async (c) => {
    const rt = c.get("rt");
    const body = await c.req.json();
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 200 || /[\x00-\x1f]/.test(name)) throw new ActionError("Enter a folder name.");
    const parent = body.parentId ? getMailbox(rt.account.id, Number(body.parentId)) : null;
    const delimiter = parent?.delimiter ?? getMailboxes(rt.account.id)[0]?.delimiter ?? "/";
    const full = parent ? `${parent.path}${delimiter}${name}` : name;
    const client = await rt.fg.get();
    await client.mailboxCreate(full);
    await client.mailboxSubscribe(full).catch(() => {});
    rt.schedule("list");
    return c.json({ path: full });
  });

  acct.patch("/mailboxes/:id", async (c) => {
    const rt = c.get("rt");
    const mb = getMailbox(rt.account.id, int(c.req.param("id")));
    if (!mb || mb.special_use) throw new ActionError("That folder can't be renamed.");
    const body = await c.req.json();
    const name = String(body.name ?? "").trim();
    if (!name) throw new ActionError("Enter a folder name.");
    const target = mb.parent_path ? `${mb.parent_path}${mb.delimiter ?? "/"}${name}` : name;
    // RENAME moves the folder's subfolders too, but not every server moves the
    // subscriptions (Dovecot leaves them on the old names), and only subscribed
    // folders are shown: carry them over, or the renamed folders vanish.
    const inside = `${mb.path}${mb.delimiter ?? "/"}`;
    const subscribed = getMailboxes(rt.account.id).filter((m) => m.subscribed && (m.path === mb.path || m.path.startsWith(inside)));
    const client = await rt.fg.get();
    await client.mailboxRename(mb.path, target);
    for (const m of subscribed) {
      await client.mailboxSubscribe(target + m.path.slice(mb.path.length)).catch(() => {});
      await client.mailboxUnsubscribe(m.path).catch(() => {});
    }
    // The renamed folder is a new mailbox to us; its contents resync under the new path.
    db().run("DELETE FROM mailboxes WHERE id = ?", mb.id);
    rt.schedule("list");
    return c.json({ path: target });
  });

  acct.delete("/mailboxes/:id", async (c) => {
    const rt = c.get("rt");
    const mb = getMailbox(rt.account.id, int(c.req.param("id")));
    if (!mb || mb.special_use) throw new ActionError("That folder can't be deleted.");
    const client = await rt.fg.get();
    await client.mailboxDelete(mb.path);
    db().run("DELETE FROM mailboxes WHERE id = ?", mb.id);
    rt.notify([]);
    return c.json({ ok: true });
  });

  function viewFrom(c: Context<Env>): View {
    const rt = c.get("rt");
    const view = parseView(rt.account.id, c.req.query("view") ?? "inbox");
    if (!view) throw new ActionError("Unknown view.");
    return view;
  }

  acct.get("/threads", async (c) => {
    const rt = c.get("rt");
    const settings = await getSettings(rt.account.id);
    const size = [25, 50, 100].includes(int(c.req.query("size"))) ? int(c.req.query("size")) : settings.pageSize;
    const page = Math.max(0, int(c.req.query("page"), 0));
    const me = await myAddresses(rt.account.id, rt.account.email);
    const q = (c.req.query("q") ?? "").trim();
    let view: View;
    if (q) {
      const parsed = parseQuery(q);
      const ids = await searchThreads(rt, q);
      const all = parsed.scope === "anywhere" || ["trash", "bin", "spam", "junk"].includes(parsed.scope ?? "");
      view = { kind: "threads", ids, includeHidden: all };
    } else {
      view = viewFrom(c);
    }
    const result = listThreads(rt.account.id, view, page, size, me);
    return c.json({ ...result, page, size });
  });

  acct.get("/threads/:id", (c) => {
    const rt = c.get("rt");
    const qView = c.req.query("view") ?? "inbox";
    const view = qView.startsWith("search") ? ({ kind: "threads", ids: [], includeHidden: true } as View) : viewFrom(c);
    const conv = conversation(rt.account.id, int(c.req.param("id")), view);
    if (!conv) return c.json({ error: "This conversation no longer exists." }, 404);
    return c.json({ id: int(c.req.param("id")), ...conv });
  });

  async function messageParts(c: Context<Env>) {
    const rt = c.get("rt");
    const mb = getMailbox(rt.account.id, int(c.req.param("mb")));
    const uid = int(c.req.param("uid"));
    if (!mb || !Number.isInteger(uid)) return null;
    const parsed = await getParsed(rt, mb, uid);
    if (!parsed) return null;
    return { rt, mb, uid, parsed };
  }

  acct.get("/messages/:mb/:uid", async (c) => {
    const found = await messageParts(c);
    if (!found) return c.json({ error: "This message no longer exists." }, 404);
    const { rt, mb, uid, parsed } = found;
    const settings = await getSettings(rt.account.id);
    const sender = parsed.from?.value[0]?.address?.toLowerCase();
    const trusted = !!sender && (await isTrustedSender(rt.account.id, sender));
    const allowRemote = settings.images === "always" || trusted || c.req.query("images") === "1";
    const a = c.req.param("a");
    const rendered = render(parsed, {
      allowRemote,
      origin: "'self'",
      cidUrl: (cid) => `/api/u/${a}/messages/${mb.id}/${uid}/cid/${encodeURIComponent(cid)}`,
    });
    return c.json({ ...rendered, imagesAllowed: allowRemote, trustedSender: trusted });
  });

  acct.get("/messages/:mb/:uid/raw", async (c) => {
    const rt = c.get("rt");
    const mb = getMailbox(rt.account.id, int(c.req.param("mb")));
    const raw = mb ? await getRaw(rt, mb, int(c.req.param("uid"))) : null;
    if (!raw) return c.json({ error: "This message no longer exists." }, 404);
    const download = c.req.query("download") === "1";
    return new Response(new Uint8Array(raw), {
      headers: {
        "Content-Type": download ? "message/rfc822" : "text/plain; charset=utf-8",
        "Content-Disposition": contentDisposition(download ? "attachment" : "inline", "message.eml"),
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  acct.get("/messages/:mb/:uid/attachments/:index", async (c) => {
    const found = await messageParts(c);
    const att = found?.parsed.attachments[int(c.req.param("index"))];
    if (!found || !att) return c.json({ error: "Attachment not found." }, 404);
    const filename = attachmentList(found.parsed, null)[int(c.req.param("index"))].filename;
    const type = att.contentType.toLowerCase();
    const inline = c.req.query("inline") === "1" && INLINE_TYPES.has(type);
    const headers: Record<string, string> = {
      "Content-Type": inline ? (type === "text/plain" ? "text/plain; charset=utf-8" : type) : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", filename),
      "Cache-Control": "private, max-age=86400",
    };
    if (type !== "application/pdf") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
    return new Response(new Uint8Array(att.content), { headers });
  });

  acct.get("/messages/:mb/:uid/cid/:cid", async (c) => {
    const found = await messageParts(c);
    const cid = decodeURIComponent(c.req.param("cid"));
    const att = found?.parsed.attachments.find((x) => x.cid?.replace(/^<|>$/g, "") === cid);
    if (!found || !att || !att.contentType.startsWith("image/") || att.contentType.includes("svg")) {
      return c.body(null, 404);
    }
    return new Response(new Uint8Array(att.content), {
      headers: { "Content-Type": att.contentType, "Cache-Control": "private, max-age=86400", "Content-Security-Policy": "sandbox; default-src 'none'" },
    });
  });

  /** What the composer needs to reopen a draft, or to forward a message with its attachments. */
  acct.get("/messages/:mb/:uid/compose", async (c) => {
    const found = await messageParts(c);
    if (!found) return c.json({ error: "This message no longer exists." }, 404);
    const { parsed, mb, uid, rt } = found;
    const list = (v: typeof parsed.to) =>
      (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.value).filter((a) => a.address).map((a) => ({ name: a.name, address: a.address!.toLowerCase() }));
    let replyTo: { mailboxId: number; uid: number } | null = null;
    if (parsed.inReplyTo) {
      const row = db().get<{ mailbox_id: number; uid: number }>(
        "SELECT mailbox_id, uid FROM messages WHERE account_id = ? AND message_id = ? LIMIT 1",
        rt.account.id,
        parsed.inReplyTo.toLowerCase(),
      );
      if (row) replyTo = { mailboxId: row.mailbox_id, uid: row.uid };
    }
    const html = editorHtml(parsed);
    return c.json({
      from: parsed.from?.value[0]?.address?.toLowerCase() ?? null,
      to: list(parsed.to),
      cc: list(parsed.cc),
      bcc: list(parsed.bcc),
      subject: parsed.subject ?? "",
      html,
      replyTo,
      attachments: attachmentList(parsed, typeof parsed.html === "string" ? parsed.html : null)
        .filter((a) => !a.inline)
        .map((a) => ({ mailboxId: mb.id, uid, index: a.index, filename: a.filename, size: a.size, contentType: a.contentType })),
    });
  });

  acct.post("/actions", async (c) => {
    const rt = c.get("rt");
    const body = await c.req.json();
    const view = parseView(rt.account.id, String(body.view ?? "inbox")) ?? ({ kind: "all" } as View);
    const input: ActionInput = {
      action: body.action,
      threads: Array.isArray(body.threads) ? body.threads.filter(Number.isInteger) : undefined,
      messages: Array.isArray(body.messages)
        ? body.messages.filter((m: { mailboxId: unknown; uid: unknown }) => Number.isInteger(m?.mailboxId) && Number.isInteger(m?.uid))
        : undefined,
      view,
      target: Number.isInteger(body.target) ? body.target : undefined,
      keyword: typeof body.keyword === "string" ? body.keyword : undefined,
    };
    return c.json(await perform(rt, input));
  });

  acct.post("/undo", async (c) => {
    const body = await c.req.json();
    const ok = await undo(c.get("rt"), String(body.token ?? ""));
    return ok ? c.json({ ok }) : c.json({ error: "That can no longer be undone." }, 410);
  });

  function composeInput(body: Record<string, unknown>): ComposeInput {
    const ref = (v: unknown) => {
      const r = v as { mailboxId?: unknown; uid?: unknown } | null;
      return r && Number.isInteger(r.mailboxId) && Number.isInteger(r.uid) ? { mailboxId: r.mailboxId as number, uid: r.uid as number } : null;
    };
    return {
      from: String(body.from ?? ""),
      to: Array.isArray(body.to) ? body.to : [],
      cc: Array.isArray(body.cc) ? body.cc : [],
      bcc: Array.isArray(body.bcc) ? body.bcc : [],
      subject: String(body.subject ?? ""),
      html: String(body.html ?? ""),
      attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 100) : [],
      replyTo: ref(body.replyTo),
      forwardOf: ref(body.forwardOf),
      draft: ref(body.draft),
      quote: (() => {
        const q = body.quote as { kind?: unknown; header?: unknown } | null;
        const r = ref(q);
        if (!r || (q?.kind !== "reply" && q?.kind !== "forward")) return null;
        return { ...r, kind: q.kind, header: String(q.header ?? "") };
      })(),
    };
  }

  acct.post("/send", async (c) => {
    const body = await c.req.json();
    return c.json(await sendMessage(c.get("rt"), c.get("auth")!.sessionHash, composeInput(body), c.get("creds")));
  });

  acct.put("/drafts", async (c) => {
    const body = await c.req.json();
    return c.json(await saveDraft(c.get("rt"), c.get("auth")!.sessionHash, composeInput(body)));
  });

  acct.delete("/drafts/:mb/:uid", async (c) => {
    await discardDraft(c.get("rt"), { mailboxId: int(c.req.param("mb")), uid: int(c.req.param("uid")) });
    return c.json({ ok: true });
  });

  acct.post("/uploads", async (c) => {
    const declared = int(c.req.header("content-length"), 0);
    if (declared > config.maxUploadBytes) {
      return c.json({ error: `Attachments can be at most ${Math.round(config.maxUploadBytes / 1048576)} MB.` }, 413);
    }
    let filename = "attachment";
    try {
      filename = decodeURIComponent(c.req.header("x-filename") ?? "attachment");
    } catch {
      // a malformed name: keep the default
    }
    const result = await saveUpload(c.get("auth")!.sessionHash, c.req.raw.body, filename, c.req.header("content-type") ?? "");
    return c.json(result);
  });

  acct.get("/contacts", (c) => c.json({ contacts: searchContacts(c.get("rt").account.id, c.req.query("q") ?? "") }));

  acct.get("/settings", async (c) => {
    const rt = c.get("rt");
    return c.json({ settings: await getSettings(rt.account.id), email: rt.account.email, password: passwordChangeFor(rt.account) });
  });

  acct.post("/password", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await changePassword(c.get("auth")!, c.get("sa"), body, { ip: clientIp(c) });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400);
    return c.json({ ok: true, signedOut: result.signedOut });
  });

  acct.put("/settings", async (c) => {
    const result = await updateSettings(c.get("rt").account.id, await c.req.json());
    if ("error" in result) return c.json(result, 400);
    return c.json({ settings: result });
  });

  acct.post("/trusted-senders", async (c) => {
    const body = await c.req.json();
    const address = String(body.address ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new ActionError("Invalid address.");
    await trustSender(c.get("rt").account.id, address);
    return c.json({ ok: true });
  });

  acct.get("/labels", async (c) => c.json({ labels: await listLabels(c.get("rt").account.id) }));

  acct.post("/labels", async (c) => {
    const body = await c.req.json();
    const label = await createLabel(c.get("rt").account.id, body.name, body.color);
    c.get("rt").notify([]);
    return c.json({ label });
  });

  acct.patch("/labels/:keyword", async (c) => {
    const label = await updateLabel(c.get("rt"), decodeURIComponent(c.req.param("keyword")), await c.req.json());
    c.get("rt").notify([]);
    return c.json({ label });
  });

  acct.delete("/labels/:keyword", async (c) => {
    await deleteLabel(c.get("rt"), decodeURIComponent(c.req.param("keyword")));
    c.get("rt").notify([]);
    return c.json({ ok: true });
  });

  app.route("/api/u/:a", acct);

  // ---------------------------------------------------------------- admin

  // For the first account in the session that isAdmin() accepts. Its password is
  // re-proven every ten minutes, so admin rights end soon after the password changes or
  // the mailbox goes away; an unreachable mail server doesn't lock admins out.
  const admin = new Hono<Env>();

  admin.use("*", async (c, next) => {
    const auth = c.get("auth");
    for (const sa of auth?.accounts ?? []) {
      if (!isAdmin(sa.account)) continue;
      const creds = credentialsFor(auth!, sa);
      if (!creds) continue;
      if ((await stillProven(sa.account, creds)) === false) {
        return c.json({ error: "The mail server rejected your saved password. Sign in again.", reauth: true }, 401);
      }
      c.set("sa", sa);
      return next();
    }
    return c.json({ error: "Only admins can open this page." }, 403);
  });

  admin.get("/", async (c) =>
    c.json({
      you: c.get("sa").account.login,
      settings: await describeSettings(),
      changes: await recentChanges(),
      server: serverFacts(),
    }),
  );

  admin.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ActionError("Send the settings to change.");
    if ("admins" in body) {
      // Removing the last admin from here would lock everyone out of this page.
      const parsed = body.admins === null ? { value: [] } : parseSetting(settingDef("admins")!, body.admins);
      if (!("error" in parsed) && !(parsed.value as string[]).length) {
        throw new ActionError("Keep at least one admin. The command line can remove the last one.");
      }
    }
    const result = await changeSettings(body, c.get("sa").account.login);
    if ("error" in result) return c.json(result, 400);
    return c.json({ changed: result.changed, settings: await describeSettings(), changes: await recentChanges() });
  });

  app.route("/api/admin", admin);

  // ---------------------------------------------------------------- live updates

  app.get("/api/events", async (c) => {
    const auth = c.get("auth");
    if (!auth?.accounts.length) return c.json({ error: "Not signed in." }, 401);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      type Sub = { rt: AccountRuntime; listener: (e: ChangeEvent) => void; onAuth: () => void };
      const subs = new Map<number, Sub>();
      const unsubscribe = (accountId: number) => {
        const s = subs.get(accountId);
        if (!s) return;
        subs.delete(accountId);
        s.rt.off("change", s.listener);
        s.rt.off("auth-failed", s.onAuth);
        s.rt.subscribers = Math.max(0, s.rt.subscribers - 1);
        s.rt.touch();
      };
      const closeAll = () => [...subs.keys()].forEach(unsubscribe);
      // Registered before any await, so a client that drops early never leaks a subscriber.
      stream.onAbort(closeAll);
      // Signing out (in any tab) or the session expiring ends the feed for that account
      // at once, so subjects of new mail stop flowing to a signed-out page.
      const stillSignedIn = (accountId: number) => isSignedIn(auth.sessionHash, accountId).catch(() => false);

      for (const sa of auth.accounts) {
        if (stream.aborted) break;
        const creds = credentialsFor(auth, sa);
        if (!creds) {
          await stream.writeSSE({ event: "reauth", data: JSON.stringify({ index: sa.index }) });
          continue;
        }
        try {
          const rt = await runtimeFor(sa.account, creds);
          if (stream.aborted) break;
          const id = sa.account.id;
          const listener = (e: ChangeEvent) => {
            void stillSignedIn(id).then((ok) => {
              if (!ok) return unsubscribe(id);
              if (!stream.aborted) void stream.writeSSE({ event: "change", data: JSON.stringify({ index: sa.index, mailboxIds: e.mailboxIds, arrived: e.arrived }) });
            });
          };
          const onAuth = () => void stream.writeSSE({ event: "reauth", data: JSON.stringify({ index: sa.index }) });
          rt.on("change", listener);
          rt.on("auth-failed", onAuth);
          rt.subscribers++;
          subs.set(id, { rt, listener, onAuth });
        } catch (err) {
          if (err instanceof MailboxAuthError) await stream.writeSSE({ event: "reauth", data: JSON.stringify({ index: sa.index }) });
        }
      }
      if (stream.aborted) return closeAll();
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        for (const id of [...subs.keys()]) if (!(await stillSignedIn(id))) unsubscribe(id);
        if (!subs.size) break;
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
      closeAll();
    });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  // ---------------------------------------------------------------- the web app

  const webRoot = path.resolve(process.env.WEB_ROOT ?? path.join(import.meta.dirname, "..", "web"));
  const indexFile = path.join(webRoot, "index.html");
  app.use(
    "/assets/*",
    serveStatic({
      root: path.relative(process.cwd(), webRoot),
      onFound: (_p, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use("*", serveStatic({ root: path.relative(process.cwd(), webRoot), index: "__none__" }));
  app.get("*", (c) => {
    if (!fs.existsSync(indexFile)) return c.text("Web app not built. Run `npm run build`, or use `npm run dev`.", 503);
    c.header("Cache-Control", "no-cache");
    return c.html(fs.readFileSync(indexFile, "utf8"));
  });

  return app;
}

