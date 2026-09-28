import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { openDatabase } from './db.js';
import { generateSyntheticWaveform } from './synthetic.js';
import { pickPhases } from './picker.js';
import { SeismicService } from './services.js';
import { secondsToMs, type Clock } from './time.js';

export interface ApiContext {
  service: SeismicService;
  clock: Clock;
}

export function createApiServer(context: ApiContext): Server {
  return createServer((request, response) => handle(request, response, context).catch((error) => sendError(response, error)));
}

async function handle(request: IncomingMessage, response: ServerResponse, context: ApiContext): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method ?? 'GET';
  const repo = context.service.repo;
  if (method === 'GET' && path === '/health') return sendJson(response, { ok: true, timeMs: context.clock() });
  if (method === 'GET' && path === '/stations') return sendJson(response, paginate(url, repo.listStations.bind(repo)));
  if (method === 'POST' && path === '/stations') {
    const body = await readBody(request);
    requireString(body.code, 'code'); requireNumber(body.eastKm, 'eastKm'); requireNumber(body.northKm, 'northKm');
    optionalNumber(body.elevationKm, 'elevationKm'); optionalNumber(body.clockOffsetSec, 'clockOffsetSec');
    return sendJson(response, { id: repo.upsertStation(body as any) }, 201);
  }
  if (method === 'GET' && path === '/models') return sendJson(response, paginate(url, repo.listModels.bind(repo)));
  if (method === 'POST' && path === '/models') {
    const body = await readBody(request);
    requireString(body.version, 'version'); requirePositiveNumber(body.pVelocityKms, 'pVelocityKms'); requirePositiveNumber(body.vpVsRatio, 'vpVsRatio');
    return sendJson(response, { id: repo.addModel(body as any, Boolean(body.current)) }, 201);
  }
  if (method === 'GET' && path === '/segments') return sendJson(response, paginate(url, repo.listSegments.bind(repo)));
  if (method === 'POST' && path === '/segments/synthetic') {
    const body = await readBody(request);
    requireNumber(body.stationId, 'stationId'); requirePositiveNumber(body.sampleRateHz, 'sampleRateHz'); requirePositiveNumber(body.durationSec, 'durationSec');
    const generated = generateSyntheticWaveform({
      sampleRateHz: body.sampleRateHz, durationSec: body.durationSec,
      pArrivalSec: body.pArrivalSec, sArrivalSec: body.sArrivalSec,
      noiseAmplitude: body.noiseAmplitude, seed: Number(body.seed ?? 1),
    });
    const id = repo.addSegment(body.stationId, String(body.component ?? 'Z'), Number(body.startTimeMs ?? context.clock()), body.sampleRateHz, generated.samples, String(body.seed ?? 1));
    return sendJson(response, { id, pIndex: generated.pIndex, sIndex: generated.sIndex }, 201);
  }
  if (method === 'POST' && path === '/picks/auto') {
    const body = await readBody(request);
    requireNumber(body.segmentId, 'segmentId');
    const segment = repo.getSegment(Number(body.segmentId));
    if (!segment) return sendError(response, Object.assign(new Error('segment not found'), { code: 'NOT_FOUND' }));
    const results = pickPhases(segment.samples, { sampleRateHz: segment.sampleRateHz, pThreshold: body.pThreshold, sThreshold: body.sThreshold });
    const saved = results.map((pick) => repo.addPick({ ...pick, segmentId: segment.id, stationId: segment.stationId, method: 'auto', createdBy: 'api-auto' }));
    return sendJson(response, { picks: saved }, 201);
  }
  if (method === 'POST' && path === '/picks/manual') {
    const body = await readBody(request);
    requireNumber(body.segmentId, 'segmentId'); requireNonNegativeInteger(body.sampleIndex, 'sampleIndex'); requirePositiveNumber(body.uncertaintySec, 'uncertaintySec');
    if (body.phase !== 'P' && body.phase !== 'S') throw Object.assign(new Error('phase must be P or S'), { code: 'VALIDATION_ERROR' });
    const segment = repo.getSegment(Number(body.segmentId));
    if (!segment) throw Object.assign(new Error('segment not found'), { code: 'NOT_FOUND' });
    if (body.sampleIndex >= segment.samples.length) throw Object.assign(new Error('sampleIndex outside segment'), { code: 'VALIDATION_ERROR' });
    const saved = repo.addPick({ segmentId: segment.id, stationId: segment.stationId, sampleIndex: body.sampleIndex, uncertaintySec: body.uncertaintySec, phase: body.phase, method: 'manual', createdBy: String(body.createdBy ?? 'analyst'), note: body.note });
    return sendJson(response, saved, 201);
  }
  if (method === 'POST' && path === '/picks/revise') {
    const body = await readBody(request);
    requireNumber(body.pickId, 'pickId'); requireString(body.createdBy, 'createdBy');
    return sendJson(response, { id: repo.revisePick(Number(body.pickId), body as any) }, 201);
  }
  if (method === 'GET' && path === '/picks') return sendJson(response, paginate(url, repo.listPicks.bind(repo)));
  if (method === 'POST' && path === '/associate') {
    const body = await readBody(request);
    return sendJson(response, context.service.associateAndLocate(body.modelId, Boolean(body.publish)), 201);
  }
  if (method === 'GET' && path === '/events') return sendJson(response, paginate(url, repo.listEvents.bind(repo)));
  if (method === 'POST' && path === '/events/relocate') {
    const body = await readBody(request); requireNumber(body.eventId, 'eventId');
    return sendJson(response, context.service.relocatEvent(Number(body.eventId), body.modelId, Boolean(body.publish)), 201);
  }
  if (method === 'POST' && path === '/solutions/replay') {
    const body = await readBody(request); requireNumber(body.solutionId, 'solutionId');
    return sendJson(response, context.service.replaySolution(Number(body.solutionId)));
  }
  if (method === 'POST' && path === '/reviews') {
    const body = await readBody(request); requireNumber(body.eventId, 'eventId'); requireString(body.reviewer, 'reviewer');
    if (!['approved', 'changes_requested', 'flagged'].includes(body.decision)) throw Object.assign(new Error('invalid decision'), { code: 'VALIDATION_ERROR' });
    return sendJson(response, { id: repo.addReview(Number(body.eventId), body.solutionId ?? null, body.decision, body.reviewer, body.note ?? '') }, 201);
  }
  if (method === 'GET' && path.startsWith('/events/') && path.endsWith('/report')) {
    const eventId = Number(path.split('/')[2]);
    const event = (repo.listEvents(1000, 0) as Array<{ id: number }>).find((item) => item.id === eventId);
    if (!event) throw Object.assign(new Error('event not found'), { code: 'NOT_FOUND' });
    return sendJson(response, { event, picks: repo.eventPicks(eventId), solutions: repo.solutions(eventId) });
  }
  sendJson(response, { error: 'NOT_FOUND', message: 'route not found' }, 404);
}

function paginate(url: URL, list: (limit: number, offset: number) => unknown[]) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  const items = list(limit, (page - 1) * limit);
  return { page, limit, items };
}
async function readBody(request: IncomingMessage): Promise<Record<string, any>> {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method ?? '')) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function sendError(response: ServerResponse, error: unknown): void {
  const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR';
  const status = code === 'VALIDATION_ERROR' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'MODEL_MISSING' ? 409 : 500;
  sendJson(response, { error: code, message: (error as Error).message }, status);
}
function requireString(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || value.trim() === '') throw validation(`${field} is required`); }
function requireNumber(value: unknown, field: string): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value)) throw validation(`${field} must be a number`); }
function requirePositiveNumber(value: unknown, field: string): asserts value is number { requireNumber(value, field); if (value <= 0) throw validation(`${field} must be positive`); }
function requireNonNegativeInteger(value: unknown, field: string): asserts value is number { requireNumber(value, field); if (!Number.isInteger(value) || value < 0) throw validation(`${field} must be a non-negative integer`); }
function optionalNumber(value: unknown, field: string) { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw validation(`${field} must be a number`); }
function validation(message: string) { return Object.assign(new Error(message), { code: 'VALIDATION_ERROR' }); }

export function listenOnFreePort(dbPath: string, clock: Clock = Date.now): Promise<{ server: Server; port: number }> {
  const db = openDatabase(dbPath);
  const server = createApiServer({ service: new SeismicService(db, clock), clock });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}
