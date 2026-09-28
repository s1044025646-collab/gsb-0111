import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiContext } from '../src/api.js';
import { openDatabase } from '../src/db.js';
import { SeismicService } from '../src/services.js';

const servers: import('node:http').Server[] = [];

afterEach(() => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function startApi() {
  const db = openDatabase(':memory:');
  const context: ApiContext = { service: new SeismicService(db, () => 1234), clock: () => 1234 };
  const api = createApiServer(context);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const started = { server: api, port: (api.address() as { port: number }).port };
  servers.push(started.server);
  return { ...started, service: context.service };
}

async function request(port: number, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('HTTP API', () => {
  it('validates station parameters', async () => {
    const api = await startApi();
    const response = await request(api.port, '/stations', 'POST', { code: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns explicit not-found code', async () => {
    const api = await startApi();
    const response = await request(api.port, '/solutions/replay', 'POST', { solutionId: 999 });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
  });

  it('paginates stations and supports synthetic workflow', async () => {
    const api = await startApi();
    api.service.repo.addModel({ version: 'v1', pVelocityKms: 6, vpVsRatio: 1.73 }, true);
    for (const index of [1, 2]) {
      const created = await request(api.port, '/stations', 'POST', { code: `S${index}`, eastKm: index, northKm: index });
      expect(created.status).toBe(201);
    }
    const first = await request(api.port, '/stations?page=1&limit=1');
    const second = await request(api.port, '/stations?page=2&limit=1');
    expect(first.body.items).toHaveLength(1);
    expect(second.body.items).toHaveLength(1);
    expect(first.body.items[0].code).not.toBe(second.body.items[0].code);
  });
});
