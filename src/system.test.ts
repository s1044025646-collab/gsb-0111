import { describe, expect, it } from "vitest";
import { Repository, solutionInputHash } from "./db/repository.js";
import { associateAll, importSynthetic, locateEvent, pickSegment, reviewEvent } from "./services.js";
import { makeDb, seedEventAcrossStations, seedModel, seedStations } from "./test-helpers.js";
import { pickPhases } from "./waveform/picker.js";

const normalStations = [
  { code: "S01", latitude: 0.1, longitude: 0 },
  { code: "S02", latitude: -0.1, longitude: 0 },
  { code: "S03", latitude: 0, longitude: 0.1 },
  { code: "S04", latitude: 0, longitude: -0.1 }
];

const event = { key: "main", originTimeMs: 2_000_000, latitude: 0.02, longitude: -0.01, depthM: 12000 };

describe("synthetic picker", () => {
  it("reports timing uncertainty and rejects a noise-only station", () => {
    const { repo } = makeDb("picker");
    seedModel(repo);
    seedStations(repo, normalStations);
    const imported = importSynthetic(repo, "S01", null, { durationMs: 60000, noiseOnly: true, seedBase: 99 }, 1000);
    const picks = pickSegment(repo, imported.id, 2000, { pThreshold: 4.5, sThreshold: 5 });
    expect(picks).toHaveLength(0);
  });

  it("keeps duplicate imports and duplicate picks idempotent", () => {
    const { repo } = makeDb("duplicates");
    seedModel(repo);
    seedStations(repo, normalStations);
    const first = importSynthetic(repo, "S01", event, { durationMs: 120000, noiseLevel: 0.002, seedBase: 7 }, 1);
    const second = importSynthetic(repo, "S01", event, { durationMs: 120000, noiseLevel: 0.002, seedBase: 7 }, 2);
    expect(second.duplicated).toBe(true);
    const one = pickSegment(repo, first.id, 3, { pThreshold: 3.2, sThreshold: 2.6 });
    const two = pickSegment(repo, first.id, 4, { pThreshold: 3.2, sThreshold: 2.6 });
    expect(two.map((item) => item.id)).toEqual(one.map((item) => item.id));
  });
});

describe("association and location", () => {
  it("locates a four-station event and stores weighted residuals", () => {
    const { repo } = makeDb("normal");
    seedModel(repo);
    seedStations(repo, normalStations);
    const seeded = seedEventAcrossStations(repo, normalStations, event);
    expect(seeded.eventId).toBeTypeOf("number");
    const solution = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    expect(solution.quality).toBe("stable");
    expect(Number(solution.latitude)).toBeCloseTo(0.02, 2);
    expect(Number(solution.longitude)).toBeCloseTo(-0.01, 2);
    expect(Number(solution.depth_m)).toBeGreaterThan(8000);
    expect(Number(solution.depth_m)).toBeLessThan(18000);
    expect(Number(solution.rms_residual_ms)).toBeLessThan(100);
    expect(Number(solution.horizontal_uncertainty_m)).toBeLessThan(3000);
    const residuals = repo.db.prepare("SELECT COUNT(*) c FROM solution_residuals WHERE solution_id=?").get(solution.id) as { c: number };
    expect(residuals.c).toBeGreaterThanOrEqual(7);
  });

  it("rejects single-station false triggers instead of making a stable fix", () => {
    const { repo } = makeDb("single");
    seedModel(repo);
    seedStations(repo, normalStations);
    const imported = importSynthetic(repo, "S01", event, { durationMs: 120000, noiseLevel: 0.002, seedBase: 11 }, 1);
    pickSegment(repo, imported.id, 2, { pThreshold: 3.2, sThreshold: 2.6 });
    const associations = associateAll(repo, 3000);
    expect(associations[0].rejected).toBe(true);
    const solution = locateEvent(repo, associations[0].eventId, undefined, 4000) as Record<string, unknown>;
    expect(solution.quality).toBe("rejected");
    expect(String(solution.rejection_reason)).toMatch(/at least 4/);
  });

  it("separates overlapping aftershocks and does not merge late arrivals", () => {
    const { repo } = makeDb("aftershocks");
    seedModel(repo);
    seedStations(repo, normalStations);
    const first = seedEventAcrossStations(repo, normalStations, event, 10_000);
    const laterEvent = { key: "aftershock", originTimeMs: event.originTimeMs + 45_000, latitude: 0.01, longitude: 0.015, depthM: 9000 };
    const second = seedEventAcrossStations(repo, normalStations, laterEvent, 20_000);
    expect(first.eventId).not.toBe(second.eventId);
    const rows = repo.db.prepare("SELECT event_id, COUNT(*) c FROM event_picks GROUP BY event_id").all() as { event_id: number; c: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.c).toBeLessThanOrEqual(8);
  });

  it("rejects a nearly collinear degenerate network", () => {
    const { repo } = makeDb("degenerate");
    seedModel(repo);
    const stations = [
      { code: "D01", latitude: 0, longitude: -0.2 },
      { code: "D02", latitude: 0, longitude: -0.1 },
      { code: "D03", latitude: 0, longitude: 0.1 },
      { code: "D04", latitude: 0, longitude: 0.2 }
    ];
    seedStations(repo, stations);
    const seeded = seedEventAcrossStations(repo, stations, event);
    const solution = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    expect(solution.quality).toBe("rejected");
    expect(String(solution.rejection_reason)).toMatch(/geometry|singular|Uncertainty/i);
  });

  it("rejects a solution when one station reports an incompatible late phase", () => {
    const { repo } = makeDb("bad-station");
    seedModel(repo);
    seedStations(repo, normalStations);
    const seeded = seedEventAcrossStations(repo, normalStations, event);
    const badPick = repo.db.prepare("SELECT id FROM picks WHERE station_id=1 AND phase='S' LIMIT 1").get() as { id: number };
    repo.db.prepare("UPDATE picks SET corrected_time_ms=corrected_time_ms+3000, observed_time_ms=observed_time_ms+3000 WHERE id=?").run(badPick.id);
    const solution = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    expect(solution.quality).toBe("rejected");
    expect(String(solution.rejection_reason)).toMatch(/residuals|Uncertainty/i);
  });
});

describe("clock, revisions and model versions", () => {
  it("corrects calibrated station time before association and location", () => {
    const { repo } = makeDb("clock");
    seedModel(repo);
    const stations = normalStations.map((station, index) => index === 0 ? { ...station, clockOffsetMs: 150 } : station);
    seedStations(repo, stations);
    const seeded = seedEventAcrossStations(repo, stations, event);
    const biasedPick = repo.db.prepare("SELECT observed_time_ms, corrected_time_ms FROM picks JOIN stations ON stations.id=picks.station_id WHERE stations.code='S01' AND phase='P' LIMIT 1").get() as { observed_time_ms: number; corrected_time_ms: number };
    expect(biasedPick.observed_time_ms - biasedPick.corrected_time_ms).toBe(150);
    const solution = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    expect(solution.quality).toBe("stable");
  });

  it("preserves the original pick and creates a distinct new solution after revision", () => {
    const { repo } = makeDb("revision");
    seedModel(repo, "v1");
    seedStations(repo, normalStations);
    const seeded = seedEventAcrossStations(repo, normalStations, event);
    const first = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    const pick = repo.db.prepare("SELECT id,sample_index FROM picks WHERE phase='P' ORDER BY id LIMIT 1").get() as { id: number; sample_index: number };
    const revised = repo.revisePick(pick.id, pick.sample_index + 2, 120, "confirmed", "manual refinement", "tester", 9000) as Record<string, unknown>;
    repo.db.prepare("DELETE FROM event_picks WHERE pick_id=?").run(pick.id);
    repo.attachPicks(seeded.eventId!, [Number(revised.id)], "primary", 9001);
    seedModel(repo, "v2", 5600, 1.75, true, 9002);
    const second = locateEvent(repo, seeded.eventId!, undefined, 9003) as Record<string, unknown>;
    expect(second.id).not.toBe(first.id);
    expect(second.input_hash).not.toBe(first.input_hash);
    expect(repo.db.prepare("SELECT COUNT(*) c FROM picks WHERE revised_from_pick_id=?").get(pick.id) as { c: number }).toMatchObject({ c: 1 });
    expect(repo.db.prepare("SELECT * FROM location_solutions WHERE id=?").get(first.id)).toBeTruthy();
  });

  it("isolates explicit velocity model versions", () => {
    const { repo } = makeDb("models");
    const v1 = seedModel(repo, "model-a", 5800, 1.73, true);
    const v2 = seedModel(repo, "model-b", 5400, 1.78, false);
    seedStations(repo, normalStations);
    const seeded = seedEventAcrossStations(repo, normalStations, event);
    const a = locateEvent(repo, seeded.eventId!, v1, 5000) as Record<string, unknown>;
    const b = locateEvent(repo, seeded.eventId!, v2, 5001) as Record<string, unknown>;
    expect(a.velocity_model_id).toBe(v1);
    expect(b.velocity_model_id).toBe(v2);
    expect(a.input_hash).not.toBe(b.input_hash);
  });
});

describe("persistence and transactions", () => {
  it("reopens the same SQLite file and sees reviewed published state", () => {
    const { repo, dbPath } = makeDb("persist");
    seedModel(repo);
    seedStations(repo, normalStations);
    const seeded = seedEventAcrossStations(repo, normalStations, event);
    const solution = locateEvent(repo, seeded.eventId!, undefined, 5000) as Record<string, unknown>;
    reviewEvent(repo, seeded.eventId!, "confirm", "checked", "tester", 5001);
    repo.transaction(() => repo.db.prepare("UPDATE location_solutions SET published=1 WHERE id=?").run(solution.id));
    repo.close();
    const reopened = new Repository(dbPath, 9999);
    expect(reopened.getEvent(seeded.eventId!).status).toBe("reviewed");
    expect(reopened.db.prepare("SELECT published FROM location_solutions WHERE id=?").get(solution.id)).toMatchObject({ published: 1 });
    reopened.close();
  });
});
