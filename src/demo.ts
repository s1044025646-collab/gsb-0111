import { rmSync } from 'node:fs';
import { openDatabase } from './db.js';
import { SeismicService } from './services.js';
import { generateSyntheticWaveform } from './synthetic.js';
import { pickPhases } from './picker.js';

const dbPath = process.env.SEISMIC_DB ?? './data/demo.sqlite';
rmSync(dbPath, { force: true });
const db = openDatabase(dbPath);
const service = new SeismicService(db, () => 1_700_000_000_000);
const modelId = service.repo.addModel({ version: 'demo-v1', pVelocityKms: 6, vpVsRatio: 1.73 }, true);
const stations = [
  ['AAA', 0, 0, 0], ['BBB', 25, 0, 0], ['CCC', -18, 22, 0], ['DDD', 8, -24, 0],
] as const;
const stationIds = stations.map(([code, east, north, elevation]) => service.repo.upsertStation({ code, eastKm: east, northKm: north, elevationKm: elevation }));
const origin = 1_700_000_000_000;
const event = { eastKm: 2, northKm: -3, depthKm: 8 };
for (const [index, stationId] of stationIds.entries()) {
  const station = stations[index];
  const distance = Math.hypot(station[1] - event.eastKm, station[2] - event.northKm, station[3] + event.depthKm);
  const pSec = distance / 6;
  const sSec = pSec * 1.73;
  const waveform = generateSyntheticWaveform({ sampleRateHz: 50, durationSec: 20, preEventSec: 5, pArrivalSec: 5 + pSec, sArrivalSec: 5 + sSec, seed: 101 + index });
  const segmentId = service.repo.addSegment(stationId, 'Z', origin + 5000, 50, waveform.samples, `demo-${index}`);
  const segment = service.repo.getSegment(segmentId)!;
  for (const pick of pickPhases(segment.samples, { sampleRateHz: 50 })) {
    service.repo.addPick({ ...pick, segmentId, stationId, method: 'auto', createdBy: 'demo' });
  }
}
const result = service.associateAndLocate(modelId, true);
console.log(JSON.stringify({ dbPath, ...result, events: service.repo.listEvents(10, 0), report: service.repo.solutions(result.createdEventIds[0]) }, null, 2));
db.close();
