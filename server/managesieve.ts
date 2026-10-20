// A ManageSieve client (RFC 5804): reading and saving a mailbox's Sieve scripts on its
// mail server, as filters and the vacation responder need. One connection per use:
// connect, STARTTLS, sign in with the mailbox's own login, do the work, log out.
import net from "node:net";
import tls from "node:tls";
import type { Endpoint } from "./config.ts";
import type { Credentials } from "./crypto.ts";

const TIMEOUT_MS = 15_000;

export class SieveError extends Error {
  /** The response code, if the server gave one (QUOTA, NONEXISTENT, …). */
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

type Token = { t: "atom" | "string"; v: string } | { t: "(" } | { t: ")" };

interface Response {
  lines: Token[][];
  status: "OK" | "NO" | "BYE";
  code: string | null;
  message: string | null;
}

const CRLF = Buffer.from("\r\n");

/**
 * One whole response from the start of buf, or null if more is needed: data lines
 * (atoms, quoted strings, literals {n} / {n+}), then OK, NO or BYE with an optional
 * (code) and message.
 */
export function parseResponse(buf: Buffer): { response: Response; length: number } | null {
  let pos = 0;
  const lines: Token[][] = [];
  for (;;) {
    const tokens: Token[] = [];
    for (;;) {
      if (pos >= buf.length) return null;
      const c = buf[pos];
      if (c === 0x20) {
        pos++;
      } else if (c === 0x0d) {
        if (pos + 1 >= buf.length) return null;
        pos += 2;
        break;
      } else if (c === 0x28 || c === 0x29) {
        tokens.push({ t: c === 0x28 ? "(" : ")" });
        pos++;
      } else if (c === 0x22) {
        const bytes: number[] = [];
        let i = pos + 1;
        for (;;) {
          if (i >= buf.length) return null;
          if (buf[i] === 0x5c && i + 1 < buf.length) {
            bytes.push(buf[i + 1]);
            i += 2;
          } else if (buf[i] === 0x22) break;
          else bytes.push(buf[i++]);
        }
        tokens.push({ t: "string", v: Buffer.from(bytes).toString("utf8") });
        pos = i + 1;
      } else if (c === 0x7b) {
        const end = buf.indexOf(CRLF, pos);
        if (end < 0) return null;
        const n = Number(/^\{(\d+)\+?\}$/.exec(buf.subarray(pos, end).toString("latin1"))?.[1]);
        if (!Number.isFinite(n)) throw new SieveError("The mail server's filter service sent something unreadable.");
        if (end + 2 + n > buf.length) return null;
        tokens.push({ t: "string", v: buf.subarray(end + 2, end + 2 + n).toString("utf8") });
        pos = end + 2 + n;
      } else {
        let i = pos;
        while (i < buf.length && ![0x20, 0x0d, 0x28, 0x29].includes(buf[i])) i++;
        if (i >= buf.length) return null;
        tokens.push({ t: "atom", v: buf.subarray(pos, i).toString("latin1") });
        pos = i;
      }
    }
    const first = tokens[0];
    if (first?.t === "atom" && ["OK", "NO", "BYE"].includes(first.v.toUpperCase())) {
      let i = 1;
      let code: string | null = null;
      if (tokens[i]?.t === "(") {
        const parts: string[] = [];
        for (i++; i < tokens.length && tokens[i].t !== ")"; i++) parts.push((tokens[i] as { v: string }).v);
        code = parts.join(" ");
        i++;
      }
      const msg = tokens[i];
      return {
        response: { lines, status: first.v.toUpperCase() as Response["status"], code, message: msg && "v" in msg ? msg.v : null },
        length: pos,
      };
    }
    lines.push(tokens);
  }
}

export interface SieveCapabilities {
  implementation: string;
  /** Sieve extensions the server supports. */
  extensions: Set<string>;
  starttls: boolean;
  sasl: string[];
  maxRedirects: number | null;
}

function capabilities(lines: Token[][]): SieveCapabilities {
  const get = (name: string) => lines.find((l) => (l[0] as { v?: string })?.v?.toUpperCase() === name);
  const value = (name: string) => ((get(name)?.[1] as { v?: string }) ?? {}).v ?? "";
  return {
    implementation: value("IMPLEMENTATION"),
    extensions: new Set(value("SIEVE").split(/\s+/).filter(Boolean)),
    starttls: !!get("STARTTLS"),
    sasl: value("SASL").split(/\s+/).filter(Boolean).map((m) => m.toUpperCase()),
    maxRedirects: get("MAXREDIRECTS") ? Number(value("MAXREDIRECTS")) : null,
  };
}

const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const literal = (s: string) => `{${Buffer.byteLength(s, "utf8")}+}\r\n${s}`;

export class ManageSieve {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private waiting: { resolve: (r: Response) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  capabilities!: SieveCapabilities;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.listen(socket);
  }

  private listen(socket: net.Socket) {
    socket.setTimeout(TIMEOUT_MS);
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.deliver();
    });
    socket.on("timeout", () => this.fail(new SieveError("The mail server's filter service stopped answering.")));
    socket.on("error", (e) => this.fail(new SieveError(`Couldn't reach the mail server's filter service (${e.message}).`)));
    socket.on("close", () => this.fail(new SieveError("The mail server's filter service closed the connection.")));
  }

  private fail(err: Error) {
    this.failure ??= err;
    this.waiting?.reject(err);
    this.waiting = null;
    this.socket.destroy();
  }

  private deliver() {
    if (!this.waiting) return;
    let parsed: ReturnType<typeof parseResponse>;
    try {
      parsed = parseResponse(this.buf);
    } catch (err) {
      return this.fail(err as Error);
    }
    if (!parsed) return;
    this.buf = this.buf.subarray(parsed.length);
    const w = this.waiting;
    this.waiting = null;
    w.resolve(parsed.response);
  }

  private next(): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.deliver();
    });
  }

  /** Sends a command; resolves with its response when it's OK, rejects on NO or BYE. */
  private async command(text: string): Promise<Response> {
    const reply = this.next();
    this.socket.write(`${text}\r\n`);
    const r = await reply;
    if (r.status !== "OK") throw new SieveError(r.message?.trim() || `The mail server's filter service refused (${r.status}).`, r.code);
    return r;
  }

  static async connect(endpoint: Endpoint, creds: Credentials): Promise<ManageSieve> {
    const tlsOptions = { servername: endpoint.servername ?? (net.isIP(endpoint.host) ? undefined : endpoint.host), rejectUnauthorized: endpoint.verify };
    const socket = endpoint.security === "tls" ? tls.connect({ host: endpoint.host, port: endpoint.port, ...tlsOptions }) : net.connect({ host: endpoint.host, port: endpoint.port });
    const client = new ManageSieve(socket);
    try {
      let greeting = await client.next();
      if (greeting.status !== "OK") throw new SieveError(greeting.message ?? "The mail server's filter service turned the connection away.");
      client.capabilities = capabilities(greeting.lines);
      if (endpoint.security === "starttls") {
        // Never fall back to sending the password in the clear.
        if (!client.capabilities.starttls) throw new SieveError("The mail server's filter service doesn't offer STARTTLS.");
        await client.command("STARTTLS");
        socket.removeAllListeners("data").removeAllListeners("timeout").removeAllListeners("error").removeAllListeners("close");
        socket.on("error", () => {}); // the TLS socket reports it
        const secure = tls.connect({ socket, ...tlsOptions });
        await new Promise<void>((resolve, reject) => {
          secure.once("secureConnect", resolve);
          secure.once("error", (e) => reject(new SieveError(`The filter service's certificate wasn't accepted (${e.message}).`)));
        });
        client.socket = secure;
        client.listen(secure);
        // The server states its capabilities again once TLS is up.
        greeting = await client.next();
        client.capabilities = capabilities(greeting.lines);
      }
      if (!client.capabilities.sasl.includes("PLAIN")) throw new SieveError("The mail server's filter service doesn't accept a password sign-in.");
      const plain = Buffer.from(`\0${creds.user}\0${creds.pass}`, "utf8").toString("base64");
      try {
        await client.command(`AUTHENTICATE "PLAIN" ${quote(plain)}`);
      } catch (err) {
        throw new SieveError("The mail server's filter service didn't accept this mailbox's password.", (err as SieveError).code);
      }
      return client;
    } catch (err) {
      client.socket.destroy();
      throw err;
    }
  }

  async listScripts(): Promise<{ name: string; active: boolean }[]> {
    const r = await this.command("LISTSCRIPTS");
    return r.lines
      .filter((l) => l[0]?.t === "string" || l[0]?.t === "atom")
      .map((l) => ({ name: (l[0] as { v: string }).v, active: (l[1] as { v?: string })?.v?.toUpperCase() === "ACTIVE" }));
  }

  async getScript(name: string): Promise<string> {
    const r = await this.command(`GETSCRIPT ${quote(name)}`);
    return (r.lines[0]?.[0] as { v?: string })?.v ?? "";
  }

  /** Checks a script without saving it; rejects with the server's complaint. */
  async checkScript(content: string): Promise<void> {
    await this.command(`CHECKSCRIPT ${literal(content)}`);
  }

  async putScript(name: string, content: string): Promise<void> {
    await this.command(`PUTSCRIPT ${quote(name)} ${literal(content)}`);
  }

  /** Makes this script the active one; "" leaves none active. */
  async setActive(name: string): Promise<void> {
    await this.command(`SETACTIVE ${quote(name)}`);
  }

  async deleteScript(name: string): Promise<void> {
    await this.command(`DELETESCRIPT ${quote(name)}`);
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // Closing is all that matters.
    }
    this.socket.destroy();
  }
}
