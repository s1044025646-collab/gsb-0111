import type { DatabaseSync } from 'node:sqlite';
import { hashText } from './random.js';
import { secondsToMs, type Clock } from './time.js';

export interface StationInput { code: string; eastKm: number; northKm: number; elevationKm?: number; clockOffsetSec?: number }
export interface ModelInput { version: string; pVelocityKms: number; vpVsRatio: number }

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly clock: Clock) {}

  upsertStation(input: StationInput): number {
    const now = this.clock();
    return this.db.prepare(`
      INSERT INTO stations(code, east_km, north_km, elevation_km, clock_offset_sec, enabled, created_at_ms)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(code) DO UPDATE SET
        east_km = excluded.east_km, north_km = excluded.north_km, elevation_km = excluded.elevation_km,
        clock_offset_sec = excluded.clock_offset_sec
      RETURNING id
    `).get(input.code, input.eastKm, input.northKm, input.elevationKm ?? 0, input.clockOffsetSec ?? 0, now)!.id as number;
  }

  setStationClock(stationId: number, offsetSec: number, reason: string): void {
    const old = this.db.prepare('SELECT clock_offset_sec FROM stations WHERE id = ?').get(stationId) as { clock_offset_sec: number } | undefined;
    if (!old) throw Object.assign(new Error('station not found'), { code: 'NOT_FOUND' });
    const now = this.clock();
    this.db.prepare('INSERT INTO station_clock_logs(station_id, old_offset_sec, new_offset_sec, reason, created_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(stationId, old.clock_offset_sec, offsetSec, reason, now);
    this.db.prepare('UPDATE stations SET clock_offset_sec = ? WHERE id = ?').run(offsetSec, stationId);
  }

  getStation(stationId: number) {
    return this.db.prepare('SELECT id, code, east_km AS eastKm, north_km AS northKm, elevation_km AS elevationKm, clock_offset_sec AS clockOffsetSec, enabled FROM stations WHERE id = ?').get(stationId);
  }

  listStations(limit: number, offset: number) {
    return this.db.prepare('SELECT id, code, east_km AS eastKm, north_km AS northKm, elevation_km AS elevationKm, clock_offset_sec AS clockOffsetSec, enabled FROM stations ORDER BY code LIMIT ? OFFSET ?').all(limit, offset);
  }

  addModel(input: ModelInput, current = false): number {
    const now = this.clock();
    const id = this.db.prepare('INSERT INTO velocity_models(version, p_velocity_kms, vp_vs_ratio, is_current, created_at_ms) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(input.version, input.pVelocityKms, input.vpVsRatio, current ? 1 : 0, now)!.id as number;
    if (current) this.db.prepare('UPDATE velocity_models SET is_current = 0 WHERE id <> ?').run(id);
    return id;
  }

  getModel(idOrVersion: number | string) {
    const row = typeof idOrVersion === 'number'
      ? this.db.prepare('SELECT id, version, p_velocity_kms AS pVelocityKms, vp_vs_ratio AS vpVsRatio, is_current AS isCurrent FROM velocity_models WHERE id = ?').get(idOrVersion)
      : this.db.prepare('SELECT id, version, p_velocity_kms AS pVelocityKms, vp_vs_ratio AS vpVsRatio, is_current AS isCurrent FROM velocity_models WHERE version = ?').get(idOrVersion);
    if (!row) throw Object.assign(new Error('velocity model not found'), { code: 'NOT_FOUND' });
    return row as { id: number; version: string; pVelocityKms: number; vpVsRatio: number; isCurrent: number };
  }

  currentModel() {
    const row = this.db.prepare('SELECT id, version, p_velocity_kms AS pVelocityKms, vp_vs_ratio AS vpVsRatio, is_current AS isCurrent FROM velocity_models WHERE is_current = 1').get();
    if (!row) throw Object.assign(new Error('current velocity model not configured'), { code: 'MODEL_MISSING' });
    return row as { id: number; version: string; pVelocityKms: number; vpVsRatio: number; isCurrent: number };
  }

  listModels(limit: number, offset: number) {
    return this.db.prepare('SELECT id, version, p_velocity_kms AS pVelocityKms, vp_vs_ratio AS vpVsRatio, is_current AS isCurrent FROM velocity_models ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
  }

  addSegment(stationId: number, component: string, startTimeMs: number, sampleRateHz: number, samples: number[], seed: string) {
    const now = this.clock();
    return Number(this.db.prepare(`
      INSERT INTO waveform_segments(station_id, component, start_time_ms, sample_rate_hz, samples_json, seed, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(stationId, component, startTimeMs, sampleRateHz, JSON.stringify(samples), seed, now)!.id);
  }

  getSegment(segmentId: number) {
    const row = this.db.prepare(`SELECT id, station_id AS stationId, component, start_time_ms AS startTimeMs, sample_rate_hz AS sampleRateHz,
      samples_json AS samplesJson, seed FROM waveform_segments WHERE id = ?`).get(segmentId) as
      { id: number; stationId: number; component: string; startTimeMs: number; sampleRateHz: number; samplesJson: string; seed: string } | undefined;
    return row ? { ...row, samples: JSON.parse(row.samplesJson) as number[] } : undefined;
  }

  listSegments(limit: number, offset: number) {
    return this.db.prepare('SELECT id, station_id AS stationId, component, start_time_ms AS startTimeMs, sample_rate_hz AS sampleRateHz, seed FROM waveform_segments ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
  }

  addPick(input: { segmentId: number; stationId: number; phase: 'P' | 'S'; sampleIndex: number; uncertaintySec: number; method: 'auto' | 'manual'; createdBy: string; note?: string }, duplicateWindowSec = 0.15) {
    const segment = this.getSegment(input.segmentId);
    if (!segment) throw Object.assign(new Error('segment not found'), { code: 'NOT_FOUND' });
    const timeMs = segment.startTimeMs + secondsToMs(input.sampleIndex / segment.sampleRateHz);
    const windowMs = secondsToMs(duplicateWindowSec);
    const duplicate = this.db.prepare(`SELECT id FROM picks WHERE station_id = ? AND phase = ? AND status = 'active'
      AND ABS(time_ms - ?) <= ? ORDER BY ABS(time_ms - ?) LIMIT 1`).get(input.stationId, input.phase, timeMs, windowMs, timeMs) as { id: number } | undefined;
    const now = this.clock();
    if (duplicate) {
      this.db.prepare(`INSERT INTO picks(segment_id, station_id, phase, sample_index, time_ms, uncertainty_sec, method, status, duplicate_of_pick_id, created_by, note, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate', ?, ?, ?, ?)`).run(input.segmentId, input.stationId, input.phase, input.sampleIndex, timeMs,
        input.uncertaintySec, input.method, duplicate.id, input.createdBy, input.note ?? `duplicate of pick ${duplicate.id}`, now);
      return { duplicate: true as const, pickId: duplicate.id };
    }
    const id = Number(this.db.prepare(`INSERT INTO picks(segment_id, station_id, phase, sample_index, time_ms, uncertainty_sec, method, status, created_by, note, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?) RETURNING id`).get(input.segmentId, input.stationId, input.phase, input.sampleIndex, timeMs,
      input.uncertaintySec, input.method, input.createdBy, input.note ?? '', now)!.id);
    return { duplicate: false as const, pickId: id };
  }

  revisePick(pickId: number, revision: { sampleIndex?: number; uncertaintySec?: number; phase?: 'P' | 'S'; createdBy: string; note?: string }) {
    const old = this.db.prepare('SELECT * FROM picks WHERE id = ?').get(pickId) as Record<string, unknown> | undefined;
    if (!old) throw Object.assign(new Error('pick not found'), { code: 'NOT_FOUND' });
    const segment = this.getSegment(Number(old.segment_id));
    if (!segment) throw Object.assign(new Error('segment not found'), { code: 'NOT_FOUND' });
    const sampleIndex = revision.sampleIndex ?? Number(old.sample_index);
    const uncertaintySec = revision.uncertaintySec ?? Number(old.uncertainty_sec);
    const phase = revision.phase ?? String(old.phase) as 'P' | 'S';
    const timeMs = segment.startTimeMs + secondsToMs(sampleIndex / segment.sampleRateHz);
    const now = this.clock();
    const newId = Number(this.db.prepare(`INSERT INTO picks(segment_id, station_id, phase, sample_index, time_ms, uncertainty_sec, method, status, parent_pick_id, created_by, note, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?, ?) RETURNING id`).get(segment.id, Number(old.station_id), phase, sampleIndex, timeMs,
      uncertaintySec, pickId, revision.createdBy, revision.note ?? '', now)!.id);
    this.db.prepare('UPDATE picks SET status = ?, superseded_by_pick_id = ? WHERE id = ?').run('superseded', newId, pickId);
    this.db.prepare('INSERT OR IGNORE INTO event_picks(event_id, pick_id) SELECT event_id, ? FROM event_picks WHERE pick_id = ?').run(newId, pickId);
    this.db.prepare('DELETE FROM event_picks WHERE pick_id = ?').run(pickId);
    return newId;
  }

  listPicks(limit: number, offset: number, status = 'active') {
    return this.db.prepare(`SELECT p.id AS id, segment_id AS segmentId, station_id AS stationId, s.code AS stationCode, phase, sample_index AS sampleIndex,
      time_ms AS timeMs, uncertainty_sec AS uncertaintySec, method, status, note
      FROM picks p JOIN stations s ON s.id = p.station_id WHERE p.status = ? ORDER BY time_ms, id LIMIT ? OFFSET ?`).all(status, limit, offset);
  }

  activeObservations(modelId: number) {
    const model = this.getModel(modelId);
    const rows = this.db.prepare(`SELECT p.id AS pickId, p.station_id AS stationId, s.code AS stationCode, s.east_km AS eastKm, s.north_km AS northKm,
      s.elevation_km AS elevationKm, s.clock_offset_sec AS clockOffsetSec, s.enabled AS enabled,
      p.phase, p.time_ms AS timeMs, p.uncertainty_sec AS uncertaintySec
      FROM picks p JOIN stations s ON s.id = p.station_id
      WHERE p.status = 'active' AND s.enabled = 1
      ORDER BY p.time_ms, p.id`).all() as Array<{ pickId: number; stationId: number; stationCode: string; eastKm: number; northKm: number; elevationKm: number; clockOffsetSec: number; enabled: number; phase: string; timeMs: number; uncertaintySec: number }>;
    return rows.map((row) => ({
      ...row,
      enabled: row.enabled === 1,
      correctedTimeMs: row.timeMs - secondsToMs(row.clockOffsetSec),
      velocityKms: row.phase === 'P' ? model.pVelocityKms : model.pVelocityKms / model.vpVsRatio,
    }));
  }

  createEvent(pickIds: number[]): number {
    const now = this.clock();
    const id = Number(this.db.prepare('INSERT INTO seismic_events(status, created_at_ms) VALUES (?, ?) RETURNING id').get('candidate', now)!.id);
    const insert = this.db.prepare('INSERT OR IGNORE INTO event_picks(event_id, pick_id) VALUES (?, ?)');
    for (const pickId of pickIds) insert.run(id, pickId);
    return id;
  }

  listEvents(limit: number, offset: number) {
    return this.db.prepare(`SELECT e.id, e.status, COUNT(ep.pick_id) AS pickCount,
      (SELECT status FROM location_solutions WHERE event_id = e.id ORDER BY id DESC LIMIT 1) AS latestSolutionStatus
      FROM seismic_events e LEFT JOIN event_picks ep ON ep.event_id = e.id
      GROUP BY e.id ORDER BY e.id LIMIT ? OFFSET ?`).all(limit, offset);
  }

  eventPicks(eventId: number) {
    return this.db.prepare(`SELECT p.id AS pickId, station_id AS stationId, phase, time_ms AS timeMs, uncertainty_sec AS uncertaintySec
      FROM event_picks ep JOIN picks p ON p.id = ep.pick_id WHERE ep.event_id = ? ORDER BY time_ms`).all(eventId);
  }

  saveSolution(solution: any): number {
    return Number(this.db.prepare(`INSERT INTO location_solutions(event_id, velocity_model_id, origin_time_ms, east_km, north_km, depth_km,
      covariance_json, rms_residual_sec, max_abs_residual_sec, status, rejection_reason, input_snapshot_json, input_hash, iterations, published, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      solution.eventId, solution.modelId, solution.originTimeMs ?? null, solution.eastKm ?? null, solution.northKm ?? null, solution.depthKm ?? null,
      JSON.stringify(solution.covariance), solution.rmsResidualSec ?? null, solution.maxAbsResidualSec ?? null,
      solution.status, solution.rejectionReason ?? '', JSON.stringify(solution.inputSnapshot), solution.inputHash, solution.iterations ?? 0,
      solution.published ? 1 : 0, this.clock())!.id);
  }

  solutions(eventId: number) {
    return this.db.prepare('SELECT id, event_id AS eventId, velocity_model_id AS modelId, origin_time_ms AS originTimeMs, east_km AS eastKm, north_km AS northKm, depth_km AS depthKm, covariance_json AS covarianceJson, rms_residual_sec AS rmsResidualSec, max_abs_residual_sec AS maxAbsResidualSec, status, rejection_reason AS rejectionReason, iterations, published FROM location_solutions WHERE event_id = ? ORDER BY id').all(eventId);
  }

  setEventStatus(eventId: number, status: string): void {
    this.db.prepare('UPDATE seismic_events SET status = ? WHERE id = ?').run(status, eventId);
  }

  addReview(eventId: number, solutionId: number | null, decision: 'approved' | 'changes_requested' | 'flagged', reviewer: string, note: string) {
    const id = Number(this.db.prepare('INSERT INTO reviews(event_id, solution_id, decision, reviewer, note, created_at_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .get(eventId, solutionId, decision, reviewer, note, this.clock())!.id);
    if (decision === 'approved') this.setEventStatus(eventId, 'reviewed');
    return id;
  }

  snapshotHash(snapshot: unknown): string { return hashText(JSON.stringify(snapshot)); }
}
