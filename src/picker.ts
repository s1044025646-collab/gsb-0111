export type Phase = 'P' | 'S';

export interface PickResult {
  phase: Phase;
  sampleIndex: number;
  uncertaintySec: number;
}

export interface PickOptions {
  sampleRateHz: number;
  pThreshold?: number;
  sThreshold?: number;
  minSeparationSec?: number;
}

export function pickPhases(samples: readonly number[], options: PickOptions): PickResult[] {
  const pThreshold = options.pThreshold ?? 6;
  const sThreshold = options.sThreshold ?? 6;
  const minSeparation = options.minSeparationSec ?? 0.25;
  const shortWindow = Math.max(3, Math.round(options.sampleRateHz * 0.08));
  const longWindow = Math.max(8, Math.round(options.sampleRateHz * 0.5));
  const features = staLta(samples, shortWindow, longWindow);
  const pIndex = firstThreshold(features, pThreshold, longWindow + 1);
  if (pIndex === undefined) return [];
  const results: PickResult[] = [{ phase: 'P', sampleIndex: pIndex, uncertaintySec: Math.max(0.02, 2 / options.sampleRateHz) }];
  const earliestS = Math.max(longWindow + 1, pIndex + Math.round(minSeparation * options.sampleRateHz));
  const sIndex = firstThreshold(features, sThreshold, earliestS);
  if (sIndex !== undefined) {
    results.push({ phase: 'S', sampleIndex: sIndex, uncertaintySec: Math.max(0.04, 3 / options.sampleRateHz) });
  }
  return results;
}

function staLta(samples: readonly number[], shortWindow: number, longWindow: number): number[] {
  const energies = samples.map((sample) => sample * sample);
  return energies.map((_, index) => {
    const shortStart = Math.max(0, index - shortWindow + 1);
    const longStart = Math.max(0, index - longWindow + 1);
    let shortSum = 0;
    let longSum = 0;
    for (let cursor = shortStart; cursor <= index; cursor += 1) shortSum += energies[cursor];
    for (let cursor = longStart; cursor <= index; cursor += 1) longSum += energies[cursor];
    return (shortSum / shortWindow) / Math.max(1e-10, longSum / longWindow);
  });
}

function firstThreshold(values: readonly number[], threshold: number, startIndex: number): number | undefined {
  for (let index = Math.max(1, startIndex); index < values.length - 1; index += 1) {
    if (values[index] >= threshold && values.slice(index, Math.min(values.length, index + 4)).filter((value) => value >= threshold).length >= 3
      && values[index] >= values[index - 1]) return index;
  }
  return undefined;
}
