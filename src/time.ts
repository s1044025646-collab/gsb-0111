export type Clock = () => number;

export const msPerSecond = 1000;

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * msPerSecond);
}

export function msToSeconds(ms: number): number {
  return ms / msPerSecond;
}
