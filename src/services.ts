import { Repository, solutionInputHash, type StationInput, type ModelInput } from "./db/repository.js";
import { AppError, assert } from "./errors.js";
import { generateSegment, type SyntheticEvent, type StationCoordinate } from "./waveform/generator.js";
import { pickPhases } from "./waveform/picker.js";
import { associatePicks } from "./seismic/association.js";
import { locate, type StationObservation } from "./seismic/locator.js";

export function validateLatLon(latitude: unknown, longitude: unknown): void {
  assert(typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90, "latitude must be between -90 and 90");
  assert(typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180, "longitude must be between -180 and 180");
}

export function validatePagination(query: URLSearchParams): { limit: number; offset: number } {
  const limit = Number(query.get("limit") ?? 50);
  const page = Number(query.get("page") ?? 1);
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 200, "limit must be an integer from 1 to 200");
  assert(Number.isInteger(page) && page >= 1, "page must be a positive integer");
  return { limit, offset: (page - 1) * limit };
}

export function createStation(repo: Repository, body: Partial<StationInput>, now: number) {
  assert(typeof body.code === "string" && /^[A-Za-z0-9_-]{2,20}$/.test(body.code), "code must be 2-20 letters, digits, _ or -");
  validateLatLon(body.latitude, body.longitude);
  assert(body.elevationM === undefined || Number.isFinite(body.elevationM), "elevationM must be numeric");
  assert(body.clockOffsetMs === undefined || Number.isFinite(body.clockOffsetMs), "clockOffsetMs must be numeric");
  assert(body.clockUncertaintyMs === undefined || Number.isFinite(body.clockUncertaintyMs) && body.clockUncertaintyMs >= 0, "clockUncertaintyMs must be non-negative");
  return repo.createStation(body as StationInput, now);
}

export function createModel(repo: Repository, body: Partial<ModelInput>, now: number) {
  assert(typeof body.name === "string" && body.name.trim().length >= 2, "name must be at least 2 characters");
  assert(typeof body.pVelocityMps === "number" && body.pVelocityMps > 1000 && body.pVelocityMps < 20000, "pVelocityMps must be between 1000 and 20000");
  assert(typeof body.vpVsRatio === "number" && body.vpVsRatio > 1 && body.vpVsRatio < 3, "vpVsRatio must be between 1 and 3");
  return repo.createVelocityModel(body as ModelInput, now);
}

export function calibrateStationClock(repo: Repository, stationId: number, offsetMs: unknown, uncertaintyMs: unknown, reason: unknown, now: number) {
  assert(Number.isFinite(offsetMs), "clockOffsetMs must be numeric");
  assert(Number.isFinite(uncertaintyMs) && Number(uncertaintyMs) >= 0, "clockUncertaintyMs must be non-negative numeric");
  assert(typeof reason === "string" && reason.trim().length > 0, "reason is required");
  return repo.updateClock(stationId, Number(offsetMs), Number(uncertaintyMs), reason, now);
}

export function importSynthetic(repo: Repository, stationCode: string, event: SyntheticEvent | null, options: Parameters<typeof generateSegment>[2], now: number) {
  const station = repo.findStationByCode(stationCode);
  if (!station) throw new AppError("NOT_FOUND", `Station ${stationCode} not found`);
  const segment = generateSegment({
    code: stationCode,
    latitude: Number(station.latitude),
    longitude: Number(station.longitude)
  } satisfies StationCoordinate, event, options);
  const saved = repo.insertSegment(Number(station.id), segment, now);
  return { ...saved, segment };
}

export function pickSegment(repo: Repository, segmentId: number, now: number, options: Parameters<typeof pickPhases>[3] = {}) {
  const segment = repo.getSegment(segmentId);
  const station = repo.getStation(Number(segment.station_id));
  const model = (() => {
    try { return repo.activeModel(); } catch { return undefined; }
  })();
  const pVelocity = Number(model?.pVelocityMps ?? 5800);
  const ratio = Number(model?.vpVsRatio ?? 1.73);
  const picks = pickPhases(segment.samples, Number(segment.start_ms), Number(segment.sample_rate_hz), {
    clockOffsetMs: Number(station.clock_offset_ms),
    minSpMs: 500 * ratio / (ratio - 1),
    ...options
  });
  return picks.map((pick) => repo.insertPick(segmentId, Number(segment.station_id), {
    phase: pick.phase,
    sampleIndex: pick.sampleIndex,
    observedTimeMs: pick.observedTimeMs,
    correctedTimeMs: pick.correctedTimeMs,
    timeUncertaintyMs: pick.timeUncertaintyMs,
    amplitude: pick.amplitude
  }, now));
}

export function associateAll(repo: Repository, now: number, windowMs = 5000) {
  const picks = repo.listPicks(5000, 0).filter((pick) => {
    const linked = repo.db.prepare("SELECT 1 FROM event_picks WHERE pick_id=?").get(pick.id);
    return !linked;
  });
  const stationRows = repo.db.prepare("SELECT * FROM stations").all() as Record<string, unknown>[];
  const stations = new Map(stationRows.map((row) => [Number(row.id), row]));
  const associated = associatePicks(picks as never, stations, { eventWindowMs: windowMs });
  return associated.map((item) => {
    let eventId: number;
    const existing = repo.db.prepare("SELECT id FROM events WHERE event_key=?").get(item.eventKey) as { id: number } | undefined;
    if (existing) eventId = existing.id;
    else eventId = repo.createEvent(item.eventKey, now);
    repo.attachPicks(eventId, item.pickIds, "primary", now);
    if (item.rejected) repo.db.prepare("UPDATE events SET status='rejected',updated_at_ms=? WHERE id=?").run(now, eventId);
    return { eventId, ...item };
  });
}

export function locateEvent(repo: Repository, eventId: number, modelId: number | undefined, now: number) {
  repo.getEvent(eventId);
  const model = modelId ? repo.getModel(modelId) : repo.activeModel();
  const pickRows = repo.eventPicks(eventId);
  if (pickRows.length === 0) throw new AppError("UNPROCESSABLE", "Event has no active picks");
  const observations: StationObservation[] = pickRows.map((pick) => ({
    pickId: Number(pick.id),
    stationId: Number(pick.station_id),
    phase: String(pick.phase) as "P" | "S",
    timeMs: Number(pick.corrected_time_ms),
    uncertaintyMs: Number(pick.time_uncertainty_ms)
  }));
  const stationRows = repo.db.prepare("SELECT id,latitude,longitude FROM stations WHERE enabled=1").all() as { id: number; latitude: number; longitude: number }[];
  const result = locate(observations, stationRows, {
    pVelocityMps: Number(model.p_velocity_mps),
    vpVsRatio: Number(model.vp_vs_ratio)
  });
  const hash = solutionInputHash(Number(model.id), pickRows as { id: number; corrected_time_ms: number; time_uncertainty_ms: number }[]);
  return repo.saveSolution(eventId, Number(model.id), hash, result, now);
}

export function reviewEvent(repo: Repository, eventId: number, decision: "confirm" | "reject" | "needs_revision", note: string, reviewer: string, now: number) {
  repo.getEvent(eventId);
  const solution = repo.db.prepare("SELECT id FROM location_solutions WHERE event_id=? ORDER BY id DESC LIMIT 1").get(eventId) as { id: number } | undefined;
  repo.db.prepare("INSERT INTO reviews(event_id,solution_id,decision,note,reviewer,reviewed_at_ms) VALUES (?,?,?,?,?,?)")
    .run(eventId, solution?.id ?? null, decision, note, reviewer, now);
  const status = decision === "confirm" ? "reviewed" : decision === "reject" ? "rejected" : "candidate";
  repo.db.prepare("UPDATE events SET status=?,updated_at_ms=? WHERE id=?").run(status, now, eventId);
  return repo.getEvent(eventId);
}

export function revisePickRequest(repo: Repository, pickId: number, body: Partial<{
  sampleIndex: number;
  timeUncertaintyMs: number;
  status: "confirmed" | "rejected" | "revised";
  reason: string;
  reviewer: string;
}>, now: number) {
  const { sampleIndex, timeUncertaintyMs, status, reason, reviewer } = body;
  if (typeof sampleIndex !== "number" || !Number.isInteger(sampleIndex) || sampleIndex < 0) throw new AppError("VALIDATION", "sampleIndex must be a non-negative integer");
  if (typeof timeUncertaintyMs !== "number" || !Number.isFinite(timeUncertaintyMs) || timeUncertaintyMs <= 0 || timeUncertaintyMs > 60000) throw new AppError("VALIDATION", "timeUncertaintyMs must be between 0 and 60000 ms");
  if (status !== "confirmed" && status !== "rejected" && status !== "revised") throw new AppError("VALIDATION", "status must be confirmed, rejected or revised");
  assert(typeof reason === "string" && reason.trim().length > 0, "reason is required");
  assert(typeof reviewer === "string" && reviewer.trim().length > 0, "reviewer is required");
  return repo.revisePick(pickId, sampleIndex, timeUncertaintyMs, status, reason, reviewer, now);
}

export function explainSolution(repo: Repository, solutionId: number) {
  const solution = repo.db.prepare("SELECT * FROM location_solutions WHERE id=?").get(solutionId) as Record<string, unknown> | undefined;
  if (!solution) throw new AppError("NOT_FOUND", `Solution ${solutionId} not found`);
  const residuals = repo.db.prepare(`
    SELECT sr.*, s.station_id, st.code AS station_code, s.phase
    FROM solution_residuals sr
    JOIN picks s ON s.id = sr.pick_id
    JOIN stations st ON st.id = s.station_id
    WHERE sr.solution_id=?
    ORDER BY ABS(sr.residual_ms) DESC`).all(solutionId) as Record<string, unknown>[];
  const worst = residuals[0];
  return {
    solution,
    residuals,
    interpretation: solution.quality === "rejected"
      ? { acceptable: false, reason: solution.rejection_reason, worstStation: worst?.station_code, worstResidualMs: worst?.residual_ms }
      : { acceptable: true, reason: "weighted RMS and maximum residuals are within configured thresholds", worstStation: worst?.station_code, worstResidualMs: worst?.residual_ms }
  };
}

export function publishSolution(repo: Repository, solutionId: number, now: number) {
  return repo.transaction(() => {
    const solution = repo.db.prepare("SELECT * FROM location_solutions WHERE id=?").get(solutionId) as Record<string, unknown> | undefined;
    if (!solution) throw new AppError("NOT_FOUND", `Solution ${solutionId} not found`);
    if (solution.quality !== "stable") throw new AppError("CONFLICT", "Only stable solutions can be published");
    repo.db.prepare("UPDATE location_solutions SET published=1 WHERE id=?").run(solutionId);
    repo.db.prepare("UPDATE events SET status='published',updated_at_ms=? WHERE id=?").run(now, solution.event_id);
    return solution;
  });
}
