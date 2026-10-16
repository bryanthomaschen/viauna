// Every setting comes from the environment, so the same image runs anywhere. See
// README.md ("Configuration") for the operator-facing description of each variable.
import path from "node:path";

export type Security = "tls" | "starttls" | "none";

export interface Endpoint {
  host: string;
  port: number;
  security: Security;
  /** TLS server name to verify against when `host` is an internal alias or an IP. */
  servername?: string;
  /** Verify the server's certificate. Only ever false for development servers. */
  verify: boolean;
  /** Entered by a user (ALLOW_CUSTOM_SERVERS), so re-vetted before every connection. */
  custom?: boolean;
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function security(name: string, fallback: Security): Security {
  const value = (env(name) ?? fallback).toLowerCase();
  if (value === "tls" || value === "starttls" || value === "none") return value;
  throw new Error(`${name} must be one of tls, starttls, none — got "${value}"`);
}

function endpoint(prefix: "IMAP" | "SMTP", defaultPort: number): Endpoint | null {
  const host = env(`${prefix}_HOST`);
  if (!host) return null;
  return {
    host,
    port: int(`${prefix}_PORT`, defaultPort),
    security: security(`${prefix}_SECURITY`, "tls"),
    servername: env(`${prefix}_TLS_SERVERNAME`),
    verify: bool(`${prefix}_TLS_VERIFY`, true),
  };
}

const dataDir = path.resolve(env("DATA_DIR", "./data")!);

export const config = {
  appName: env("APP_NAME", "Viauna")!,
  host: env("HOST", "127.0.0.1")!,
  port: int("PORT", 3000),
  dataDir,
  /** Public origin, e.g. https://mail.example.com. Used for the CSRF origin check. */
  publicUrl: env("PUBLIC_URL"),
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: bool("TRUST_PROXY", false),
  /** Mark cookies Secure. Defaults on unless PUBLIC_URL is plain http. */
  secureCookies: bool("SECURE_COOKIES", !(env("PUBLIC_URL") ?? "").startsWith("http://")),
  sessionDays: int("SESSION_DAYS", 30),
  maxAccountsPerSession: int("MAX_ACCOUNTS", 10),

  imap: endpoint("IMAP", 993),
  smtp: endpoint("SMTP", 465),
  /** Let users type their own IMAP/SMTP servers on the sign-in page. */
  allowCustomServers: bool("ALLOW_CUSTOM_SERVERS", false),
  /** Custom servers may not resolve to private/loopback addresses unless this is on. */
  allowPrivateServers: bool("ALLOW_PRIVATE_SERVERS", false),
  /** Comma-separated domains allowed to sign in; empty means any. */
  allowedDomains: (env("ALLOWED_DOMAINS", "") as string)
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),

  maxUploadBytes: int("MAX_UPLOAD_MB", 25) * 1024 * 1024,
  /** Disk cache for downloaded messages, in bytes. */
  cacheBytes: int("CACHE_MB", 1024) * 1024 * 1024,
  logLevel: env("LOG_LEVEL", "info")!,
};

export type Config = typeof config;
