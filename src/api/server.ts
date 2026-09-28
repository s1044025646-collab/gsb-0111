import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Repository } from "../db/repository.js";
import { AppError } from "../errors.js";
import {
  associateAll, calibrateStationClock, createModel, createStation, importSynthetic, locateEvent,
  pickSegment, publishSolution, reviewEvent, revisePickRequest, explainSolution, validatePagination
} from "../services.js";

export interface AppContext {
  repo: Repository;
  now: () => number;
}

export function createApp(context: AppContext): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res, context);
    } catch (error) {
      sendError(res, error);
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, context: AppContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method ?? "GET";
  const { repo, now } = context;

  if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, now: now() });
  if (method === "GET" && path === "/stations") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.listStations(page.limit, page.offset), page));
  }
  if (method === "POST" && path === "/stations") return sendJson(res, 201, createStation(repo, await readBody(req), now()));
  const stationClockMatch = path.match(/^\/stations\/(\d+)\/clock$/);
  if (method === "POST" && stationClockMatch) {
    const body = await readBody<{ clockOffsetMs?: number; clockUncertaintyMs?: number; reason?: string }>(req);
    return sendJson(res, 200, calibrateStationClock(repo, Number(stationClockMatch[1]), body.clockOffsetMs, body.clockUncertaintyMs, body.reason, now()));
  }
  if (method === "GET" && path === "/velocity-models") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.db.prepare("SELECT * FROM velocity_models ORDER BY id LIMIT ? OFFSET ?").all(page.limit, page.offset), page));
  }
  if (method === "POST" && path === "/velocity-models") return sendJson(res, 201, createModel(repo, await readBody(req), now()));
  if (method === "GET" && path === "/segments") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.db.prepare("SELECT id,station_id,start_ms,sample_rate_hz,synthetic_event_key,noise_seed,imported_at_ms,content_hash FROM waveform_segments ORDER BY id LIMIT ? OFFSET ?").all(page.limit, page.offset), page));
  }
  if (method === "POST" && path === "/segments/synthetic") {
    const body = await readBody<{ stationCode: string; event?: Parameters<typeof importSynthetic>[2] extends infer _ ? never : never; options?: Record<string, unknown> } & Record<string, unknown>>(req);
    if (typeof body.stationCode !== "string") throw new AppError("VALIDATION", "stationCode is required");
    const event = body.eventKey ? {
      key: String(body.eventKey), originTimeMs: Number(body.originTimeMs),
      latitude: Number(body.latitude), longitude: Number(body.longitude), depthM: Number(body.depthM)
    } : null;
    if (event) [event.latitude, event.longitude, event.depthM, event.originTimeMs].forEach((value) => { if (!Number.isFinite(value)) throw new AppError("VALIDATION", "synthetic event fields must be numeric"); });
    return sendJson(res, 201, importSynthetic(repo, body.stationCode, event, (body.options ?? {}) as never, now()));
  }

  const segmentPick = path.match(/^\/segments\/(\d+)\/picks$/);
  if (method === "POST" && segmentPick) return sendJson(res, 201, pickSegment(repo, Number(segmentPick[1]), now(), await readBody(req).catch(() => ({}))));
  if (method === "GET" && path === "/picks") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.listPicks(page.limit, page.offset, url.searchParams.get("includeRejected") === "true"), page));
  }
  const pickRevisionMatch = path.match(/^\/picks\/(\d+)\/revision$/);
  if (method === "POST" && pickRevisionMatch) {
    return sendJson(res, 201, revisePickRequest(repo, Number(pickRevisionMatch[1]), await readBody(req), now()));
  }
  if (method === "POST" && path === "/events/associate") {
    const body = (await readBody(req).catch(() => ({}))) as { windowMs?: number };
    return sendJson(res, 201, associateAll(repo, now(), body.windowMs));
  }
  if (method === "GET" && path === "/events") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.listEvents(page.limit, page.offset), page));
  }
  const eventMatch = path.match(/^\/events\/(\d+)$/);
  if (method === "GET" && eventMatch) return sendJson(res, 200, { event: repo.getEvent(Number(eventMatch[1])), picks: repo.eventPicks(Number(eventMatch[1])) });
  const locateMatch = path.match(/^\/events\/(\d+)\/locate$/);
  if (method === "POST" && locateMatch) {
    const body = (await readBody(req).catch(() => ({}))) as { velocityModelId?: number };
    return sendJson(res, 201, locateEvent(repo, Number(locateMatch[1]), body.velocityModelId, now()));
  }
  const reviewMatch = path.match(/^\/events\/(\d+)\/review$/);
  if (method === "POST" && reviewMatch) {
    const body = await readBody<{ decision?: "confirm" | "reject" | "needs_revision"; note?: string; reviewer?: string }>(req);
    if (!body.decision || !["confirm", "reject", "needs_revision"].includes(body.decision)) throw new AppError("VALIDATION", "decision must be confirm, reject or needs_revision");
    if (typeof body.note !== "string" || !body.note.trim()) throw new AppError("VALIDATION", "note is required");
    if (typeof body.reviewer !== "string" || !body.reviewer.trim()) throw new AppError("VALIDATION", "reviewer is required");
    return sendJson(res, 201, reviewEvent(repo, Number(reviewMatch[1]), body.decision, body.note, body.reviewer, now()));
  }
  const solutionMatch = path.match(/^\/solutions\/(\d+)\/publish$/);
  if (method === "POST" && solutionMatch) return sendJson(res, 200, publishSolution(repo, Number(solutionMatch[1]), now()));
  if (method === "GET" && path === "/solutions") {
    const page = validatePagination(url.searchParams);
    return sendJson(res, 200, paginate(repo.db.prepare("SELECT * FROM location_solutions ORDER BY id LIMIT ? OFFSET ?").all(page.limit, page.offset), page));
  }
  const solutionMatchGet = path.match(/^\/solutions\/(\d+)$/);
  if (method === "GET" && solutionMatchGet) return sendJson(res, 200, explainSolution(repo, Number(solutionMatchGet[1])));

  throw new AppError("NOT_FOUND", `Route ${method} ${path} was not found`);
}

async function readBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; } catch { throw new AppError("VALIDATION", "Request body must be valid JSON"); }
}

function paginate(rows: unknown[], page: { limit: number; offset: number }) {
  return { data: rows, limit: page.limit, offset: page.offset, count: rows.length, hasMore: rows.length === page.limit };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  const app = error instanceof AppError ? error : new AppError("INTERNAL", error instanceof Error ? error.message : "Unexpected error");
  const status = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE: 422, INTERNAL: 500 }[app.code];
  sendJson(res, status, { error: { code: app.code, message: app.message, details: app.details } });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const dbPath = process.env.SEISMIC_DB ?? "./data/seismic.sqlite";
  const port = Number(process.env.PORT ?? 0);
  const repo = new Repository(dbPath);
  const server = createApp({ repo, now: Date.now });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") console.log(`Seismic API listening on http://127.0.0.1:${address.port}`);
  });
}
