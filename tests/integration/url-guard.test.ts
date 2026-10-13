// tests/integration/url-guard.test.ts
//
// URLGuard: static checks + DNS-side checks.

import { describe, expect, it } from 'vitest';
import {
  guardUrl,
  guardResolvedHost,
  isPrivateLiteralAddress,
  type DnsResolver,
} from '../../src/domain/health/url-guard';

describe('guardUrl — static checks', () => {
  it('accepts plain https URLs', () => {
    const v = guardUrl('https://example.com/path?q=1');
    expect(v.ok).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/plain,hi', 'ftp://example.com']) {
      const v = guardUrl(u);
      expect(v.ok, u).toBe(false);
      if (!v.ok) expect(v.code).toBe('UNSUPPORTED_SCHEME');
    }
  });

  it('rejects URLs with embedded credentials', () => {
    const v = guardUrl('https://user:pass@example.com/');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('CREDENTIALS');
  });

  it('rejects malformed URLs', () => {
    const v = guardUrl('not a url');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('INVALID');
  });

  it('rejects loopback hostnames', () => {
    for (const host of ['localhost', 'LOCALHOST', 'ip6-localhost', 'broadcasthost']) {
      const v = guardUrl(`http://${host}/`);
      expect(v.ok, host).toBe(false);
      if (!v.ok) expect(v.code).toBe('PRIVATE_HOST');
    }
  });

  it('rejects .local / .internal / .lan suffixes', () => {
    for (const host of ['printer.local', 'db.internal', 'nas.lan']) {
      const v = guardUrl(`http://${host}/`);
      expect(v.ok, host).toBe(false);
      if (!v.ok) expect(v.code).toBe('PRIVATE_HOST');
    }
  });

  it('rejects literal private IPv4 addresses', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.0.1']) {
      const v = guardUrl(`http://${ip}/`);
      expect(v.ok, ip).toBe(false);
      if (!v.ok) expect(v.code).toBe('PRIVATE_HOST');
    }
  });

  it('accepts literal private IPv4 when allowPrivateHosts is true', () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '127.0.0.1']) {
      const v = guardUrl(`http://${ip}/`, { allowPrivateHosts: true });
      expect(v.ok, ip).toBe(true);
    }
  });

  it('accepts localhost when allowPrivateHosts is true', () => {
    expect(guardUrl('http://localhost/', { allowPrivateHosts: true }).ok).toBe(true);
    expect(guardUrl('http://localhost.localdomain/', { allowPrivateHosts: true }).ok).toBe(true);
  });

  it('rejects reserved IPv4 ranges (TEST-NET, multicast, etc.)', () => {
    for (const ip of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '100.64.0.1']) {
      const v = guardUrl(`http://${ip}/`);
      expect(v.ok, ip).toBe(false);
    }
  });

  it('accepts literal public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '9.9.9.9']) {
      const v = guardUrl(`http://${ip}/`);
      expect(v.ok, ip).toBe(true);
    }
  });

  it('rejects literal IPv6 (best-effort)', () => {
    for (const host of ['::1', 'fe80::1', 'fc00::1']) {
      const v = guardUrl(`http://[${host}]/`);
      expect(v.ok, host).toBe(false);
    }
  });
});

describe('isPrivateLiteralAddress', () => {
  it('detects private IPv4', () => {
    expect(isPrivateLiteralAddress('10.0.0.1')).toBe(true);
    expect(isPrivateLiteralAddress('8.8.8.8')).toBe(false);
  });
  it('detects IPv6 special-purpose', () => {
    expect(isPrivateLiteralAddress('::1')).toBe(true);
    expect(isPrivateLiteralAddress('fe80::1234')).toBe(true);
    expect(isPrivateLiteralAddress('2001:4860:4860::8888')).toBe(false);
  });
  it('handles IPv4-mapped IPv6', () => {
    expect(isPrivateLiteralAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateLiteralAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('guardResolvedHost — DNS check', () => {
  it('accepts when resolver returns public addresses', async () => {
    const r: DnsResolver = { lookup: async () => ['8.8.8.8', '1.1.1.1'] };
    const out = await guardResolvedHost('example.com', r);
    expect(out.ok).toBe(true);
  });

  it('rejects when any resolved address is private', async () => {
    const r: DnsResolver = { lookup: async () => ['8.8.8.8', '10.0.0.5'] };
    const out = await guardResolvedHost('example.com', r);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/private/);
  });

  it('handles DNS lookup failure as a guard failure', async () => {
    const r: DnsResolver = { lookup: async () => { throw new Error('ENOTFOUND'); } };
    const out = await guardResolvedHost('nx.example.com', r);
    expect(out.ok).toBe(false);
  });
});
