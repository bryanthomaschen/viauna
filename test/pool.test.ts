// The runtime pool's password rules, with IMAP logins mocked: which passwords "work"
// is whatever `valid` says at the time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const valid = new Set<string>();
let logins = 0;

vi.mock("../server/imap/connection.ts", () => ({
  verifyLogin: vi.fn(async (_e: unknown, creds: { pass: string }) => {
    logins++;
    await new Promise((r) => setTimeout(r, 5));
    return valid.has(creds.pass) ? { ok: true } : { ok: false, reason: "auth", message: "Wrong email or password." };
  }),
}));

const started: FakeRuntime[] = [];
class FakeRuntime {
  account: { id: number };
  credentials: { user: string; pass: string };
  fingerprint: string;
  authFailed = false;
  verifiedAt = Date.now();
  subscribers = 0;
  stopped = false;
  constructor(account: { id: number }, creds: { user: string; pass: string }) {
    this.account = account;
    this.credentials = creds;
    this.fingerprint = `fp:${creds.pass}`;
    started.push(this);
  }
  start() {}
  touch() {}
  async stop() {
    this.stopped = true;
  }
}
vi.mock("../server/imap/runtime.ts", () => ({ AccountRuntime: FakeRuntime }));
vi.mock("../server/crypto.ts", () => ({ credentialFingerprint: (c: { pass: string }) => `fp:${c.pass}` }));
vi.mock("../server/contacts-sync.ts", () => ({ attachContactsSync: () => {} }));
vi.mock("../server/invitations.ts", () => ({ attachInvitations: () => {} }));

const { runtimeFor, stopAll, MailboxAuthError } = await import("../server/imap/pool.ts");
const account = { id: 7, login: "ann", email: "ann@x", imap: {}, smtp: {} } as never;
const as = (pass: string) => ({ user: "ann", pass });

describe("runtime pool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    await stopAll();
    valid.clear();
    started.length = 0;
    logins = 0;
  });

  it("parallel first requests share one runtime", async () => {
    valid.add("A");
    const [a, b, c] = await Promise.all([runtimeFor(account, as("A")), runtimeFor(account, as("A")), runtimeFor(account, as("A"))]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(started).toHaveLength(1);
  });

  it("after a password change, the old runtime is retired and old sessions are refused", async () => {
    valid.add("A");
    const old = await runtimeFor(account, as("A"));
    // A minute later the password changes on the server; the user signs in again with B.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    valid.delete("A");
    valid.add("B");
    const fresh = await runtimeFor(account, as("B"));
    expect(fresh).not.toBe(old);
    expect((old as unknown as FakeRuntime).stopped).toBe(true);
    expect(fresh.credentials.pass).toBe("B");
    await expect(runtimeFor(account, as("A"))).rejects.toBeInstanceOf(MailboxAuthError);
  });

  it("re-proves the runtime's own password once its proof is stale", async () => {
    valid.add("A");
    const rt = await runtimeFor(account, as("A"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    valid.delete("A");
    await expect(runtimeFor(account, as("A"))).rejects.toBeInstanceOf(MailboxAuthError);
    expect((rt as unknown as FakeRuntime).stopped).toBe(true);
  });

  it("recovers from a transient refusal when the same password works again", async () => {
    valid.add("A");
    const rt = await runtimeFor(account, as("A"));
    (rt as unknown as FakeRuntime).authFailed = true;
    const next = await runtimeFor(account, as("A"));
    expect(next).not.toBe(rt);
    expect(next.credentials.pass).toBe("A");
  });

  it("two valid passwords (password and app token) don't make the runtime thrash", async () => {
    valid.add("A");
    valid.add("token");
    const rt = await runtimeFor(account, as("A"));
    for (let i = 0; i < 5; i++) {
      expect(await runtimeFor(account, as("token"))).toBe(rt);
      expect(await runtimeFor(account, as("A"))).toBe(rt);
    }
    expect(started).toHaveLength(1);
    expect(logins).toBeLessThanOrEqual(3);
  });
});
