// Asking a mail server whether it would send as an address, without sending anything: sign
// in, name the address as the sender and a recipient, take its answer, then RSET and QUIT.
// Servers that check which addresses a login may send as (Postfix with
// smtpd_sender_login_maps, as Mailu and mailcow set it up) refuse one it doesn't own here;
// others say yes, or refuse only once the message itself is sent, so a yes proves nothing.
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import type { Endpoint } from "../config.ts";
import type { Credentials } from "../crypto.ts";
import { connectTarget } from "../netpolicy.ts";

const TIMEOUT_MS = 20_000;

/** Refused: with the server's own words, and whether it said so for good (5xx) or for now (4xx). */
export type ProbeResult = { accepted: true } | { accepted: false; permanent: boolean; reply: string };

/** The server couldn't be asked: not reached, no TLS, or the password wasn't accepted. */
export class ProbeError extends Error {
  auth: boolean;
  constructor(message: string, auth = false) {
    super(message);
    this.auth = auth;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class Connection {
  private buf = "";
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.listen(socket);
  }

  listen(socket: net.Socket) {
    this.socket = socket;
    socket.setTimeout(TIMEOUT_MS);
    socket.on("data", (d: Buffer) => {
      this.buf += d.toString("latin1");
      this.deliver();
    });
    socket.on("timeout", () => this.fail(new ProbeError("The mail server stopped answering.")));
    socket.on("error", (e) => this.fail(new ProbeError(`Couldn't reach the mail server (${e.message}).`)));
    socket.on("close", () => this.fail(new ProbeError("The mail server closed the connection.")));
  }

  /** Stops listening on the plain socket, before TLS takes it over. */
  release() {
    this.socket.removeAllListeners("data").removeAllListeners("timeout").removeAllListeners("error").removeAllListeners("close");
    this.socket.on("error", () => {}); // the TLS socket reports it
  }

  private fail(err: Error) {
    this.failure ??= err;
    this.waiting?.reject(err);
    this.waiting = null;
    this.socket.destroy();
  }

  /** One whole reply ("250-…" lines, then "250 …"), once it's all here. */
  private deliver() {
    if (!this.waiting) return;
    const lines: string[] = [];
    let pos = 0;
    for (;;) {
      const end = this.buf.indexOf("\r\n", pos);
      if (end < 0) return;
      const line = this.buf.slice(pos, end);
      pos = end + 2;
      lines.push(line.slice(4));
      if (!/^\d{3}-/.test(line)) {
        this.buf = this.buf.slice(pos);
        const w = this.waiting;
        this.waiting = null;
        const code = Number(line.slice(0, 3));
        if (!Number.isInteger(code)) return w.reject(new ProbeError("The mail server sent something unreadable."));
        return w.resolve({ code, lines });
      }
    }
  }

  next(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.deliver();
    });
  }

  send(text: string): Promise<Reply> {
    const reply = this.next();
    this.socket.write(`${text}\r\n`);
    return reply;
  }
}

const words = (r: Reply) => `${r.code} ${r.lines.join(" ").trim()}`.trim();

/** Asks `endpoint`, signed in with `creds`, whether it takes `from` as the sender of a message to `to`. */
export async function probeSender(endpoint: Endpoint, creds: Credentials, from: string, to: string): Promise<ProbeResult> {
  let target: { host: string; servername?: string };
  try {
    target = await connectTarget(endpoint);
  } catch (err) {
    throw new ProbeError((err as Error).message);
  }
  const tlsOptions = { servername: target.servername ?? (net.isIP(endpoint.host) ? undefined : endpoint.host), rejectUnauthorized: endpoint.verify };
  const socket = endpoint.security === "tls" ? tls.connect({ host: target.host, port: endpoint.port, ...tlsOptions }) : net.connect({ host: target.host, port: endpoint.port });
  const c = new Connection(socket);
  const name = os.hostname() || "localhost";
  try {
    const greeting = await c.next();
    if (greeting.code !== 220) throw new ProbeError(`The mail server turned the connection away: ${words(greeting)}`);
    let ehlo = await c.send(`EHLO ${name}`);
    if (ehlo.code !== 250) throw new ProbeError(`The mail server didn't take EHLO: ${words(ehlo)}`);
    if (endpoint.security === "starttls") {
      // Never fall back to sending the password in the clear.
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new ProbeError("The mail server doesn't offer STARTTLS.");
      const go = await c.send("STARTTLS");
      if (go.code !== 220) throw new ProbeError(`The mail server didn't start TLS: ${words(go)}`);
      c.release();
      const secure = tls.connect({ socket, ...tlsOptions });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", resolve);
        secure.once("error", (e) => reject(new ProbeError(`The mail server's certificate wasn't accepted (${e.message}).`)));
      });
      c.listen(secure);
      ehlo = await c.send(`EHLO ${name}`);
      if (ehlo.code !== 250) throw new ProbeError(`The mail server didn't take EHLO: ${words(ehlo)}`);
    }
    const mechanisms = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))?.slice(5).toUpperCase().split(/\s+/) ?? [];
    let auth: Reply;
    if (mechanisms.includes("PLAIN")) {
      auth = await c.send(`AUTH PLAIN ${Buffer.from(`\0${creds.user}\0${creds.pass}`, "utf8").toString("base64")}`);
    } else if (mechanisms.includes("LOGIN")) {
      auth = await c.send("AUTH LOGIN");
      if (auth.code === 334) auth = await c.send(Buffer.from(creds.user, "utf8").toString("base64"));
      if (auth.code === 334) auth = await c.send(Buffer.from(creds.pass, "utf8").toString("base64"));
    } else {
      throw new ProbeError("The mail server doesn't take a password sign-in.");
    }
    if (auth.code !== 235) throw new ProbeError(`The mail server didn't accept the password: ${words(auth)}`, true);
    for (const command of [`MAIL FROM:<${from}>`, `RCPT TO:<${to}>`]) {
      const r = await c.send(command);
      if (r.code >= 400) return { accepted: false, permanent: r.code >= 500, reply: words(r) };
      if (r.code >= 300) throw new ProbeError(`The mail server answered oddly: ${words(r)}`);
    }
    await c.send("RSET").catch(() => {});
    await c.send("QUIT").catch(() => {});
    return { accepted: true };
  } finally {
    c.socket.destroy();
  }
}
