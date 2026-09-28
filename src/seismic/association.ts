import { bearingWeights } from "../util/geo.js";

export type PickRow = Record<string, number | string>;

export interface AssociatedEvent {
  eventKey: string;
  pickIds: number[];
  stationCodes: string[];
  rejected: boolean;
  reason?: string;
}

export interface AssociationOptions {
  eventWindowMs?: number;
  spMinMs?: number;
  spMaxMs?: number;
  minStations?: number;
}

export function associatePicks(picks: PickRow[], stationsById: Map<number, Record<string, unknown>>, options: AssociationOptions = {}): AssociatedEvent[] {
  const usable = picks.filter((pick) => pick.status !== "rejected");
  const pPicks = usable.filter((pick) => pick.phase === "P").sort((a, b) => Number(a.corrected_time_ms) - Number(b.corrected_time_ms));
  const sPicks = usable.filter((pick) => pick.phase === "S");
  const assignedS = new Set<number>();
  const events: AssociatedEvent[] = [];
  const usedP = new Set<number>();
  const window = options.eventWindowMs ?? 5000;

  for (const seed of pPicks) {
    if (usedP.has(Number(seed.id))) continue;
    const seedTime = Number(seed.corrected_time_ms);
    const groupP = pPicks.filter((pick) => {
      if (usedP.has(Number(pick.id))) return false;
      const time = Number(pick.corrected_time_ms);
      return time >= seedTime - 500 && time <= seedTime + window;
    });

    const byStation = new Map<number, PickRow>();
    for (const pick of groupP) {
      const stationId = Number(pick.station_id);
      const current = byStation.get(stationId);
      if (!current || Math.abs(Number(pick.corrected_time_ms) - seedTime) < Math.abs(Number(current.corrected_time_ms) - seedTime)) {
        byStation.set(stationId, pick);
      }
    }
    const chosenP = [...byStation.values()];
    chosenP.forEach((pick) => usedP.add(Number(pick.id)));

    const groupIds = chosenP.map((pick) => Number(pick.id));
    for (const pPick of chosenP) {
      const stationId = Number(pPick.station_id);
      const pTime = Number(pPick.corrected_time_ms);
      const candidates = sPicks
        .filter((pick) => !assignedS.has(Number(pick.id)) && Number(pick.station_id) === stationId)
        .map((pick) => ({ pick, delta: Number(pick.corrected_time_ms) - pTime }))
        .filter((item) => item.delta >= (options.spMinMs ?? 120) && item.delta <= (options.spMaxMs ?? 20000))
        .sort((a, b) => a.delta - b.delta);
      const match = candidates[0];
      if (match) {
        assignedS.add(Number(match.pick.id));
        groupIds.push(Number(match.pick.id));
      }
    }

    const stationCodes = [...new Set(chosenP.map((pick) => String(stationsById.get(Number(pick.station_id))?.code ?? Number(pick.station_id))))];
    const rejected = stationCodes.length < (options.minStations ?? 3);
    const event: AssociatedEvent = {
      eventKey: `evt-${seedTime}-${[...stationCodes].sort().join("-")}`,
      pickIds: groupIds.sort((a, b) => a - b),
      stationCodes,
      rejected
    };
    if (rejected) event.reason = `Only ${stationCodes.length} station(s); at least ${options.minStations ?? 3} required`;
    events.push(event);
  }

  for (const pick of sPicks) {
    if (!assignedS.has(Number(pick.id))) {
      events.push({
        eventKey: `unassociated-s-${pick.id}`,
        pickIds: [Number(pick.id)],
        stationCodes: [String(stationsById.get(Number(pick.station_id))?.code ?? Number(pick.station_id))],
        rejected: true,
        reason: "S phase has no compatible P arrival"
      });
    }
  }
  return events;
}

export function geometryCheck(stations: Array<{ latitude: number; longitude: number }>, lat: number, lon: number): string | undefined {
  const geometry = bearingWeights(stations, lat, lon);
  if (geometry.condition > 0.72) return "Degenerate station geometry; azimuthal coverage is insufficient";
  return undefined;
}
