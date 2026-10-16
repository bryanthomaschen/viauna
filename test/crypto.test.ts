import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials, newSessionCookie, parseSessionCookie } from "../server/crypto.ts";

describe("credential encryption", () => {
  const creds = { user: "ann@example.org", pass: "correct horse battery staple" };

  it("round-trips with the right cookie key", () => {
    const { key } = newSessionCookie();
    const blob = encryptCredentials(creds, key, "sess", 1);
    expect(decryptCredentials(blob, key, "sess", 1)).toEqual(creds);
  });

  it("fails with another cookie, session or account", () => {
    const { key } = newSessionCookie();
    const other = newSessionCookie().key;
    const blob = encryptCredentials(creds, key, "sess", 1);
    expect(decryptCredentials(blob, other, "sess", 1)).toBeNull();
    expect(decryptCredentials(blob, key, "other", 1)).toBeNull();
    expect(decryptCredentials(blob, key, "sess", 2)).toBeNull();
  });

  it("detects tampering", () => {
    const { key } = newSessionCookie();
    const blob = encryptCredentials(creds, key, "sess", 1);
    blob[blob.length - 1] ^= 1;
    expect(decryptCredentials(blob, key, "sess", 1)).toBeNull();
  });

  it("never stores the password in clear", () => {
    const { key } = newSessionCookie();
    const blob = encryptCredentials(creds, key, "sess", 1);
    expect(blob.toString("latin1")).not.toContain("battery");
  });

  it("parses only well-formed cookies", () => {
    const c = newSessionCookie();
    expect(parseSessionCookie(c.value)).toEqual({ sid: c.sid, key: c.key });
    expect(parseSessionCookie("short.short")).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });
});
