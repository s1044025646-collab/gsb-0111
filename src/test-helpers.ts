import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import { Repository } from "./db/repository.js";
import { associateAll, createModel, createStation, importSynthetic, locateEvent, pickSegment } from "./services.js";

export interface ScenarioStation {
  code: string;
  latitude: number;
  longitude: number;
  clockOffsetMs?: number;
}

export function makeDb(label: string): { dbPath: string; repo: Repository; nowValue: number } {
  const dir = mkdtempSync(join(tmpdir(), `seismic-${label}-`));
  const dbPath = join(dir, "test.sqlite");
  const repo = new Repository(dbPath, 1_700_000_000_000);
  afterEach(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dbPath, repo, nowValue: 1_700_000_000_000 };
}

export function seedModel(repo: Repository, name = "model-v1", pVelocityMps = 5800, vpVsRatio = 1.73, activate = true, now = 1_700_000_001_000) {
  return Number((createModel(repo, { name, pVelocityMps, vpVsRatio, activate }, now) as { id: number }).id);
}

export function seedStations(repo: Repository, stations: ScenarioStation[], now = 1_700_000_002_000) {
  for (const station of stations) {
    createStation(repo, {
      code: station.code,
      latitude: station.latitude,
      longitude: station.longitude,
      clockOffsetMs: station.clockOffsetMs ?? 0,
      clockUncertaintyMs: station.clockOffsetMs ? 20 : 0
    }, now);
  }
}

export function seedEventAcrossStations(repo: Repository, stations: ScenarioStation[], event: {
  key: string; originTimeMs: number; latitude: number; longitude: number; depthM: number;
}, now = 1_700_000_010_000) {
  const segmentIds: number[] = [];
  const pickIds: number[] = [];
  stations.forEach((station, index) => {
    const imported = importSynthetic(repo, station.code, event, {
      durationMs: 120000,
      pVelocityMps: 5800,
      vpVsRatio: 1.73,
      noiseLevel: 0.002,
      seedBase: 1000 + index
    }, now + index);
    segmentIds.push(imported.id);
    for (const result of pickSegment(repo, imported.id, now + 100 + index, { pThreshold: 3.2, sThreshold: 2.6 })) {
      pickIds.push(result.id);
    }
  });
  const associations = associateAll(repo, now + 1000, 5000);
  return { segmentIds, pickIds, associations, eventId: associations.find((item) => !item.rejected)?.eventId };
}
