import { mulberry32 } from './random.js';

export interface SyntheticWaveformInput {
  sampleRateHz: number;
  durationSec: number;
  preEventSec?: number;
  pArrivalSec?: number;
  sArrivalSec?: number;
  noiseAmplitude?: number;
  seed: number;
}

export function generateSyntheticWaveform(input: SyntheticWaveformInput): { samples: number[]; pIndex?: number; sIndex?: number } {
  const random = mulberry32(input.seed);
  const count = Math.round(input.sampleRateHz * input.durationSec);
  const samples: number[] = [];
  const pIndex = input.pArrivalSec === undefined ? undefined : Math.round(input.pArrivalSec * input.sampleRateHz);
  const sIndex = input.sArrivalSec === undefined ? undefined : Math.round(input.sArrivalSec * input.sampleRateHz);
  for (let index = 0; index < count; index += 1) {
    const timeSec = index / input.sampleRateHz;
    let value = (random() - 0.5) * 2 * (input.noiseAmplitude ?? 0.03);
    if (pIndex !== undefined && index >= pIndex) {
      const delay = index - pIndex;
      value += Math.exp(-delay / (input.sampleRateHz * 0.18)) * Math.sin((delay / input.sampleRateHz) * Math.PI * 18);
    }
    if (sIndex !== undefined && index >= sIndex) {
      const delay = index - sIndex;
      value += 2.1 * Math.exp(-delay / (input.sampleRateHz * 0.28)) * Math.sin((delay / input.sampleRateHz) * Math.PI * 10);
    }
    samples.push(Number(value.toFixed(6)));
  }
  return { samples, pIndex, sIndex };
}
