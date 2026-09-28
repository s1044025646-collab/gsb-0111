import { Rng, hashString } from "../util/random.js";
import { distance3d } from "../util/geo.js";

export interface StationCoordinate {
  code: string;
  latitude: number;
  longitude: number;
}

export interface SyntheticEvent {
  key: string;
  originTimeMs: number;
  latitude: number;
  longitude: number;
  depthM: number;
  magnitude?: number;
}

export interface GenerateOptions {
  sampleRateHz?: number;
  durationMs?: number;
  pVelocityMps?: number;
  vpVsRatio?: number;
  noiseLevel?: number;
  seedBase?: number;
  noiseOnly?: boolean;
}

export interface WaveformSegment {
  stationCode: string;
  startMs: number;
  sampleRateHz: number;
  samples: number[];
  syntheticEventKey: string | null;
  noiseSeed: number;
  contentHash: string;
  expected?: { phase: "P" | "S"; sampleIndex: number; timeMs: number; uncertaintyMs: number }[];
}

export function generateSegment(station: StationCoordinate, event: SyntheticEvent | null, options: GenerateOptions = {}): WaveformSegment {
  const sampleRateHz = options.sampleRateHz ?? 50;
  const durationMs = options.durationMs ?? 60000;
  const noiseLevel = options.noiseLevel ?? 0.035;
  const count = Math.round((durationMs * sampleRateHz) / 1000);
  const startMs = event ? event.originTimeMs : Math.floor(options.seedBase ?? 1) * 1000;
  const seedBase = options.seedBase ?? 42;
  const noiseSeed = (seedBase ^ hashString(station.code).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) >>> 0;
  const rng = new Rng(noiseSeed);
  const samples = Array.from({ length: count }, () => rng.gaussian() * noiseLevel);
  const expected: NonNullable<WaveformSegment["expected"]> = [];

  if (event && !options.noiseOnly) {
    const distance = distance3d(station.latitude, station.longitude, 0, event.latitude, event.longitude, event.depthM);
    const pTime = distance / (options.pVelocityMps ?? 5800);
    const sTime = pTime * (options.vpVsRatio ?? 1.73);
    addPulse(samples, sampleRateHz, pTime * 1000, 1.1, 0.018, 3.4, 0.8);
    addPulse(samples, sampleRateHz, sTime * 1000, 1.8, 0.028, 3.1, 1.2);
    for (const [phase, travelMs] of [["P", pTime * 1000], ["S", sTime * 1000]] as const) {
      const index = Math.round(travelMs * sampleRateHz / 1000);
      if (index >= 0 && index < count) expected.push({ phase, sampleIndex: index, timeMs: startMs + Math.round(travelMs), uncertaintyMs: phase === "P" ? 35 : 55 });
    }
  }

  const contentHash = hashString(JSON.stringify({ station: station.code, startMs, sampleRateHz, samples }));
  return { stationCode: station.code, startMs, sampleRateHz, samples, syntheticEventKey: event?.key ?? null, noiseSeed, contentHash, expected };
}

function addPulse(samples: number[], rateHz: number, delayMs: number, freqHz: number, widthSec: number, amplitude: number, decay: number): void {
  const center = delayMs * rateHz / 1000;
  const width = widthSec * rateHz;
  const start = Math.max(0, Math.floor(center - width * 4));
  const end = Math.min(samples.length, Math.ceil(center + width * 4));
  for (let i = start; i < end; i++) {
    const t = (i - center) / rateHz;
    samples[i] += amplitude * Math.sin(2 * Math.PI * freqHz * t + Math.PI / 2) * Math.exp(-Math.abs(t) * decay);
  }
}
