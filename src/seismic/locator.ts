import { localMeters } from "../util/geo.js";
import { geometryCheck } from "./association.js";
import type { SolutionRecord } from "../db/repository.js";

export interface StationObservation {
  pickId: number;
  stationId: number;
  phase: "P" | "S";
  timeMs: number;
  uncertaintyMs: number;
}

export interface LocationStation {
  id: number;
  latitude: number;
  longitude: number;
}

export interface LocationOptions {
  minStations?: number;
  minObservations?: number;
  maxRmsMs?: number;
  maxResidualMs?: number;
}

interface State { x: number; y: number; q: number; t: number }

export function locate(observations: StationObservation[], stations: LocationStation[], velocity: { pVelocityMps: number; vpVsRatio: number }, options: LocationOptions = {}): SolutionRecord {
  const uniqueStations = new Set(observations.map((item) => item.stationId));
  if (observations.length < (options.minObservations ?? 5) || uniqueStations.size < (options.minStations ?? 4)) {
    return rejected(`Need at least ${options.minStations ?? 4} stations and ${options.minObservations ?? 5} phases`, observations);
  }

  const stationMap = new Map(stations.map((station) => [station.id, station]));
  const obs = observations.filter((item) => stationMap.has(item.stationId));
  const usedStations = [...new Set(obs.map((item) => item.stationId))].map((id) => stationMap.get(id)!);
  const refLat = usedStations.reduce((sum, station) => sum + station.latitude, 0) / usedStations.length;
  const refLon = usedStations.reduce((sum, station) => sum + station.longitude, 0) / usedStations.length;
  const localStations = usedStations.map((station) => ({ id: station.id, ...localMeters(station.latitude, station.longitude, refLat, refLon) }));
  const localById = new Map(localStations.map((station) => [station.id, station]));
  const vs = velocity.pVelocityMps / velocity.vpVsRatio;
  const earliest = Math.min(...obs.map((item) => item.timeMs));
  let state: State = { x: 0, y: 0, q: Math.sqrt(8000), t: earliest - 8000 };
  let normal = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (let iteration = 0; iteration < 30; iteration++) {
    const rows: number[][] = [];
    const deltas: number[] = [];
    for (const item of obs) {
      const station = localById.get(item.stationId)!;
      const speed = item.phase === "P" ? velocity.pVelocityMps : vs;
      const depth = state.q * state.q;
      const dx = station.x - state.x, dy = station.y - state.y, dz = -depth;
      const distance = Math.max(Math.hypot(dx, dy, dz), 1);
      const predicted = state.t + 1000 * distance / speed;
      const factor = 1000 / (speed * distance);
      rows.push([-dx * factor, -dy * factor, -dz * factor * 2 * state.q, 1]);
      deltas.push(item.timeMs - predicted);
    }
    const weights = obs.map((item) => 1 / Math.max(item.uncertaintyMs, 1) ** 2);
    normal = normalMatrix(rows, weights);
    const damped = normal.map((row, rowIndex) => row.map((value, colIndex) => value + (rowIndex === colIndex ? Math.max(1e-8, Math.abs(value) * 0.01) : 0)));
    const target = Array(4).fill(0);
    rows.forEach((row, index) => row.forEach((value, parameter) => target[parameter] += weights[index] * value * deltas[index]));
    const update = solve4(damped, target);
    if (!update) return rejected("Singular inversion; station geometry is degenerate", observations, refLat, refLon, state);
    let step = 1;
    const beforeRms = Math.sqrt(deltas.reduce((sum, value) => sum + value * value, 0) / deltas.length);
    let candidate = state;
    let candidateRms = beforeRms;
    for (let attempt = 0; attempt < 12; attempt++) {
      candidate = {
        x: state.x + update[0] * step,
        y: state.y + update[1] * step,
        q: Math.max(0, state.q + update[2] * step),
        t: state.t + update[3] * step
      };
      const candidateDeltas = obs.map((item) => {
        const station = localById.get(item.stationId)!;
        const speed = item.phase === "P" ? velocity.pVelocityMps : vs;
        const depth = candidate.q * candidate.q;
        const distance = Math.hypot(station.x - candidate.x, station.y - candidate.y, depth);
        return item.timeMs - (candidate.t + 1000 * distance / speed);
      });
      candidateRms = Math.sqrt(candidateDeltas.reduce((sum, value) => sum + value * value, 0) / candidateDeltas.length);
      if (Number.isFinite(candidateRms) && candidateRms <= beforeRms) break;
      step *= 0.5;
    }
    state = candidate;
    if (Math.hypot(update[0], update[1], update[2]) < 0.5 && Math.abs(update[3]) < 0.5) break;
  }
  const depthResult = state.q * state.q;

  const metersLat = 111320;
  const metersLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const latitude = refLat + state.y / metersLat;
  const longitude = refLon + state.x / metersLon;
  const geometryReason = geometryCheck(usedStations, latitude, longitude);
  if (geometryReason) return rejected(geometryReason, observations, refLat, refLon, state);

  const residuals = obs.map((item) => {
    const station = localById.get(item.stationId)!;
    const speed = item.phase === "P" ? velocity.pVelocityMps : vs;
    const distance = Math.hypot(station.x - state.x, station.y - state.y, -depthResult);
    const predictedMs = Math.round(state.t + 1000 * distance / speed);
    return { pickId: item.pickId, observedMs: item.timeMs, predictedMs, residualMs: item.timeMs - predictedMs };
  });
  const rms = Math.sqrt(residuals.reduce((sum, item) => sum + item.residualMs ** 2, 0) / residuals.length);
  const maxAbs = Math.max(...residuals.map((item) => Math.abs(item.residualMs)));
  const variance = rms ** 2;
  const covariance = invert4(normal!);
  if (!covariance) return rejected("Uncertainty matrix is singular", observations, refLat, refLon, state);
  const horizontalUncertaintyM = Math.sqrt(Math.max(0, covariance[0][0] + covariance[1][1]) * variance);
  const depthUncertaintyM = Math.sqrt(Math.max(0, covariance[2][2]) * variance) * 2 * Math.max(state.q, 1);
  const originTimeUncertaintyMs = Math.sqrt(Math.max(0, covariance[3][3]) * variance);

  if (!Number.isFinite(horizontalUncertaintyM) || horizontalUncertaintyM > 50000 || depthUncertaintyM > 50000) {
    return rejected("Uncertainty too large for a stable solution", observations, refLat, refLon, state);
  }
  if (rms > (options.maxRmsMs ?? 250) || maxAbs > (options.maxResidualMs ?? 750)) {
    return rejected(`Travel-time residuals are too large (rms=${rms.toFixed(1)} ms)`, observations, refLat, refLon, state, residuals, rms, maxAbs, horizontalUncertaintyM, depthUncertaintyM, originTimeUncertaintyMs);
  }

  return {
    latitude, longitude, depthM: depthResult, originTimeMs: Math.round(state.t),
    rmsResidualMs: rms, maxAbsResidualMs: maxAbs,
    horizontalUncertaintyM, depthUncertaintyM, originTimeUncertaintyMs,
    quality: "stable", residuals
  };
}

function rejected(reason: string, observations: StationObservation[], refLat = 0, refLon = 0, state: State = { x: 0, y: 0, q: 0, t: 0 }, residuals: SolutionRecord["residuals"] = [], rms = 0, maxAbs = 0, hu = 0, du = 0, tu = 0): SolutionRecord {
  return {
    latitude: refLat + state.y / 111320,
    longitude: refLon + state.x / (111320 * Math.cos(refLat * Math.PI / 180)),
    depthM: state.q * state.q, originTimeMs: Math.round(state.t),
    rmsResidualMs: rms, maxAbsResidualMs: maxAbs, horizontalUncertaintyM: hu, depthUncertaintyM: du,
    originTimeUncertaintyMs: tu, quality: "rejected", rejectionReason: reason,
    residuals: residuals.length ? residuals : observations.map((item) => ({ pickId: item.pickId, observedMs: item.timeMs, predictedMs: item.timeMs, residualMs: 0 }))
  };
}

function normalMatrix(rows: number[][], weights: number[]): number[][] {
  const matrix = Array.from({ length: 4 }, () => Array(4).fill(0));
  rows.forEach((row, i) => row.forEach((a, j) => row.forEach((b, k) => matrix[j][k] += weights[i] * a * b)));
  return matrix;
}

function weightedSolve(rows: number[][], values: number[], weights: number[]): number[] | undefined {
  const a = normalMatrix(rows, weights);
  const b = Array(4).fill(0);
  rows.forEach((row, i) => row.forEach((value, j) => b[j] += weights[i] * value * values[i]));
  return solve4(a, b);
}

function solve4(a: number[][], b: number[]): number[] | undefined {
  const matrix = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    if (Math.abs(matrix[pivot][col]) < 1e-14) return undefined;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = matrix[row][col] / matrix[col][col];
      for (let k = 0; k <= 4; k++) matrix[row][k] -= factor * matrix[col][k];
    }
  }
  return matrix.map((row, i) => row[4] / row[i]);
}

function invert4(a: number[][]): number[][] | undefined {
  const matrix = a.map((row, index) => [...row, ...[0, 1, 2, 3].map((value) => value === index ? 1 : 0)]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    if (Math.abs(matrix[pivot][col]) < 1e-14) return undefined;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let k = 0; k < 8; k++) matrix[col][k] /= divisor;
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let k = 0; k < 8; k++) matrix[row][k] -= factor * matrix[col][k];
    }
  }
  return matrix.map((row) => row.slice(4));
}
