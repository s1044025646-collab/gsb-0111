import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { SeismicService } from '../src/services.js';

export interface ScenarioOptions {
  stations?: Array<[string, number, number, number?]>;
  events?: Array<{ eastKm: number; northKm: number; depthKm: number; originSec: number }>;
  clockOffsets?: Record<string, number>;
  disabled?: string[];
  noise?: number;
  pVelocityKms?: number;
}

export function makeService(path: string, clock = () => 1_700_000_000_000) {
  if (process.env.KEEP_SEISMIC_DB !== '1') rmSync(path, { force: true });
  return new SeismicService(openDatabase(path), clock);
}

export function tempDb(name: string): string {
  return join(tmpdir(), `seismic-${name}-${Math.random().toString(36).slice(2)}.sqlite`);
}

export function buildScenario(service: SeismicService, options: ScenarioOptions = {}) {
  const stationsInput = options.stations ?? [['AAA', 0, 0], ['BBB', 25, 0], ['CCC', -18, 22], ['DDD', 8, -24]];
  const events = options.events ?? [{ eastKm: 2, northKm: -3, depthKm: 8, originSec: 0 }];
  const vp = options.pVelocityKms ?? 6;
  const ratio = 1.73;
  service.repo.addModel({ version: 'v1', pVelocityKms: vp, vpVsRatio: ratio }, true);
  const stationIds = stationsInput.map(([code, east, north, elevation = 0]) => service.repo.upsertStation({ code, eastKm: east, northKm: north, elevationKm: elevation, clockOffsetSec: options.clockOffsets?.[code] ?? 0 }));
  for (const code of options.disabled ?? []) {
    const id = stationIds[stationsInput.findIndex((station) => station[0] === code)];
    service.db.prepare('UPDATE stations SET enabled = 0 WHERE id = ?').run(id);
  }
  for (const [stationIndex, stationId] of stationIds.entries()) {
    const [, stationEast, stationNorth, elevation = 0] = stationsInput[stationIndex];
    for (const [eventIndex, event] of events.entries()) {
      const distance = Math.hypot(stationEast - event.eastKm, stationNorth - event.northKm, elevation + event.depthKm);
      const pSec = event.originSec + distance / vp;
      const sSec = event.originSec + (distance / vp) * ratio;
      const segmentId = service.repo.addSegment(stationId, 'Z', 0, 50, Array(1000).fill(0), `fixture-${stationIndex}-${eventIndex}`);
      addExactPick(service, segmentId, stationId, 'P', pSec, 0.05);
      addExactPick(service, segmentId, stationId, 'S', sSec, 0.08);
    }
  }
  return { stationIds, modelId: 1 };
}

export function addExactPick(service: SeismicService, segmentId: number, stationId: number, phase: 'P' | 'S', timeSec: number, uncertaintySec: number, offset = 0) {
  return service.db.prepare(`INSERT INTO picks(segment_id, station_id, phase, sample_index, time_ms, uncertainty_sec, method, status, created_by, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, 'manual', 'active', 'fixture', 1)`).run(segmentId, stationId, phase, Math.max(0, Math.round((timeSec + offset) * 50)), (timeSec + offset) * 1000, uncertaintySec);
}
