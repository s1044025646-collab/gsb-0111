import { describe, expect, it } from 'vitest';
import { buildScenario, makeService, tempDb } from './helpers.js';

describe('seismic backend', () => {
  it('locates a normal multi-station event', () => {
    const dbPath = tempDb('normal');
    const service = makeService(dbPath);
    buildScenario(service);
    const result = service.associateAndLocate(1, true);
    expect(result.createdEventIds).toHaveLength(1);
    const solution = service.repo.solutions(1)[0] as any;
    expect(solution.status).toBe('accepted');
    expect(Math.hypot(solution.eastKm - 2, solution.northKm + 3)).toBeLessThan(1);
    expect(Math.abs(solution.depthKm - 8)).toBeLessThan(2);
    expect(solution.rmsResidualSec).toBeLessThan(0.1);
  });

  it('rejects a single-station pseudo-trigger without a stable location', () => {
    const dbPath = tempDb('single');
    const service = makeService(dbPath);
    service.repo.addModel({ version: 'v1', pVelocityKms: 6, vpVsRatio: 1.73 }, true);
    const stationId = service.repo.upsertStation({ code: 'AAA', eastKm: 0, northKm: 0 });
    const segmentId = service.repo.addSegment(stationId, 'Z', 0, 50, [], 'x');
    service.db.prepare(`INSERT INTO picks(segment_id,station_id,phase,sample_index,time_ms,uncertainty_sec,method,status,created_by,created_at_ms) VALUES (?,?,'P',10,200,.05,'manual','active','x',1)`).run(segmentId, stationId);
    const result = service.associateAndLocate(1);
    expect(result.createdEventIds).toEqual([]);
    expect(result.rejectedGroups[0].reason).toContain('single-station');
  });

  it('keeps overlapping aftershocks as separate events', () => {
    const dbPath = tempDb('aftershock');
    const service = makeService(dbPath);
    buildScenario(service, { events: [
      { eastKm: 2, northKm: -3, depthKm: 8, originSec: 0 },
      { eastKm: 4, northKm: -1, depthKm: 9, originSec: 12 },
    ] });
    const result = service.associateAndLocate(1);
    expect(result.createdEventIds).toHaveLength(2);
  });

  it('applies station clock corrections before association', () => {
    const dbPath = tempDb('clock');
    const service = makeService(dbPath);
    buildScenario(service, { clockOffsets: { AAA: 2 } });
    const uncorrected = service.associateAndLocate(1);
    expect(uncorrected.createdEventIds.length).toBeLessThanOrEqual(1);
    const station = service.repo.listStations(10, 0)[0] as any;
    service.repo.setStationClock(station.id, 0, 'NTP calibration');
    const model = service.repo.getModel(1);
    const observations = service.repo.activeObservations(model.id);
    expect(observations.find((item: any) => item.stationCode === 'AAA' && item.phase === 'P')!.correctedTimeMs).not.toBeGreaterThan(3000);
  });

  it('does not use disabled bad stations', () => {
    const dbPath = tempDb('bad-station');
    const service = makeService(dbPath);
    buildScenario(service, { disabled: ['DDD'] });
    const result = service.associateAndLocate(1);
    expect(result.createdEventIds).toHaveLength(1);
  });

  it('rejects degenerate collinear networks', () => {
    const dbPath = tempDb('degenerate');
    const service = makeService(dbPath);
    buildScenario(service, { stations: [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 30, 0]] });
    const result = service.associateAndLocate(1);
    const eventId = result.createdEventIds[0];
    expect(eventId).toBe(1);
    expect((service.repo.solutions(eventId)[0] as any).rejectionReason).toContain('DEGENERATE_GEOMETRY');
  });

  it('preserves pick revisions and creates new solutions', () => {
    const dbPath = tempDb('revision');
    const service = makeService(dbPath);
    buildScenario(service);
    service.associateAndLocate(1);
    const firstPick = (service.repo.listPicks(1, 0)[0] as any).id;
    const revised = service.repo.revisePick(firstPick, { sampleIndex: 500, uncertaintySec: 0.04, createdBy: 'reviewer' });
    expect((service.repo.listPicks(100, 0, 'superseded') as any[]).some((pick) => pick.id === firstPick)).toBe(true);
    const relocated = service.relocatEvent(1, 1);
    expect(relocated.status).toBe('rejected');
    expect(revised).toBeGreaterThan(firstPick);
    expect(service.repo.solutions(1)).toHaveLength(2);
  });

  it('isolates velocity model versions and replays published inputs', () => {
    const dbPath = tempDb('models');
    const service = makeService(dbPath);
    buildScenario(service);
    service.associateAndLocate(1, true);
    const secondModel = service.repo.addModel({ version: 'v2', pVelocityKms: 7.2, vpVsRatio: 1.8 }, false);
    service.relocatEvent(1, secondModel);
    expect(service.repo.solutions(1).map((row: any) => row.modelId)).toEqual([1, 2]);
    const replay = service.replaySolution(1);
    expect(replay.result.status).toBe('accepted');
  });

  it('deduplicates repeated P/S reports', () => {
    const dbPath = tempDb('duplicate');
    const service = makeService(dbPath);
    buildScenario(service);
    const pick = service.repo.listPicks(1, 0)[0] as any;
    const repeated = service.repo.addPick({ segmentId: pick.segmentId, stationId: pick.stationId, phase: pick.phase, sampleIndex: pick.sampleIndex + 1, uncertaintySec: pick.uncertaintySec, method: 'auto', createdBy: 'duplicate-test' });
    expect(repeated.duplicate).toBe(true);
  });

  it('survives process-restart persistence and repeat migrations', () => {
    const dbPath = tempDb('restart');
    const first = makeService(dbPath);
    buildScenario(first);
    first.associateAndLocate(1, true);
    first.db.close();
    process.env.KEEP_SEISMIC_DB = '1';
    const reopened = makeService(dbPath);
    delete process.env.KEEP_SEISMIC_DB;
    expect(reopened.repo.listEvents(10, 0)).toHaveLength(1);
    expect((reopened.repo.solutions(1)[0] as any).status).toBe('accepted');
  });

  it('serializes concurrent writes in transactions without losing clock logs', async () => {
    const dbPath = tempDb('concurrency');
    const service = makeService(dbPath);
    service.repo.addModel({ version: 'v1', pVelocityKms: 6, vpVsRatio: 1.73 }, true);
    const stationId = service.repo.upsertStation({ code: 'AAA', eastKm: 0, northKm: 0 });
    await Promise.all(Array.from({ length: 8 }, (_, index) => Promise.resolve(service.repo.setStationClock(stationId, index * 0.1, `calibration ${index}`))));
    const logs = service.db.prepare('SELECT COUNT(*) AS value FROM station_clock_logs WHERE station_id = ?').get(stationId) as any;
    expect(logs.value).toBe(8);
  });
});
