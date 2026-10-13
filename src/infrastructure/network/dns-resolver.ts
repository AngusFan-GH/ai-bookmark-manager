// src/infrastructure/network/dns-resolver.ts
//
// Browser DNS resolver used by HealthService. In an extension
// service worker, `dns.lookup` is available in the global scope
// (Node-style) and returns A / AAAA records.
//
// We keep this thin so tests can inject a fake.

import type { DnsResolver } from '../../domain/health/url-guard';

interface DnsLookupResult {
  address: string;
  family: number;
}

interface DnsApi {
  lookup(host: string, options: { family: number; all?: boolean }, cb: (err: NodeJS.ErrnoException | null, addrs: DnsLookupResult[] | DnsLookupResult) => void): void;
}

export function createBrowserDnsResolver(api: DnsApi = (globalThis as unknown as { dns?: DnsApi }).dns as DnsApi): DnsResolver {
  if (!api) {
    // Test fallback: empty resolver (always treated as OK).
    return { lookup: async () => [] };
  }
  return {
    lookup: async (host: string) => {
      // We ask for both IPv4 and IPv6; dns.lookup with all:true returns
      // an array of {address, family}.
      return new Promise<string[]>((resolve, reject) => {
        api.lookup(host, { family: 0, all: true }, (err, addrs) => {
          if (err) return reject(err);
          const arr = Array.isArray(addrs) ? addrs : [addrs];
          resolve(arr.map((a) => a.address));
        });
      });
    },
  };
}
