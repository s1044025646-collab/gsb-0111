import type { LocationObservation } from './location.js';

export interface AssociationResult {
  groups: number[][];
  rejected: { pickIds: number[]; reason: string }[];
}

export function associateObservations(observations: readonly LocationObservation[]): AssociationResult {
  const candidates = new Map<string, number[]>();
  for (const anchor of observations.filter((pick) => pick.phase === 'P')) {
    const origins = observations.map((observation) => ({
      pickId: observation.pickId,
      stationId: observation.stationId,
      phase: observation.phase,
      originMs: observation.correctedTimeMs - estimateTravelMs(anchor, observation),
    })).sort((a, b) => a.originMs - b.originMs);
    let window: typeof origins = [];
    let previousOrigin: number | undefined;
    const flush = () => {
      const stations = new Set(window.map((item) => item.stationId)).size;
      if (window.length >= 4 && stations >= 3 && window.some((item) => item.phase === 'P')) {
        const key = window.map((item) => item.pickId).sort((a, b) => a - b).join(',');
        candidates.set(key, window.map((item) => item.pickId));
      }
      window = [];
    };
    for (const item of origins) {
      if (previousOrigin !== undefined && item.originMs - previousOrigin > 1800) flush();
      window.push(item);
      previousOrigin = item.originMs;
    }
    flush();
  }
  const groups = chooseDisjointGroups([...candidates.values()], observations);
  const used = new Set(groups.flat());
  const rejected = observations.filter((observation) => !used.has(observation.pickId)).map((observation) => ({
    pickIds: [observation.pickId],
    reason: new Set(observations.map((other) => other.stationId)).size === 1 ? 'single-station trigger' : 'unassociated or insufficient multi-station geometry',
  }));
  return { groups, rejected };
}

function estimateTravelMs(anchorP: LocationObservation, observation: LocationObservation): number {
  const stationDistance = Math.hypot(anchorP.eastKm - observation.eastKm, anchorP.northKm - observation.northKm);
  if (observation.phase === 'P') return Math.min(8000, (stationDistance / observation.velocityKms) * 1000);
  return Math.min(12000, (stationDistance / observation.velocityKms) * 1000 + 2000);
}

function chooseDisjointGroups(candidates: number[][], observations: readonly LocationObservation[]): number[][] {
  const selected: number[][] = [];
  const used = new Set<number>();
  const scored = candidates.map((pickIds) => {
    const picks = pickIds.map((pickId) => observations.find((observation) => observation.pickId === pickId)!);
    return { pickIds, score: new Set(picks.map((pick) => pick.stationId)).size * 10 + picks.length };
  }).sort((a, b) => b.score - a.score);
  for (const candidate of scored) {
    if (candidate.pickIds.some((pickId) => used.has(pickId))) continue;
    selected.push(candidate.pickIds.sort((a, b) => a - b));
    candidate.pickIds.forEach((pickId) => used.add(pickId));
  }
  return selected;
}
