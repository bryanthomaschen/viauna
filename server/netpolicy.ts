// User-supplied mail servers are a way to make this server open connections. They
// must resolve to public addresses — checked at every connection, not just at
// sign-in, and the connection goes to the address that was checked (so a DNS answer
// that changes in between, "rebinding", can't redirect it).
import dns from "node:dns/promises";
import net from "node:net";
import type { Endpoint } from "./config.ts";
import { config } from "./config.ts";

function v4(ip: string): number[] {
  return ip.split(".").map(Number);
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = v4(ip);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||          // CGNAT
      (a === 169 && b === 254) ||                     // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF, TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) ||        // benchmarking
      (a === 198 && b === 51 && c === 100) ||         // TEST-NET-2
      (a === 203 && b === 0 && c === 113)             // TEST-NET-3
    );
  }
  if (!net.isIPv6(ip)) return true;
  const v6 = ip.toLowerCase();
  // IPv4-mapped/-compatible, dotted or hex (::ffff:7f00:1), NAT64 and 6to4 can all
  // reach IPv4 space: judge them by the embedded IPv4 address.
  const dotted = v6.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateAddress(dotted[1]);
  const hex = v6.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (v6.startsWith("2002:")) return true; // 6to4: embedded v4 is not worth trusting
  return (
    v6 === "::" || v6 === "::1" ||
    /^f[cd]/.test(v6) ||                 // unique local fc00::/7
    /^fe[89ab]/.test(v6) ||              // link-local fe80::/10
    /^ff/.test(v6) ||                    // multicast
    v6.startsWith("2001:db8") ||         // documentation
    v6.startsWith("100::")               // discard
  );
}

export class BlockedServerError extends Error {}

/**
 * Where to actually connect. Operator-configured endpoints pass through unchanged;
 * a user's server is resolved, every address vetted, and the connection pinned to
 * one of them with the original name kept for TLS (SNI and certificate checks).
 */
export async function connectTarget(endpoint: Endpoint): Promise<{ host: string; servername?: string }> {
  if (!endpoint.custom || config.allowPrivateServers) return { host: endpoint.host, servername: endpoint.servername };
  const name = endpoint.host;
  const found = net.isIP(name) ? [{ address: name }] : await dns.lookup(name, { all: true }).catch(() => []);
  if (!found.length) throw new BlockedServerError(`Couldn't find the server "${name}".`);
  if (found.some((a) => isPrivateAddress(a.address))) throw new BlockedServerError("That server isn't allowed.");
  return { host: found[0].address, servername: endpoint.servername ?? (net.isIP(name) ? undefined : name) };
}
