import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "./db/repository.js";
import {
  associateAll, createModel, createStation, importSynthetic, locateEvent,
  pickSegment, publishSolution, reviewEvent
} from "./services.js";

const dir = mkdtempSync(join(tmpdir(), "seismic-demo-"));
const dbPath = join(dir, "demo.sqlite");
const repo = new Repository(dbPath, 1_700_000_000_000);

const stations = [
  { code: "ST01", latitude: 0.1, longitude: 0, clockOffsetMs: 80 },
  { code: "ST02", latitude: -0.1, longitude: 0 },
  { code: "ST03", latitude: 0, longitude: 0.1 },
  { code: "ST04", latitude: 0, longitude: -0.1 }
];
const mainEvent = { key: "demo-main", originTimeMs: 3_000_000, latitude: 0.02, longitude: -0.01, depthM: 12000 };

function count(label: string) {
  return {
    label,
    stations: (repo.db.prepare("SELECT COUNT(*) c FROM stations").get() as { c: number }).c,
    segments: (repo.db.prepare("SELECT COUNT(*) c FROM waveform_segments").get() as { c: number }).c,
    picks: (repo.db.prepare("SELECT COUNT(*) c FROM picks WHERE status<>'rejected'").get() as { c: number }).c,
    events: (repo.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c,
    stableSolutions: (repo.db.prepare("SELECT COUNT(*) c FROM location_solutions WHERE quality='stable'").get() as { c: number }).c
  };
}

console.log("Repeatable synthetic seismic demo");
console.log(count("before"));
createModel(repo, { name: "demo-v1", pVelocityMps: 5800, vpVsRatio: 1.73, activate: true }, 1);
for (const station of stations) createStation(repo, station, 2);
stations.forEach((station, index) => {
  const imported = importSynthetic(repo, station.code, mainEvent, {
    durationMs: 120000,
    pVelocityMps: 5800,
    vpVsRatio: 1.73,
    noiseLevel: 0.002,
    seedBase: 2000 + index
  }, 100 + index);
  pickSegment(repo, imported.id, 200 + index, { pThreshold: 3.2, sThreshold: 2.6 });
});
const associations = associateAll(repo, 300);
const eventId = associations.find((item) => !item.rejected)!.eventId;
const solution = locateEvent(repo, eventId, undefined, 400) as Record<string, unknown>;
reviewEvent(repo, eventId, "confirm", "automated demo review", "demo-operator", 500);
publishSolution(repo, Number(solution.id), 600);

const loneStation = { code: "LONE", latitude: 0.2, longitude: 0.2 };
createStation(repo, loneStation, 700);
const lone = importSynthetic(repo, "LONE", { key: "demo-single", originTimeMs: 3_000_000, latitude: 0, longitude: 0, depthM: 8000 }, {
  durationMs: 120000, noiseLevel: 0.002, seedBase: 3000
}, 800);
pickSegment(repo, lone.id, 900, { pThreshold: 3.2, sThreshold: 2.6 });
const loneAssociations = associateAll(repo, 1000);
const loneId = loneAssociations.find((item) => item.rejected)!.eventId;
const rejectedSolution = locateEvent(repo, loneId, undefined, 1100) as Record<string, unknown>;

console.log(count("after"));
console.log("published stable solution", {
  eventId,
  latitude: solution.latitude,
  longitude: solution.longitude,
  depthM: solution.depth_m,
  originTimeMs: solution.origin_time_ms,
  rmsResidualMs: solution.rms_residual_ms,
  horizontalUncertaintyM: solution.horizontal_uncertainty_m
});
console.log("rejected under-determined solution", {
  eventId: loneId,
  quality: rejectedSolution.quality,
  reason: rejectedSolution.rejection_reason
});
console.log("database", dbPath);
repo.close();
rmSync(dir, { recursive: true, force: true });
