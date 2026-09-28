export interface PickResult {
  phase: "P" | "S";
  sampleIndex: number;
  observedTimeMs: number;
  correctedTimeMs: number;
  timeUncertaintyMs: number;
  amplitude: number;
  score: number;
}

export interface PickOptions {
  clockOffsetMs?: number;
  pThreshold?: number;
  sThreshold?: number;
  minSeparationMs?: number;
  minSpMs?: number;
}

export function pickPhases(samples: number[], startMs: number, sampleRateHz: number, options: PickOptions = {}): PickResult[] {
  const p = staLta(samples, Math.max(2, Math.round(sampleRateHz * 0.2)), Math.round(sampleRateHz * 2));
  const s = staLta(samples, Math.max(2, Math.round(sampleRateHz * 0.35)), Math.round(sampleRateHz * 2.5));
  const pIndex = firstThreshold(p, options.pThreshold ?? 3.2, Math.round(sampleRateHz));
  const minSeparation = options.minSeparationMs ?? 250;
  const earliestS = pIndex < 0 ? 0 : pIndex + Math.round((options.minSpMs ?? minSeparation) * sampleRateHz / 1000);
  const sIndex = firstThreshold(s, options.sThreshold ?? 2.6, Math.round(sampleRateHz * 1.5), earliestS);
  const offset = options.clockOffsetMs ?? 0;
  return [pIndex, sIndex].flatMap((index, phaseIndex) => {
    if (index < 0) return [];
    const phase = phaseIndex === 0 ? "P" : "S";
    const observedTimeMs = startMs + Math.round(index * 1000 / sampleRateHz);
    return [{
      phase,
      sampleIndex: index,
      observedTimeMs,
      correctedTimeMs: observedTimeMs - Math.round(offset),
      timeUncertaintyMs: phase === "P" ? 40 : 65,
      amplitude: Math.abs(samples[index] ?? 0),
      score: phaseIndex === 0 ? p[index] : s[index]
    }];
  });
}

function staLta(samples: number[], short: number, long: number): number[] {
  const energy = samples.map((value) => value * value);
  const out = new Array<number>(samples.length).fill(0);
  let shortSum = 0, longSum = 0;
  for (let i = 0; i < samples.length; i++) {
    shortSum += energy[i];
    longSum += energy[i];
    if (i >= short) shortSum -= energy[i - short];
    if (i >= long) longSum -= energy[i - long];
    const shortAvg = shortSum / Math.min(i + 1, short);
    const longAvg = i < long ? longSum / (i + 1) : longSum / long;
    out[i] = longAvg > 0 ? shortAvg / longAvg : 0;
  }
  return out;
}

function firstThreshold(values: number[], threshold: number, lockout: number, start = 0): number {
  for (let i = start; i < values.length; i++) {
    if (values[i] >= threshold) return i;
  }
  return -1;
}
