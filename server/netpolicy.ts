// User-supplied mail servers are a way to make this server open connections. They
// must resolve to public addresses — checked at every connection, not just at
// sign-in, and the connection goes to the address that was checked (so a DNS answer
// that changes in between, "rebinding", can't redirect it).
import dns from "node:dns/promises";
import net from "node:net";
import type { Endpoint } from "./config.ts";
import { config } from "./config.ts";

// Parsed numerically by Node, so every spelling of an address (::1, 0:0:0:0:0:0:0:1,
// ::0001 …) is matched the same way.
const blocked = new net.BlockList();
for (const [range, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(range, prefix, "ipv4");
}
for (const [range, prefix] of [
  ["::", 128], ["::1", 128],
  // IPv4-mapped addresses (::ffff:a.b.c.d, in any spelling) are already judged by the
  // IPv4 rules above. Other forms that embed IPv4 (compatible, NAT64, 6to4) are
  // refused outright rather than trusting the embedded address.
  ["::", 96], ["64:ff9b::", 96], ["2002::", 16],
  ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  blocked.addSubnet(range, prefix, "ipv6");
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
}

export class BlockedServerError extends Error {}

/**
 * Where to actually connect. Operator-configured endpoints pass through unchanged;
 * a user's server is resolved, every address vetted, and the connection pinned to
 * one of them with the original name kept for TLS (SNI and certificate checks).
 */
/** The operator's own servers are trusted; anything else came from a user. */
function operatorConfigured(endpoint: Endpoint): boolean {
  return [config.imap, config.smtp].some(
    (c) => !!c && c.host.toLowerCase() === endpoint.host.toLowerCase() && c.port === endpoint.port,
  );
}

export async function connectTarget(endpoint: Endpoint): Promise<{ host: string; servername?: string }> {
  // Judged by comparison with the configuration, not by a stored flag, so an account
  // row that predates the flag (or a changed IMAP_HOST) can't skip the check.
  const custom = endpoint.custom || !operatorConfigured(endpoint);
  if (!custom || config.allowPrivateServers) return { host: endpoint.host, servername: endpoint.servername };
  const name = endpoint.host;
  const found = net.isIP(name) ? [{ address: name }] : await dns.lookup(name, { all: true }).catch(() => []);
  if (!found.length) throw new BlockedServerError(`Couldn't find the server "${name}".`);
  if (found.some((a) => isPrivateAddress(a.address))) throw new BlockedServerError("That server isn't allowed.");
  return { host: found[0].address, servername: endpoint.servername ?? (net.isIP(name) ? undefined : name) };
}
