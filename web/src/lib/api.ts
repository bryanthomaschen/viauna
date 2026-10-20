import type {
  ActionName,
  AdminChange,
  AdminData,
  AdminSetting,
  AppConfig,
  Conversation,
  MailboxesResponse,
  MessageRef,
  PasswordChange,
  RenderedMessage,
  SessionAccount,
  SettingValue,
  Settings,
  ThreadsResponse,
  Label,
  Address,
} from "./types";

export class ApiError extends Error {
  status: number;
  reauth: boolean;
  constructor(message: string, status: number, reauth: boolean) {
    super(message);
    this.status = status;
    this.reauth = reauth;
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers }, credentials: "same-origin" };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("You're offline, or the server isn't reachable.", 0, false);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data as { error?: string; reauth?: boolean } | null;
    throw new ApiError(d?.error || `Request failed (${res.status})`, res.status, !!d?.reauth);
  }
  return data as T;
}

const u = (a: number) => `/api/u/${a}`;

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  session: () => request<{ accounts: SessionAccount[] }>("GET", "/api/session"),
  login: (body: { email: string; password: string; username?: string; add?: boolean; imap?: unknown; smtp?: unknown }) =>
    request<{ index: number }>("POST", "/api/auth/login", body),
  logout: (index?: number) => request<{ ok: true }>("POST", "/api/auth/logout", index === undefined ? {} : { index }),

  mailboxes: (a: number) => request<MailboxesResponse>("GET", `${u(a)}/mailboxes`),
  createMailbox: (a: number, name: string, parentId?: number) => request("POST", `${u(a)}/mailboxes`, { name, parentId }),
  renameMailbox: (a: number, id: number, name: string) => request("PATCH", `${u(a)}/mailboxes/${id}`, { name }),
  deleteMailbox: (a: number, id: number) => request("DELETE", `${u(a)}/mailboxes/${id}`),

  threads: (a: number, view: string, page: number, q?: string) => {
    const params = new URLSearchParams({ view, page: String(page) });
    if (q) params.set("q", q);
    return request<ThreadsResponse>("GET", `${u(a)}/threads?${params}`);
  },
  thread: (a: number, id: number, view: string) =>
    request<Conversation>("GET", `${u(a)}/threads/${id}?view=${encodeURIComponent(view)}`),
  message: (a: number, ref: MessageRef, images: boolean) =>
    request<RenderedMessage>("GET", `${u(a)}/messages/${ref.mailboxId}/${ref.uid}${images ? "?images=1" : ""}`),
  composeData: (a: number, ref: MessageRef) =>
    request<{
      from: string | null;
      to: Address[];
      cc: Address[];
      bcc: Address[];
      subject: string;
      html: string;
      replyTo: MessageRef | null;
      attachments: { mailboxId: number; uid: number; index: number; filename: string; size: number; contentType: string }[];
    }>("GET", `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/compose`),

  action: (
    a: number,
    body: { action: ActionName; view: string; threads?: number[]; messages?: MessageRef[]; target?: number; keyword?: string },
  ) => request<{ undo?: string; count: number }>("POST", `${u(a)}/actions`, body),
  undo: (a: number, token: string) => request<{ ok: true }>("POST", `${u(a)}/undo`, { token }),

  send: (a: number, body: unknown) =>
    request<{ messageId: string; threadId?: number; warnings: string[] }>("POST", `${u(a)}/send`, body),
  saveDraft: (a: number, body: unknown) =>
    request<{
      draft: MessageRef | null;
      attachments: { mailboxId: number; uid: number; index: number; filename: string; size: number; contentType: string }[] | null;
    }>("PUT", `${u(a)}/drafts`, body),
  discardDraft: (a: number, ref: MessageRef) => request("DELETE", `${u(a)}/drafts/${ref.mailboxId}/${ref.uid}`),
  upload: (a: number, file: File) =>
    request<{ id: string; filename: string; size: number; contentType: string }>("POST", `${u(a)}/uploads`, file, {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    }),

  contacts: (a: number, q: string) =>
    request<{ contacts: { address: string; name: string | null }[] }>("GET", `${u(a)}/contacts?q=${encodeURIComponent(q)}`),
  settings: (a: number) => request<{ settings: Settings; email: string; password: PasswordChange | null }>("GET", `${u(a)}/settings`),
  changePassword: (a: number, current: string, next: string) =>
    request<{ ok: true; signedOut: number }>("POST", `${u(a)}/password`, { current, next }),
  saveSettings: (a: number, patch: Partial<Settings>) => request<{ settings: Settings }>("PUT", `${u(a)}/settings`, patch),
  trustSender: (a: number, address: string) => request("POST", `${u(a)}/trusted-senders`, { address }),

  createLabel: (a: number, name: string, color?: string | null) => request<{ label: Label }>("POST", `${u(a)}/labels`, { name, color }),
  updateLabel: (a: number, keyword: string, patch: { name?: string; color?: string | null }) =>
    request<{ label: Label }>("PATCH", `${u(a)}/labels/${encodeURIComponent(keyword)}`, patch),
  deleteLabel: (a: number, keyword: string) => request("DELETE", `${u(a)}/labels/${encodeURIComponent(keyword)}`),

  admin: () => request<AdminData>("GET", "/api/admin"),
  saveAdmin: (patch: Record<string, SettingValue | null>) =>
    request<{ changed: string[]; settings: AdminSetting[]; changes: AdminChange[] }>("PUT", "/api/admin/settings", patch),

  attachmentUrl: (a: number, ref: MessageRef, index: number, inline = false) =>
    `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/attachments/${index}${inline ? "?inline=1" : ""}`,
  rawUrl: (a: number, ref: MessageRef, download = false) =>
    `${u(a)}/messages/${ref.mailboxId}/${ref.uid}/raw${download ? "?download=1" : ""}`,
};
