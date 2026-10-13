// tests/fixtures/mock-http-server.ts
//
// In-process HTTP server used to exercise the FetchClient + HealthClassifier
// across the full status-code matrix from dev guide § 3.4 step 4.
//
// We use Node's built-in `http` module so the test does not depend
// on any test runner-specific network helper. Each test sets up a
// fresh server on an ephemeral port, then tears it down.
//
// Routes (the `setRoutes` builder) accept a path pattern and a
// responder. The server records the last request per path so tests
// can assert that HEAD was used, Retry-After was honored, etc.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Responder = (req: { method: string; path: string; headers: Record<string, string | string[] | undefined> }) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  at: number;
}

export interface MockServer {
  baseUrl: string;
  port: number;
  setRoute(path: string, responder: Responder): void;
  record(path: string): RecordedRequest[];
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Responder>();
  const records = new Map<string, RecordedRequest[]>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const path = u.pathname;
    const responder = routes.get(path);
    const headers = req.headers as Record<string, string | string[] | undefined>;
    if (!records.has(path)) records.set(path, []);
    records.get(path)!.push({ method: req.method ?? 'GET', path, headers, at: Date.now() });
    if (!responder) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const out = responder({ method: req.method ?? 'GET', path, headers });
    res.statusCode = out.status;
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    res.end(out.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    setRoute(path, responder) { routes.set(path, responder); },
    record(path) { return records.get(path) ?? []; },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
