// Compose windows: Gmail-style popups docked bottom-right, or a reply inline in the
// conversation. Drafts autosave to the server's Drafts folder a moment after typing
// stops, and on close.
import { api, ApiError } from "./api";
import { formatAddress, forwardSubject, longDate, replySubject } from "./format";
import { createStore, toast } from "./store";
import type { Address, Conversation, Identity, MessageMeta, MessageRef } from "./types";

export interface ComposeAttachment {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  upload?: string;
  source?: { mailboxId: number; uid: number; index: number };
  uploading?: boolean;
}

export interface ComposeState {
  id: number;
  account: number;
  mode: "new" | "reply" | "replyAll" | "forward" | "draft";
  placement: "dock" | "inline";
  threadId?: number;
  minimized: boolean;
  maximized: boolean;
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  html: string;
  /** Editor's starting content; changing it re-initialises the editor. */
  initialHtml: string;
  attachments: ComposeAttachment[];
  replyTo: MessageRef | null;
  forwardOf: MessageRef | null;
  quote: { ref: MessageRef; kind: "reply" | "forward"; header: string } | null;
  draft: MessageRef | null;
  status: "idle" | "saving" | "saved" | "sending" | "error";
  error?: string;
  dirty: boolean;
  /** Closed or discarded, finishing its last save in the background. */
  hidden?: boolean;
}

let nextId = 1;
export const composes = createStore<ComposeState[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const saving = new Map<number, Promise<void>>();
/** Set synchronously when a send starts, so a double Ctrl+Enter can't send twice. */
const sending = new Set<number>();

function blank(account: number, from: string): ComposeState {
  return {
    id: nextId++,
    account,
    mode: "new",
    placement: "dock",
    minimized: false,
    maximized: false,
    from,
    to: [],
    cc: [],
    bcc: [],
    showCc: false,
    showBcc: false,
    subject: "",
    html: "",
    initialHtml: "",
    attachments: [],
    replyTo: null,
    forwardOf: null,
    quote: null,
    draft: null,
    status: "idle",
    dirty: false,
  };
}

export function get(id: number): ComposeState | undefined {
  return composes.get().find((c) => c.id === id);
}

function signatureHtml(signature: string): string {
  return signature.trim() ? `<p></p><div class="viauna-signature">-- <br>${signature}</div>` : "";
}

export function openCompose(account: number, identity: Identity, signature: string, init: Partial<ComposeState> = {}) {
  const state: ComposeState = { ...blank(account, identity.address), ...init };
  if (!init.initialHtml && init.mode !== "draft") {
    state.initialHtml = signatureHtml(signature);
    state.html = state.initialHtml;
  }
  // One inline reply per conversation: an unsent one being replaced (Reply, then
  // Forward) is kept as a draft rather than dropped.
  if (state.placement === "inline") {
    for (const c of composes.get()) {
      if (c.placement === "inline" && c.threadId === state.threadId && !c.hidden) void close(c.id);
    }
  }
  // Gmail keeps at most a few windows open; minimise the others.
  composes.set((list) => {
    const docked = list.filter((c) => c.placement === "dock" && !c.hidden);
    const others = docked.length >= 3 ? list.map((c) => (c.placement === "dock" ? { ...c, minimized: true } : c)) : list;
    return [...others, state];
  });
  return state.id;
}

export function update(id: number, patch: Partial<ComposeState>, content = true) {
  composes.set((list) => list.map((c) => (c.id === id ? { ...c, ...patch, ...(content ? { dirty: true, status: c.status === "sending" ? c.status : "idle" } : {}) } : c)));
  if (content) scheduleSave(id);
}

function payload(c: ComposeState) {
  return {
    from: c.from,
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    html: c.html,
    attachments: c.attachments
      .filter((a) => !a.uploading)
      .map((a) => (a.upload ? { upload: a.upload } : a.source)),
    replyTo: c.replyTo,
    forwardOf: c.forwardOf,
    draft: c.draft,
    quote: c.quote ? { ...c.quote.ref, kind: c.quote.kind, header: c.quote.header } : null,
  };
}

function scheduleSave(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.set(id, setTimeout(() => void saveDraft(id), 2500));
}

export async function saveDraft(id: number): Promise<void> {
  const pending = saving.get(id);
  if (pending) await pending;
  const c = get(id);
  if (!c || !c.dirty || c.status === "sending" || sending.has(id)) return;
  const empty = !c.to.length && !c.cc.length && !c.bcc.length && !c.subject.trim() && !c.html.replace(/<[^>]+>/g, "").trim() && !c.attachments.length;
  if (empty && !c.draft) return;
  const run = (async () => {
    update(id, { status: "saving" }, false);
    try {
      const sentList = c.attachments.filter((a) => !a.uploading);
      const sentKeys = new Set(sentList.map((a) => a.key));
      const res = await api.saveDraft(c.account, payload(c));
      const now = get(id);
      const patch: Partial<ComposeState> = {
        draft: res.draft,
        status: "saved",
        // Content changed while saving: stay dirty, the next timer saves again.
        dirty: !!now && (now.html !== c.html || now.subject !== c.subject || now.to !== c.to || now.attachments.length !== c.attachments.length),
      };
      if (now && res.attachments) {
        const stillThere = new Set(now.attachments.map((a) => a.key));
        const saved = res.attachments
          // Removed by the user while the save was in flight.
          .filter((_, i) => !sentList[i] || stillThere.has(sentList[i].key))
          .map((a) => ({
          key: `d${a.uid}-${a.index}`,
          filename: a.filename,
          size: a.size,
          contentType: a.contentType,
          source: { mailboxId: a.mailboxId, uid: a.uid, index: a.index },
        }));
        // Attachments still uploading, or added during the save, weren't in that draft.
        patch.attachments = [...saved, ...now.attachments.filter((a) => !sentKeys.has(a.key))];
      }
      update(id, patch, false);
    } catch (err) {
      update(id, { status: "error", error: (err as Error).message }, false);
    } finally {
      saving.delete(id);
    }
  })();
  saving.set(id, run);
  await run;
}

export function remove(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  composes.set((list) => list.filter((c) => c.id !== id));
}

/**
 * Close: keep what was written as a draft (Gmail's X). The window disappears at
 * once, but stays in the store until any save in flight has finished and the last
 * edits are saved on top of it — saving from a stale copy would duplicate the draft,
 * or lose attachments the in-flight save had just moved.
 */
export async function close(id: number) {
  if (!get(id)) return;
  clearTimeout(timers.get(id));
  update(id, { hidden: true }, false);
  await saving.get(id);
  const wasDirty = !!get(id)?.dirty;
  await saveDraft(id);
  const after = get(id);
  remove(id);
  if (after?.status === "error") toast(`Couldn't save the draft: ${after.error}`, { error: true });
  else if (wasDirty && after?.draft) toast("Draft saved");
}

export async function discard(id: number) {
  const c = get(id);
  if (!c) return;
  clearTimeout(timers.get(id));
  update(id, { hidden: true }, false);
  // A save in flight may be creating a newer draft; discard that one, not the old.
  await saving.get(id);
  const draft = get(id)?.draft ?? c.draft;
  remove(id);
  if (draft) {
    try {
      await api.discardDraft(c.account, draft);
    } catch {
      // already gone
    }
  }
  toast("Draft discarded");
}

export async function send(id: number, onSent?: (threadId?: number) => void): Promise<boolean> {
  const c = get(id);
  if (!c || sending.has(id) || c.status === "sending") return false;
  if (!c.to.length && !c.cc.length && !c.bcc.length) {
    toast("Please specify at least one recipient.", { error: true });
    return false;
  }
  if (c.attachments.some((a) => a.uploading)) {
    toast("Wait for attachments to finish uploading.", { error: true });
    return false;
  }
  if (!c.subject.trim() && !confirm("Send this message without a subject?")) return false;
  sending.add(id);
  clearTimeout(timers.get(id));
  update(id, { status: "sending" }, false);
  await saving.get(id);
  const latest = get(id)!;
  try {
    const res = await api.send(latest.account, payload(latest));
    remove(id);
    toast("Message sent", res.threadId && onSent ? { action: { label: "View message", run: () => onSent(res.threadId) } } : {});
    for (const w of res.warnings) toast(w, { error: true });
    return true;
  } catch (err) {
    update(id, { status: "error", error: (err as Error).message }, false);
    toast((err as Error).message, { error: true, ms: 10000 });
    if (err instanceof ApiError && err.reauth) location.reload();
    return false;
  } finally {
    sending.delete(id);
  }
}

export async function addFiles(id: number, files: File[]) {
  const c = get(id);
  if (!c) return;
  for (const file of files) {
    const key = `${Date.now()}-${Math.random()}`;
    update(id, {
      attachments: [...(get(id)?.attachments ?? []), { key, filename: file.name, size: file.size, contentType: file.type, uploading: true }],
    });
    api
      .upload(c.account, file)
      .then((res) => {
        const now = get(id);
        if (!now) return;
        update(id, { attachments: now.attachments.map((a) => (a.key === key ? { ...a, upload: res.id, uploading: false } : a)) });
      })
      .catch((err) => {
        const now = get(id);
        if (now) update(id, { attachments: now.attachments.filter((a) => a.key !== key) });
        toast(`${file.name}: ${(err as Error).message}`, { error: true });
      });
  }
}

// ---------------------------------------------------------------- starting points

function uniq(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.address.toLowerCase();
    if (exclude.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Which of my identities the original was sent to, so replies go out from it. */
function pickIdentity(msg: MessageMeta, identities: Identity[]): Identity {
  const to = new Set([...msg.to, ...msg.cc].map((a) => a.address.toLowerCase()));
  return identities.find((i) => to.has(i.address.toLowerCase())) ?? identities[0];
}

export function startReply(
  account: number,
  conv: Conversation,
  msg: MessageMeta,
  mode: "reply" | "replyAll",
  identities: Identity[],
  signature: string,
) {
  const mine = new Set(identities.map((i) => i.address.toLowerCase()));
  const fromMe = msg.from.some((a) => mine.has(a.address.toLowerCase()));
  const primary = fromMe ? msg.to : msg.replyTo.length ? msg.replyTo : msg.from;
  const to = uniq(primary, fromMe ? new Set() : mine);
  const cc = mode === "replyAll" ? uniq([...(fromMe ? [] : msg.to), ...msg.cc], new Set([...mine, ...to.map((a) => a.address)])) : [];
  const from = msg.from[0];
  return openCompose(account, pickIdentity(msg, identities), signature, {
    mode,
    placement: "inline",
    threadId: conv.id,
    from: pickIdentity(msg, identities).address,
    to,
    cc,
    showCc: cc.length > 0,
    subject: replySubject(msg.subject || conv.subject),
    replyTo: { mailboxId: msg.mailboxId, uid: msg.uid },
    quote: {
      ref: { mailboxId: msg.mailboxId, uid: msg.uid },
      kind: "reply",
      header: `On ${longDate(msg.date)}, ${from ? formatAddress(from) : "someone"} wrote:`,
    },
  });
}

export async function startForward(account: number, conv: Conversation, msg: MessageMeta, identities: Identity[], signature: string) {
  const ref = { mailboxId: msg.mailboxId, uid: msg.uid };
  const header = [
    "---------- Forwarded message ---------",
    `From: ${msg.from.map(formatAddress).join(", ")}`,
    `Date: ${longDate(msg.date)}`,
    `Subject: ${msg.subject}`,
    `To: ${msg.to.map(formatAddress).join(", ")}`,
    ...(msg.cc.length ? [`Cc: ${msg.cc.map(formatAddress).join(", ")}`] : []),
  ].join("\n");
  const id = openCompose(account, pickIdentity(msg, identities), signature, {
    mode: "forward",
    placement: "inline",
    threadId: conv.id,
    from: pickIdentity(msg, identities).address,
    subject: forwardSubject(msg.subject || conv.subject),
    forwardOf: ref,
    quote: { ref, kind: "forward", header },
  });
  if (msg.attachments > 0) {
    try {
      const data = await api.composeData(account, ref);
      const c = get(id);
      if (c) {
        update(
          id,
          {
            attachments: data.attachments.map((a) => ({
              key: `src-${a.index}`,
              filename: a.filename,
              size: a.size,
              contentType: a.contentType,
              source: { mailboxId: a.mailboxId, uid: a.uid, index: a.index },
            })),
          },
          false,
        );
      }
    } catch (err) {
      toast(`Couldn't attach the original's files: ${(err as Error).message}`, { error: true });
    }
  }
  return id;
}

/** Reopen a saved draft in a compose window. */
export async function openDraft(account: number, ref: MessageRef, identities: Identity[]) {
  const existing = composes.get().find((c) => c.draft && c.draft.mailboxId === ref.mailboxId && c.draft.uid === ref.uid);
  if (existing) {
    update(existing.id, { minimized: false }, false);
    return existing.id;
  }
  const data = await api.composeData(account, ref);
  const identity = identities.find((i) => i.address === data.from) ?? identities[0];
  return openCompose(account, identity, "", {
    mode: "draft",
    from: identity.address,
    to: data.to,
    cc: data.cc,
    bcc: data.bcc,
    showCc: data.cc.length > 0,
    showBcc: data.bcc.length > 0,
    subject: data.subject,
    html: data.html,
    initialHtml: data.html,
    replyTo: data.replyTo,
    draft: ref,
    attachments: data.attachments.map((a) => ({
      key: `src-${a.index}`,
      filename: a.filename,
      size: a.size,
      contentType: a.contentType,
      source: { mailboxId: a.mailboxId, uid: a.uid, index: a.index },
    })),
  });
}

/** Moves an inline reply into a docked window ("pop out"). */
export function popOut(id: number) {
  update(id, { placement: "dock", minimized: false }, false);
}
