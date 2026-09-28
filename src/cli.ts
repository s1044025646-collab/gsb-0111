#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { SeismicService } from './services.js';
import { generateSyntheticWaveform } from './synthetic.js';
import { pickPhases } from './picker.js';

const dbPath = process.env.SEISMIC_DB ?? './data/seismic.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const service = new SeismicService(db, () => 1_700_000_000_000);
const repo = service.repo;

const [command, ...args] = process.argv.slice(2);
const options = parseArgs(args);

try {
  switch (command) {
    case 'init': {
      const before = modelCount();
      repo.addModel({ version: String(options.model ?? 'v1'), pVelocityKms: Number(options.p ?? 6), vpVsRatio: Number(options.ratio ?? 1.73) }, true);
      console.log(`models: ${before} -> ${modelCount()}`);
      break;
    }
    case 'station': {
      const before = stationCount();
      const id = repo.upsertStation({ code: required('code'), eastKm: num('east'), northKm: num('north'), elevationKm: numOr('elevation', 0), clockOffsetSec: numOr('clock', 0) });
      console.log(`station ${id}: ${before} -> ${stationCount()}`);
      break;
    }
    case 'clock': {
      const station = repo.getStation(num('station')) as any;
      console.log(`before: station=${station.code} clockOffsetSec=${station.clockOffsetSec}`);
      repo.setStationClock(num('station'), num('offset'), String(options.reason ?? 'manual calibration'));
      const after = repo.getStation(num('station')) as any;
      console.log(`after: station=${after.code} clockOffsetSec=${after.clockOffsetSec}`);
      break;
    }
    case 'import-synthetic': {
      const generated = generateSyntheticWaveform({
        sampleRateHz: numOr('rate', 50), durationSec: numOr('duration', 20),
        pArrivalSec: numberOrUndefined('p'), sArrivalSec: numberOrUndefined('s'),
        noiseAmplitude: numOr('noise', 0.03), seed: num('seed'),
      });
      const before = segmentCount();
      const id = repo.addSegment(num('station'), String(options.component ?? 'Z'), numOr('start', 1_700_000_000_000), numOr('rate', 50), generated.samples, String(num('seed')));
      console.log(`segment ${id}: ${before} -> ${segmentCount()}; samples=${generated.samples.length}; pIndex=${generated.pIndex ?? '-'}; sIndex=${generated.sIndex ?? '-'}`);
      break;
    }
    case 'pick': {
      const segment = repo.getSegment(num('segment'));
      if (!segment) throw new Error('segment not found');
      const before = pickCount();
      const picks = pickPhases(segment.samples, { sampleRateHz: segment.sampleRateHz }).map((pick) => repo.addPick({ ...pick, segmentId: segment.id, stationId: segment.stationId, method: 'auto', createdBy: 'cli-auto' }));
      console.log(`before active picks=${before}; after active picks=${pickCount()}; results=${JSON.stringify(picks)}`);
      break;
    }
    case 'associate': {
      console.log(`before events=${eventCount()}; active picks=${pickCount()}`);
      const result = service.associateAndLocate(numberOrUndefined('model'), Boolean(options.publish));
      console.log(`after events=${eventCount()}; created=${JSON.stringify(result.createdEventIds)}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'relocate': {
      const before = solutionCount(num('event'));
      const result = service.relocatEvent(num('event'), numberOrUndefined('model'), Boolean(options.publish));
      console.log(`solutions: ${before} -> ${solutionCount(num('event'))}; status=${result.status}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'review': {
      const before = reviewCount();
      const decision = String(options.decision ?? 'approved') as 'approved' | 'changes_requested' | 'flagged';
      const id = repo.addReview(num('event'), options.solution ? Number(options.solution) : null, decision, String(options.reviewer ?? 'operator'), String(options.note ?? ''));
      console.log(`review ${id}: ${before} -> ${reviewCount()}`);
      break;
    }
    case 'report': {
      console.log(JSON.stringify({
        event: (repo.listEvents(1000, 0) as any[]).find((item) => item.id === num('event')),
        picks: repo.eventPicks(num('event')),
        solutions: repo.solutions(num('event')),
      }, null, 2));
      break;
    }
    default:
      console.log('commands: init station clock import-synthetic pick associate relocate review report');
  }
} finally {
  db.close();
}

function parseArgs(values: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].startsWith('--')) result[values[index].slice(2)] = values[index + 1]?.startsWith('--') ? true : values[++index];
  }
  return result;
}
function required(name: string): string { if (typeof options[name] !== 'string') throw new Error(`--${name} required`); return options[name] as string; }
function num(name: string): number { const value = Number(required(name)); if (!Number.isFinite(value)) throw new Error(`--${name} invalid`); return value; }
function numOr(name: string, fallback: number): number { return options[name] === undefined ? fallback : Number(options[name]); }
function numberOrUndefined(name: string): number | undefined { return options[name] === undefined ? undefined : Number(options[name]); }
function count(sql: string): number { return Number((db.prepare(sql).get() as { value: number }).value); }
function stationCount() { return count('SELECT COUNT(*) value FROM stations'); }
function modelCount() { return count('SELECT COUNT(*) value FROM velocity_models'); }
function segmentCount() { return count('SELECT COUNT(*) value FROM waveform_segments'); }
function pickCount() { return count("SELECT COUNT(*) value FROM picks WHERE status='active'"); }
function eventCount() { return count('SELECT COUNT(*) value FROM seismic_events'); }
function solutionCount(eventId: number) { return Number((db.prepare('SELECT COUNT(*) value FROM location_solutions WHERE event_id = ?').get(eventId) as { value: number }).value); }
function reviewCount() { return count('SELECT COUNT(*) value FROM reviews'); }
