import Database from "better-sqlite3";
import { migrate } from "./schema.js";
import { AppError } from "../errors.js";
import { hashString } from "../util/random.js";

export interface StationInput {
  code: string;
  latitude: number;
  longitude: number;
  elevationM?: number;
  clockOffsetMs?: number;
  clockUncertaintyMs?: number;
  enabled?: boolean;
}

export interface ModelInput {
  name: string;
  pVelocityMps: number;
  vpVsRatio: number;
  activate?: boolean;
}

export interface SegmentRecord {
  id: number;
  station_id: number;
  start_ms: number;
  sample_rate_hz: number;
  samples: number[];
  synthetic_event_key: string | null;
  noise_seed: number;
  imported_at_ms: number;
  content_hash: string;
}

export class Repository {
  readonly db: Database.Database;

  constructor(path = ":memory:", now = Date.now()) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    migrate(this.db, now);
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate() as T;
  }

  createStation(input: StationInput, now: number) {
    return this.transaction(() => {
      const info = this.db.prepare(`INSERT INTO stations
        (code, latitude, longitude, elevation_m, clock_offset_ms, clock_uncertainty_ms, enabled, created_at_ms, updated_at_ms)
        VALUES (@code,@latitude,@longitude,@elevationM,@clockOffsetMs,@clockUncertaintyMs,@enabled,@now,@now)`).run({
        code: input.code,
        latitude: input.latitude,
        longitude: input.longitude,
        elevationM: input.elevationM ?? 0,
        clockOffsetMs: input.clockOffsetMs ?? 0,
        clockUncertaintyMs: input.clockUncertaintyMs ?? 0,
        enabled: input.enabled === false ? 0 : 1,
        now
      });
      this.db.prepare("INSERT INTO station_clock_history(station_id,offset_ms,uncertainty_ms,changed_at_ms,reason) VALUES (?,?,?,?,?)")
        .run(info.lastInsertRowid, input.clockOffsetMs ?? 0, input.clockUncertaintyMs ?? 0, now, "created");
      return this.getStation(Number(info.lastInsertRowid));
    });
  }

  updateClock(id: number, offsetMs: number, uncertaintyMs: number, reason: string, now: number) {
    return this.transaction(() => {
      const station = this.getStation(id);
      this.db.prepare("UPDATE stations SET clock_offset_ms=?, clock_uncertainty_ms=?, updated_at_ms=?, version=version+1 WHERE id=?")
        .run(offsetMs, uncertaintyMs, now, id);
      this.db.prepare("INSERT INTO station_clock_history(station_id,offset_ms,uncertainty_ms,changed_at_ms,reason) VALUES (?,?,?,?,?)")
        .run(id, offsetMs, uncertaintyMs, now, reason);
      this.db.prepare("UPDATE picks SET corrected_time_ms=observed_time_ms-? WHERE station_id=?").run(Math.round(offsetMs), id);
      return this.getStation(id);
    });
  }

  getStation(id: number) {
    const row = this.db.prepare("SELECT * FROM stations WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", `Station ${id} not found`);
    return row as Record<string, unknown>;
  }

  findStationByCode(code: string) {
    return this.db.prepare("SELECT * FROM stations WHERE code=?").get(code) as Record<string, unknown> | undefined;
  }

  listStations(limit: number, offset: number) {
    return this.db.prepare("SELECT * FROM stations ORDER BY code LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
  }

  createVelocityModel(input: ModelInput, now: number) {
    return this.transaction(() => {
      const info = this.db.prepare("INSERT INTO velocity_models(name,p_velocity_mps,vp_vs_ratio,created_at_ms,active) VALUES (?,?,?,?,?)")
        .run(input.name, input.pVelocityMps, input.vpVsRatio, now, input.activate ? 1 : 0);
      if (input.activate) this.db.prepare("UPDATE velocity_models SET active=0 WHERE id<>?").run(info.lastInsertRowid);
      return this.db.prepare("SELECT * FROM velocity_models WHERE id=?").get(info.lastInsertRowid);
    });
  }

  activeModel() {
    const row = this.db.prepare("SELECT * FROM velocity_models WHERE active=1 ORDER BY id DESC LIMIT 1").get();
    if (!row) throw new AppError("UNPROCESSABLE", "No active velocity model");
    return row as Record<string, unknown>;
  }

  getModel(id: number) {
    const row = this.db.prepare("SELECT * FROM velocity_models WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", `Velocity model ${id} not found`);
    return row as Record<string, unknown>;
  }

  insertSegment(stationId: number, segment: { startMs: number; sampleRateHz: number; samples: number[]; syntheticEventKey: string | null; noiseSeed: number; contentHash: string }, now: number) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM waveform_segments WHERE station_id=? AND start_ms=? AND content_hash=?")
        .get(stationId, segment.startMs, segment.contentHash) as { id: number } | undefined;
      if (existing) return { id: existing.id, duplicated: true };
      const info = this.db.prepare(`INSERT INTO waveform_segments
        (station_id,start_ms,sample_rate_hz,samples,synthetic_event_key,noise_seed,imported_at_ms,content_hash)
        VALUES (?,?,?,?,?,?,?,?)`).run(stationId, segment.startMs, segment.sampleRateHz, JSON.stringify(segment.samples),
        segment.syntheticEventKey, segment.noiseSeed, now, segment.contentHash);
      return { id: Number(info.lastInsertRowid), duplicated: false };
    });
  }

  getSegment(id: number): SegmentRecord {
    const row = this.db.prepare("SELECT * FROM waveform_segments WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Segment ${id} not found`);
    return { ...row, samples: JSON.parse(String(row.samples)) as number[] } as unknown as SegmentRecord;
  }

  insertPick(segmentId: number, stationId: number, pick: {
    phase: "P" | "S"; sampleIndex: number; observedTimeMs: number; correctedTimeMs: number;
    timeUncertaintyMs: number; amplitude: number
  }, now: number, duplicateToleranceMs = 500) {
    return this.transaction(() => {
      const duplicate = this.db.prepare(`SELECT id FROM picks WHERE station_id=? AND phase=? AND status<>'rejected'
        AND ABS(corrected_time_ms-?)<=?`).get(stationId, pick.phase, pick.correctedTimeMs, duplicateToleranceMs) as { id: number } | undefined;
      if (duplicate) return { id: duplicate.id, duplicated: true };
      const info = this.db.prepare(`INSERT INTO picks
        (segment_id,station_id,phase,sample_index,observed_time_ms,corrected_time_ms,time_uncertainty_ms,amplitude,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(segmentId, stationId, pick.phase, pick.sampleIndex, pick.observedTimeMs,
        pick.correctedTimeMs, pick.timeUncertaintyMs, pick.amplitude, now);
      return { id: Number(info.lastInsertRowid), duplicated: false };
    });
  }

  listPicks(limit: number, offset: number, includeRejected = false) {
    const where = includeRejected ? "" : "WHERE status<>'rejected'";
    return this.db.prepare(`SELECT * FROM picks ${where} ORDER BY corrected_time_ms,id LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
  }

  revisePick(id: number, sampleIndex: number, uncertaintyMs: number, status: "confirmed" | "rejected" | "revised", reason: string, reviewer: string, now: number) {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM picks WHERE id=?").get(id) as Record<string, unknown> | undefined;
      if (!old) throw new AppError("NOT_FOUND", `Pick ${id} not found`);
      const segment = this.db.prepare("SELECT * FROM waveform_segments WHERE id=?").get(old.segment_id) as Record<string, unknown>;
      const station = this.getStation(Number(old.station_id));
      const observedTimeMs = Number(segment.start_ms) + Math.round(sampleIndex * 1000 / Number(segment.sample_rate_hz));
      this.db.prepare("UPDATE picks SET status='revised' WHERE id=?").run(id);
      const info = this.db.prepare(`INSERT INTO picks
        (segment_id,station_id,phase,sample_index,observed_time_ms,corrected_time_ms,time_uncertainty_ms,amplitude,status,created_at_ms,revised_from_pick_id,revision_reason)
        VALUES (@segmentId,@stationId,@phase,@sampleIndex,@observedTimeMs,@correctedTimeMs,@uncertaintyMs,@amplitude,@status,@now,@revisedFrom,@reason)`).run({
        segmentId: old.segment_id,
        stationId: old.station_id,
        phase: old.phase,
        sampleIndex,
        observedTimeMs,
        correctedTimeMs: observedTimeMs - Math.round(Number(station.clock_offset_ms)),
        uncertaintyMs,
        amplitude: old.amplitude ?? null,
        status,
        now,
        revisedFrom: id,
        reason
      });
      this.db.prepare(`INSERT INTO pick_revisions
        (pick_id,old_sample_index,new_sample_index,old_uncertainty_ms,new_uncertainty_ms,old_status,new_status,reason,revised_at_ms,revised_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, old.sample_index, sampleIndex, old.time_uncertainty_ms, uncertaintyMs,
        old.status, status, reason, now, reviewer);
      return this.db.prepare("SELECT * FROM picks WHERE id=?").get(info.lastInsertRowid);
    });
  }

  createEvent(eventKey: string, now: number) {
    const info = this.db.prepare("INSERT INTO events(event_key,created_at_ms,updated_at_ms) VALUES (?,?,?)").run(eventKey, now, now);
    return Number(info.lastInsertRowid);
  }

  attachPicks(eventId: number, pickIds: number[], role: "primary" | "late", now: number) {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO event_picks(event_id,pick_id,associated_at_ms,association_role) VALUES (?,?,?,?)");
    for (const pickId of pickIds) stmt.run(eventId, pickId, now, role);
    this.db.prepare("UPDATE events SET updated_at_ms=? WHERE id=?").run(now, eventId);
  }

  listEvents(limit: number, offset: number) {
    return this.db.prepare("SELECT * FROM events ORDER BY id LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
  }

  getEvent(id: number) {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", `Event ${id} not found`);
    return row as Record<string, unknown>;
  }

  eventPicks(eventId: number) {
    return this.db.prepare(`SELECT p.* FROM event_picks ep JOIN picks p ON p.id=ep.pick_id
      WHERE ep.event_id=? AND p.status<>'rejected' ORDER BY p.corrected_time_ms`).all(eventId) as Record<string, number | string>[];
  }

  saveSolution(eventId: number, modelId: number, inputHash: string, solution: SolutionRecord, now: number) {
    return this.transaction(() => {
      const info = this.db.prepare(`INSERT INTO location_solutions
        (event_id,velocity_model_id,input_hash,latitude,longitude,depth_m,origin_time_ms,rms_residual_ms,max_abs_residual_ms,
        horizontal_uncertainty_m,depth_uncertainty_m,origin_time_uncertainty_ms,quality,rejection_reason,created_at_ms)
        VALUES (@eventId,@modelId,@inputHash,@latitude,@longitude,@depthM,@originTimeMs,@rms,@max,@hu,@du,@tu,@quality,@reason,@now)
        ON CONFLICT(event_id,input_hash) DO NOTHING`).run({
        eventId, modelId, inputHash,
        latitude: solution.latitude, longitude: solution.longitude, depthM: solution.depthM, originTimeMs: solution.originTimeMs,
        rms: solution.rmsResidualMs, max: solution.maxAbsResidualMs, hu: solution.horizontalUncertaintyM,
        du: solution.depthUncertaintyM, tu: solution.originTimeUncertaintyMs, quality: solution.quality,
        reason: solution.rejectionReason ?? null, now
      });
      const saved = this.db.prepare("SELECT * FROM location_solutions WHERE event_id=? AND input_hash=?").get(eventId, inputHash) as Record<string, unknown>;
      this.db.prepare("DELETE FROM solution_residuals WHERE solution_id=?").run(saved.id);
      const residualStmt = this.db.prepare("INSERT INTO solution_residuals(solution_id,pick_id,observed_ms,predicted_ms,residual_ms) VALUES (?,?,?,?,?)");
      for (const residual of solution.residuals) residualStmt.run(saved.id, residual.pickId, residual.observedMs, residual.predictedMs, residual.residualMs);
      if (solution.quality === "stable") this.db.prepare("UPDATE events SET status='located',updated_at_ms=? WHERE id=?").run(now, eventId);
      return saved;
    });
  }
}

export interface SolutionRecord {
  latitude: number;
  longitude: number;
  depthM: number;
  originTimeMs: number;
  rmsResidualMs: number;
  maxAbsResidualMs: number;
  horizontalUncertaintyM: number;
  depthUncertaintyM: number;
  originTimeUncertaintyMs: number;
  quality: "stable" | "rejected";
  rejectionReason?: string;
  residuals: { pickId: number; observedMs: number; predictedMs: number; residualMs: number }[];
}

export function solutionInputHash(modelId: number, picks: Array<{ id: number; corrected_time_ms: unknown; time_uncertainty_ms: unknown }>): string {
  return hashString(JSON.stringify({ modelId, picks: picks.map((p) => [p.id, p.corrected_time_ms, p.time_uncertainty_ms]).sort((a, b) => Number(a[0]) - Number(b[0])) }));
}
