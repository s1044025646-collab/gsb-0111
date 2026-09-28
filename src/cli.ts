#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Repository } from "./db/repository.js";
import { AppError } from "./errors.js";
import {
  associateAll, calibrateStationClock, createModel, createStation, importSynthetic, locateEvent,
  pickSegment, publishSolution, reviewEvent
} from "./services.js";

const args = process.argv.slice(2);
const [command, ...rest] = args;
const dbPath = process.env.SEISMIC_DB ?? "./data/seismic.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const repo = new Repository(dbPath);
const now = Date.now();

function option(name: string, fallback?: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : fallback;
}

function print(title: string, value: unknown): void {
  console.log(`\n[${title}]`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function counts() {
  return {
    stations: (repo.db.prepare("SELECT COUNT(*) c FROM stations").get() as { c: number }).c,
    segments: (repo.db.prepare("SELECT COUNT(*) c FROM waveform_segments").get() as { c: number }).c,
    activePicks: (repo.db.prepare("SELECT COUNT(*) c FROM picks WHERE status<>'rejected'").get() as { c: number }).c,
    events: (repo.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c,
    stableSolutions: (repo.db.prepare("SELECT COUNT(*) c FROM location_solutions WHERE quality='stable'").get() as { c: number }).c
  };
}

try {
  print("before", counts());
  if (command === "init-model") {
    const result = createModel(repo, {
      name: option("name", "default-v1")!,
      pVelocityMps: Number(option("p", "5800")),
      vpVsRatio: Number(option("ratio", "1.73")),
      activate: option("activate", "true") !== "false"
    }, now);
    print("velocity model", result);
  } else if (command === "add-station") {
    const result = createStation(repo, {
      code: option("code")!,
      latitude: Number(option("lat")),
      longitude: Number(option("lon")),
      clockOffsetMs: Number(option("clock-offset", "0")),
      clockUncertaintyMs: Number(option("clock-error", "0"))
    }, now);
    print("station", result);
  } else if (command === "import-synthetic") {
    const event = option("event-key") ? {
      key: option("event-key")!,
      originTimeMs: Number(option("origin", String(now))),
      latitude: Number(option("lat", "0")),
      longitude: Number(option("lon", "0")),
      depthM: Number(option("depth", "10000"))
    } : null;
    const result = importSynthetic(repo, option("station")!, event, {
      durationMs: Number(option("duration", "60000")),
      pVelocityMps: Number(option("vp", "5800")),
      vpVsRatio: Number(option("ratio", "1.73")),
      seedBase: Number(option("seed", "42")),
      noiseOnly: option("noise-only", "false") === "true"
    }, now);
    print("imported", { segmentId: result.id, duplicated: result.duplicated, samples: result.segment.samples.length });
  } else if (command === "calibrate-clock") {
    const result = calibrateStationClock(repo, Number(option("station")), Number(option("offset", "0")), Number(option("uncertainty", "0")), option("reason", "manual calibration"), now);
    print("station clock", result);
  } else if (command === "pick") {
    const result = pickSegment(repo, Number(option("segment")), now, {});
    print("picks", result);
  } else if (command === "revise-pick") {
    const result = repo.revisePick(
      Number(option("pick")),
      Number(option("sample")),
      Number(option("uncertainty", "100")),
      (option("decision", "confirmed") as "confirmed" | "rejected" | "revised"),
      option("reason", "manual revision")!,
      option("reviewer", "operator")!,
      now
    );
    print("revised pick", result);
  } else if (command === "associate") {
    print("associations", associateAll(repo, now, Number(option("window", "5000"))));
  } else if (command === "locate") {
    print("solution", locateEvent(repo, Number(option("event")), option("model") ? Number(option("model")) : undefined, now));
  } else if (command === "explain") {
    const id = Number(option("solution"));
    const solution = repo.db.prepare("SELECT * FROM location_solutions WHERE id=?").get(id);
    const residuals = repo.db.prepare("SELECT * FROM solution_residuals WHERE solution_id=? ORDER BY ABS(residual_ms) DESC").all(id);
    print("residuals", { solution, residuals });
  } else if (command === "review") {
    print("event", reviewEvent(repo, Number(option("event")), option("decision") as "confirm", option("note", "")!, option("reviewer", "operator")!, now));
  } else if (command === "publish") {
    print("published", publishSolution(repo, Number(option("solution")), now));
  } else if (command === "show-event") {
    const id = Number(option("event"));
    print("event", { event: repo.getEvent(id), picks: repo.eventPicks(id), solutions: repo.db.prepare("SELECT id,quality,rejection_reason,published,input_hash FROM location_solutions WHERE event_id=? ORDER BY id").all(id) });
  } else if (command === "export-report") {
    const id = Number(option("event"));
    const event = repo.getEvent(id);
    const solutions = repo.db.prepare("SELECT * FROM location_solutions WHERE event_id=? ORDER BY id").all(id);
    const reviews = repo.db.prepare("SELECT * FROM reviews WHERE event_id=? ORDER BY id").all(id);
    print("report", { event, picks: repo.eventPicks(id), solutions, reviews });
  } else {
    console.log("Commands: init-model add-station calibrate-clock import-synthetic pick revise-pick associate locate explain review publish show-event export-report");
  }
  print("after", counts());
} catch (error) {
  print("error", { code: error instanceof AppError ? error.code : "INTERNAL", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  repo.close();
}
