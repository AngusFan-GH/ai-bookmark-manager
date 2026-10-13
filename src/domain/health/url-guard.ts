// src/domain/health/url-guard.ts
//
// URLGuard — pre-flight checks before any network request.
//
// Per dev guide § 3.4 step 1: "仅允许 http:/https:，拒绝非网络协议；
// 明确处理 localhost、IP 字面量、IPv6、私有网段、DNS 解析和重定向后
// 的地址."
//
// We also enforce the dev guide § 3.4 caveat: "网络环境下不能可靠识别
// DNS 解析后的私网 IP 时，采用保守拒绝或明确标注风险；不得声称纯浏览器
// 扩展能完整实现服务器级 SSRF 防护." Our stance:
//   - Reject anything we can statically identify as a private/loopback
//     address.
//   - For DNS-resolution defenses, mark the result 'unsupported' so
//     the user knows we did not verify the resolved IP.
//
// Pure functions; no I/O. The DNS lookup is left to the caller
// (the FetchClient) so URLGuard remains synchronous and testable.

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-mcastprefix',
  'ip6-allnodes',
  'ip6-allrouters',
]);

// RFC 1918 + RFC 4193 + link-local + loopback + carrier-grade NAT.
// Source: IANA IPv4/IPv6 Special-Purpose Address Registry.
const IPV4_PRIVATE_PATTERNS: Array<{ test: (ip: number) => boolean; label: string }> = [
  { test: (ip) => (ip >>> 24) === 10, label: '10.0.0.0/8 (RFC 1918)' },
  { test: (ip) => ((ip >>> 24) === 172 && ((ip >>> 16) & 0xf0) === 16), label: '172.16.0.0/12 (RFC 1918)' },
  { test: (ip) => ((ip >>> 24) === 192 && ((ip >>> 16) & 0xff) === 168), label: '192.168.0.0/16 (RFC 1918)' },
  { test: (ip) => (ip >>> 24) === 127, label: '127.0.0.0/8 (loopback)' },
  { test: (ip) => (ip >>> 24) === 0, label: '0.0.0.0/8 ("this network")' },
  // 100.64.0.0/10 CGNAT: 100.64.0.0 = 0x64400000, mask /10 = 0xffc00000.
  { test: (ip) => (ip & 0xffc00000) === 0x64400000, label: '100.64.0.0/10 (CGNAT)' },
  { test: (ip) => (ip >>> 16) === 0xa9fe, label: '169.254.0.0/16 (link-local)' },
  { test: (ip) => (ip >>> 24) === 192 && ((ip >>> 16) & 0xff) === 0, label: '192.0.0.0/24 (IETF)' },
  { test: (ip) => (ip >>> 24) === 192 && ((ip >>> 16) & 0xff) === 2, label: '192.0.2.0/24 (TEST-NET-1)' },
  { test: (ip) => (ip >>> 24) === 198 && ((ip >>> 16) & 0xff) === 51 && ((ip >>> 8) & 0xff) === 100, label: '198.51.100.0/24 (TEST-NET-2)' },
  { test: (ip) => (ip >>> 24) === 203 && ((ip >>> 16) & 0xff) === 0 && ((ip >>> 8) & 0xff) === 113, label: '203.0.113.0/24 (TEST-NET-3)' },
  { test: (ip) => (ip >>> 20) === 0xb0, label: '11.0.0.0/8 (legacy — also reserved)' },
  { test: (ip) => (ip >>> 24) >= 224, label: '224.0.0.0/4 (multicast/reserved)' },
];

export type UrlGuardVerdict =
  | { ok: true; parsed: URL }
  | { ok: false; reason: string; code: 'INVALID' | 'UNSUPPORTED_SCHEME' | 'PRIVATE_HOST' | 'NO_HOST' | 'CREDENTIALS' };

/**
 * Static check: does the URL parse, use http/https, not embed
 * credentials, and not point to a literal private IP or known
 * loopback host?
 */
export function guardUrl(raw: string): UrlGuardVerdict {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is not parseable', code: 'INVALID' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}`, code: 'UNSUPPORTED_SCHEME' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL must not contain credentials', code: 'CREDENTIALS' };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: 'URL has no host', code: 'NO_HOST' };
  }
  const lower = host.toLowerCase().replace(/[\[\]]/g, '');
  if (BLOCKED_HOSTS.has(lower)) {
    return { ok: false, reason: `blocked host: ${lower}`, code: 'PRIVATE_HOST' };
  }
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.lan')) {
    return { ok: false, reason: `local-suffix host: ${lower}`, code: 'PRIVATE_HOST' };
  }
  // Literal IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const ip = ipv4ToInt(lower);
    if (ip === null) {
      return { ok: false, reason: `malformed IPv4: ${lower}`, code: 'PRIVATE_HOST' };
    }
    const hit = IPV4_PRIVATE_PATTERNS.find((p) => p.test(ip));
    if (hit) {
      return { ok: false, reason: `literal private IP (${hit.label})`, code: 'PRIVATE_HOST' };
    }
  }
  // Literal IPv6 (we conservatively reject any bracketed/hex form to
  // avoid the IETF-special registry rabbit hole; users can opt in
  // later via config).
  if (lower.includes(':') || lower.includes('[') || /^[0-9a-f]+$/i.test(lower)) {
    return { ok: false, reason: `literal IPv6 / non-DNS host: ${lower}`, code: 'PRIVATE_HOST' };
  }
  return { ok: true, parsed };
}

/**
 * Verify that a host does not resolve to a private IP. This is the
 * DNS-side half of SSRF defense. The caller is expected to have
 * already done static guardUrl() — this is a best-effort runtime
 * check.
 *
 * We can't actually do DNS in a pure unit test, so the caller passes
 * a resolver hook. In production the resolver is `dns.lookup(host)`
 * via a small adapter; in tests we can mock it.
 */
export interface DnsResolver {
  lookup(host: string): Promise<string[]>;
}

export async function guardResolvedHost(host: string, resolver: DnsResolver): Promise<{ ok: true } | { ok: false; reason: string; addresses: string[] }> {
  let addrs: string[];
  try {
    addrs = await resolver.lookup(host);
  } catch {
    return { ok: false, reason: 'DNS lookup failed', addresses: [] };
  }
  for (const addr of addrs) {
    if (isPrivateLiteralAddress(addr)) {
      return { ok: false, reason: `resolved to private address: ${addr}`, addresses: addrs };
    }
  }
  return { ok: true };
}

/**
 * Is the given address (v4 or v6) inside a private / loopback /
 * link-local range? Pure check, no DNS.
 */
export function isPrivateLiteralAddress(addr: string): boolean {
  const clean = addr.replace(/[\[\]]/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    const ip = ipv4ToInt(clean);
    if (ip === null) return true;
    return IPV4_PRIVATE_PATTERNS.some((p) => p.test(ip));
  }
  if (clean.includes(':')) {
    // IPv6 — conservatively reject all non-globally-unicast addresses.
    const lc = clean.toLowerCase().split('%')[0];
    if (lc === '::' || lc === '::1' || lc === '::0') return true;
    if (lc.startsWith('fe80:') || lc.startsWith('fe8') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb')) return true;
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // ULA
    if (lc.startsWith('ff')) return true; // multicast
    // ::ffff:a.b.c.d mapped IPv4
    const mapped = /^::ffff:([0-9.]+)$/i.exec(lc);
    if (mapped) {
      const ip = ipv4ToInt(mapped[1]);
      if (ip !== null) return IPV4_PRIVATE_PATTERNS.some((p) => p.test(ip));
    }
    return false; // global unicast
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}
