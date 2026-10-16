import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { Endpoint } from "../config.ts";
import { config } from "../config.ts";
import type { Credentials } from "../crypto.ts";
import { log } from "../log.ts";

export function imapOptions(endpoint: Endpoint, creds: Credentials, extra: Partial<ImapFlowOptions> = {}): ImapFlowOptions {
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.security === "tls",
    // Never fall back to cleartext silently: "starttls" means STARTTLS or fail.
    doSTARTTLS: endpoint.security === "starttls" ? true : endpoint.security === "none" ? false : undefined,
    servername: endpoint.servername,
    tls: { rejectUnauthorized: endpoint.verify, servername: endpoint.servername },
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    clientInfo: { name: config.appName, vendor: "Wren" },
    connectionTimeout: 30_000,
    greetingTimeout: 16_000,
    ...extra,
  };
}

export type LoginResult = { ok: true } | { ok: false; reason: "auth" | "connect"; message: string };

export function isAuthError(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string; code?: string };
  return !!(
    e?.authenticationFailed ||
    e?.serverResponseCode === "AUTHENTICATIONFAILED" ||
    e?.code === "AUTHENTICATIONFAILED" ||
    /authenticat/i.test(e?.responseText ?? "")
  );
}

/** Logs in and out again. Used at sign-in and to re-check a session's password. */
export async function verifyLogin(endpoint: Endpoint, creds: Credentials): Promise<LoginResult> {
  const client = new ImapFlow(imapOptions(endpoint, creds, { verifyOnly: true, disableAutoIdle: true }));
  client.on("error", () => {});
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    if (isAuthError(err)) return { ok: false, reason: "auth", message: "Wrong email or password." };
    const message = (err as Error)?.message || "Could not reach the mail server.";
    log.warn("imap verify failed", { host: endpoint.host, error: message });
    return { ok: false, reason: "connect", message: `Could not connect to the mail server (${message}).` };
  } finally {
    client.close();
  }
}

/**
 * One lazily-opened IMAP connection that reopens itself after the server drops it.
 * Concurrent callers share the same connect attempt.
 */
export class Connection {
  private client: ImapFlow | null = null;
  private opening: Promise<ImapFlow> | null = null;
  onOpen?: (client: ImapFlow) => void;
  onClose?: () => void;
  onAuthFailure?: () => void;

  private readonly label: string;
  private readonly options: () => ImapFlowOptions;

  constructor(label: string, options: () => ImapFlowOptions) {
    this.label = label;
    this.options = options;
  }

  get current(): ImapFlow | null {
    return this.client?.usable ? this.client : null;
  }

  async get(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (!this.opening) {
      this.opening = this.open().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async open(): Promise<ImapFlow> {
    const client = new ImapFlow(this.options());
    client.on("error", (err: Error) => log.debug("imap connection error", { conn: this.label, error: err.message }));
    client.on("close", () => {
      if (this.client === client) {
        this.client = null;
        this.onClose?.();
      }
    });
    try {
      await client.connect();
    } catch (err) {
      client.close();
      if (isAuthError(err)) this.onAuthFailure?.();
      throw err;
    }
    this.client = client;
    this.onOpen?.(client);
    return client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await Promise.race([client.logout(), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // already gone
    } finally {
      client.close();
    }
  }
}
