export type PhaseLabel = 'P' | 'S';

export interface LocationObservation {
  pickId: number;
  stationId: number;
  stationCode: string;
  eastKm: number;
  northKm: number;
  elevationKm: number;
  phase: PhaseLabel;
  correctedTimeMs: number;
  uncertaintySec: number;
  velocityKms: number;
}

export interface LocationResult {
  status: 'accepted' | 'rejected';
  rejectionReason?: string;
  originTimeMs?: number;
  eastKm?: number;
  northKm?: number;
  depthKm?: number;
  covariance: number[][];
  rmsResidualSec?: number;
  maxAbsResidualSec?: number;
  iterations: number;
  residuals: Array<{ pickId: number; stationCode: string; phase: PhaseLabel; residualSec: number }>;
}

interface Hypocenter { originSec: number; eastKm: number; northKm: number; depthKm: number }

const maxIterations = 40;

export function locate(observations: readonly LocationObservation[]): LocationResult {
  const emptyResiduals: LocationResult['residuals'] = [];
  if (observations.length < 4) return reject('INSUFFICIENT_OBSERVATIONS', 'at least four P/S observations are required', emptyResiduals);
  const stationCount = new Set(observations.map((item) => item.stationId)).size;
  if (stationCount < 3) return reject('INSUFFICIENT_STATIONS', 'at least three enabled stations are required', emptyResiduals);
  if (!observations.some((item) => item.phase === 'P')) return reject('NO_P_PHASE', 'at least one P arrival is required', emptyResiduals);
  const geometry = assessGeometry(observations);
  if (!geometry.ok) return reject('DEGENERATE_GEOMETRY', geometry.reason ?? 'station geometry is degenerate', emptyResiduals);

  const initial = gridInitial(observations);
  let current = initial;
  let jacobian: number[][] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const update = normalEquations(observations, current);
    jacobian = update.jacobian;
    const scales = [Math.sqrt(Math.max(1e-12, update.matrix[0][0])), Math.sqrt(Math.max(1e-12, update.matrix[1][1])), Math.sqrt(Math.max(1e-12, update.matrix[2][2])), Math.sqrt(Math.max(1e-12, update.matrix[3][3]))];
    const scaledMatrix = update.matrix.map((row, rowIndex) => row.map((value, columnIndex) => value / (scales[rowIndex] * scales[columnIndex]) + (rowIndex === columnIndex ? 1e-8 : 0)));
    const scaledVector = update.vector.map((value, index) => value / scales[index]);
    const scaledStep = solve4(scaledMatrix, scaledVector);
    if (!scaledStep) return reject('DEGENERATE_GEOMETRY', 'location normal equations are singular', update.residuals);
    const step = scaledStep.map((value, index) => value / scales[index]);
    const stepScale = 1;
    current = {
      originSec: current.originSec + step[0] * stepScale,
      eastKm: current.eastKm + step[1] * stepScale,
      northKm: current.northKm + step[2] * stepScale,
      depthKm: Math.max(0.02, current.depthKm + step[3] * stepScale),
    };
    if (step.slice(1).every((value) => Math.abs(value) < 0.002) && Math.abs(step[0]) < 2) break;
  }

  const final = normalEquations(observations, current);
  jacobian = final.jacobian;
  const rms = Math.sqrt(final.residuals.reduce((sum, item) => sum + item.residualSec ** 2, 0) / final.residuals.length);
  const maxAbs = Math.max(...final.residuals.map((item) => Math.abs(item.residualSec)));
  if (rms > 0.75) return reject('LARGE_RMS_RESIDUAL', `rms residual ${rms.toFixed(3)}s exceeds 0.750s`, final.residuals, current, rms, maxAbs);
  if (maxAbs > 1.5) return reject('LARGE_RESIDUAL', `maximum residual ${maxAbs.toFixed(3)}s exceeds 1.500s`, final.residuals, current, rms, maxAbs);
  const covariance = covarianceFromNormal(final.matrix, jacobian, observations, rms);
  const horizontalSigma = Math.sqrt(Math.max(covariance[1][1], covariance[2][2]));
  const depthSigma = Math.sqrt(Math.max(0, covariance[3][3]));
  if (!Number.isFinite(horizontalSigma + depthSigma) || horizontalSigma > 30 || depthSigma > 40) {
    return reject('UNSTABLE_UNCERTAINTY', 'formal uncertainty is too large for a stable release', final.residuals, current, rms, maxAbs, covariance);
  }
  return {
    status: 'accepted',
    originTimeMs: Math.round(current.originSec * 1000),
    eastKm: Number(current.eastKm.toFixed(3)),
    northKm: Number(current.northKm.toFixed(3)),
    depthKm: Number(current.depthKm.toFixed(3)),
    covariance,
    rmsResidualSec: Number(rms.toFixed(4)),
    maxAbsResidualSec: Number(maxAbs.toFixed(4)),
    iterations: maxIterations,
    residuals: final.residuals.map((item) => ({ ...item, residualSec: Number(item.residualSec.toFixed(4)) })),
  };
}

function reject(reason: string, message: string, residuals: LocationResult['residuals'], solution?: Hypocenter, rms?: number, maxAbs?: number, covariance = eye4()): LocationResult {
  return {
    status: 'rejected',
    rejectionReason: `${reason}: ${message}`,
    originTimeMs: solution ? Math.round(solution.originSec * 1000) : undefined,
    eastKm: solution?.eastKm,
    northKm: solution?.northKm,
    depthKm: solution?.depthKm,
    covariance,
    rmsResidualSec: rms,
    maxAbsResidualSec: maxAbs,
    iterations: solution ? maxIterations : 0,
    residuals,
  };
}

function predict(observation: LocationObservation, hypothesis: Hypocenter) {
  const horizontal = Math.hypot(hypothesis.eastKm - observation.eastKm, hypothesis.northKm - observation.northKm);
  const vertical = hypothesis.depthKm + observation.elevationKm;
  const distance = Math.sqrt(horizontal ** 2 + vertical ** 2);
  const travelSec = distance / observation.velocityKms;
  return { timeMs: hypothesis.originSec + travelSec, distance, travelSec };
}

export function gridInitial(observations: readonly LocationObservation[]): Hypocenter {
  const east = average(observations.map((item) => item.eastKm));
  const north = average(observations.map((item) => item.northKm));
  const fastest = Math.max(...observations.map((item) => item.velocityKms));
  let best: Hypocenter = { originSec: 0, eastKm: east, northKm: north, depthKm: 5 };
  let bestScore = Infinity;
  for (let eastOffset = -20; eastOffset <= 20; eastOffset += 10) {
    for (let northOffset = -20; northOffset <= 20; northOffset += 10) {
      for (const depthKm of [0, 2, 5, 8, 12, 20, 35, 60]) {
        const hypothesis = { originSec: best.originSec, eastKm: east + eastOffset, northKm: north + northOffset, depthKm };
        const predicted = observations.map((item) => predict(item, hypothesis).travelSec);
        const observed = observations.map((item) => item.correctedTimeMs);
        hypothesis.originSec = average(observed.map((time, index) => time / 1000 - predicted[index]));
        const score = Math.sqrt(observations.reduce((sum, item, index) => {
          const residualSec = item.correctedTimeMs / 1000 - predict(item, hypothesis).timeMs;
          return sum + (residualSec / item.uncertaintySec) ** 2;
        }, 0) / observations.length) + Math.max(0, depthKm - 25) * 0.01;
        if (score < bestScore) {
          bestScore = score;
          best = hypothesis;
        }
      }
    }
  }
  void fastest;
  return best;
}

export function normalEquations(observations: readonly LocationObservation[], hypothesis: Hypocenter) {
  const matrix = zero4();
  const vector = [0, 0, 0, 0];
  const residuals = [];
  const jacobian: number[][] = [];
  for (const observation of observations) {
    const predicted = predict(observation, hypothesis);
    const residualSec = observation.correctedTimeMs / 1000 - predicted.timeMs;
    const horizontalX = hypothesis.eastKm - observation.eastKm;
    const horizontalY = hypothesis.northKm - observation.northKm;
    const vertical = hypothesis.depthKm + observation.elevationKm;
    const safeDistance = Math.max(0.001, predicted.distance);
    const derivative = [
      1,
      horizontalX / (safeDistance * observation.velocityKms),
      horizontalY / (safeDistance * observation.velocityKms),
      vertical / (safeDistance * observation.velocityKms),
    ];
    const weight = 1 / observation.uncertaintySec ** 2;
    for (let row = 0; row < 4; row += 1) {
      vector[row] += weight * derivative[row] * residualSec;
      for (let col = 0; col < 4; col += 1) matrix[row][col] += weight * derivative[row] * derivative[col];
    }
    jacobian.push(derivative.map((value) => value / observation.uncertaintySec));
    residuals.push({ pickId: observation.pickId, stationCode: observation.stationCode, phase: observation.phase, residualSec });
  }
  return { matrix, vector, residuals, jacobian };
}

function assessGeometry(observations: readonly LocationObservation[]): { ok: boolean; reason?: string } {
  const stations = new Map<number, { eastKm: number; northKm: number }>();
  for (const item of observations) if (!stations.has(item.stationId)) stations.set(item.stationId, { eastKm: item.eastKm, northKm: item.northKm });
  const points = [...stations.values()];
  if (points.length < 3) return { ok: false, reason: 'fewer than three distinct stations' };
  const east = average(points.map((point) => point.eastKm));
  const north = average(points.map((point) => point.northKm));
  let xx = 0, xy = 0, yy = 0;
  for (const point of points) {
    const x = point.eastKm - east;
    const y = point.northKm - north;
    xx += x * x; xy += x * y; yy += y * y;
  }
  const trace = Math.max(xx + yy, 1e-9);
  const determinant = Math.max(0, xx * yy - xy * xy);
  const eccentricity = Math.sqrt(1 - (4 * determinant) / trace ** 2);
  if (eccentricity > 0.985) return { ok: false, reason: 'station azimuths and offsets are nearly collinear' };
  const distances = points.flatMap((a, index) => points.slice(index + 1).map((b) => Math.hypot(a.eastKm - b.eastKm, a.northKm - b.northKm)));
  if (Math.max(...distances) < 2) return { ok: false, reason: 'station aperture is too small' };
  return { ok: true };
}

function covarianceFromNormal(normal: number[][], jacobian: number[][], observations: readonly LocationObservation[], rms: number): number[][] {
  const inverse = invert4(normal);
  if (!inverse) return eye4().map((row) => row.map(() => Number.POSITIVE_INFINITY));
  const dof = Math.max(1, observations.length - 4);
  const chiScale = observations.reduce((sum, item, index) => {
    const row = jacobian[index];
    void row;
    return sum;
  }, 0);
  void chiScale;
  const varianceScale = Math.max(1, rms ** 2 * observations.length / dof);
  return inverse.map((row) => row.map((value) => value * varianceScale));
}

function average(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length }
function zero4(): number[][] { return Array.from({ length: 4 }, () => [0, 0, 0, 0]); }
function eye4(): number[][] { return zero4().map((row, index) => row.map((_, column) => index === column ? 1 : 0)); }

function solve4(matrix: number[][], vector: number[]): number[] | null {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
  if (Math.abs(augmented[pivot][col]) < 1e-14) return null;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col] / augmented[col][col];
      for (let cursor = col; cursor <= 4; cursor += 1) augmented[row][cursor] -= factor * augmented[col][cursor];
    }
  }
  return augmented.map((row, index) => row[4] / row[index]);
}

function invert4(matrix: number[][]): number[][] | null {
  const augmented = matrix.map((row, index) => [...row, ...eye4()[index]]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
  if (Math.abs(augmented[pivot][col]) < 1e-14) return null;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = augmented[col][col];
    for (let cursor = 0; cursor < 8; cursor += 1) augmented[col][cursor] /= divisor;
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let cursor = 0; cursor < 8; cursor += 1) augmented[row][cursor] -= factor * augmented[col][cursor];
    }
  }
  return augmented.map((row) => row.slice(4));
}


