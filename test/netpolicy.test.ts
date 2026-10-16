import { describe, expect, it } from "vitest";
import { connectTarget, isPrivateAddress } from "../server/netpolicy.ts";

describe("custom server policy", () => {
  it("recognises private, loopback and special addresses in every spelling", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a user's server that resolves privately, and pins to the vetted address", async () => {
    await expect(connectTarget({ host: "127.0.0.1", port: 993, security: "tls", verify: true, custom: true })).rejects.toThrow(/isn't allowed/);
    await expect(connectTarget({ host: "localhost", port: 993, security: "tls", verify: true, custom: true })).rejects.toThrow(/isn't allowed/);
    const ok = await connectTarget({ host: "8.8.8.8", port: 993, security: "tls", verify: true, custom: true });
    expect(ok.host).toBe("8.8.8.8");
  });

  it("leaves operator-configured servers alone", async () => {
    const t = await connectTarget({ host: "mailu-front", port: 993, security: "tls", verify: true, servername: "mail.example.com" });
    expect(t).toEqual({ host: "mailu-front", servername: "mail.example.com" });
  });
});
