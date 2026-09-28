import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      east_km REAL NOT NULL,
      north_km REAL NOT NULL,
      elevation_km REAL NOT NULL DEFAULT 0,
      clock_offset_sec REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS station_clock_logs (
      id INTEGER PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id),
      old_offset_sec REAL NOT NULL,
      new_offset_sec REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS velocity_models (
      id INTEGER PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      p_velocity_kms REAL NOT NULL CHECK (p_velocity_kms > 0),
      vp_vs_ratio REAL NOT NULL CHECK (vp_vs_ratio > 1),
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS waveform_segments (
      id INTEGER PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id),
      component TEXT NOT NULL,
      start_time_ms INTEGER NOT NULL,
      sample_rate_hz REAL NOT NULL CHECK (sample_rate_hz > 0),
      samples_json TEXT NOT NULL,
      seed TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS picks (
      id INTEGER PRIMARY KEY,
      segment_id INTEGER NOT NULL REFERENCES waveform_segments(id),
      station_id INTEGER NOT NULL REFERENCES stations(id),
      phase TEXT NOT NULL CHECK (phase IN ('P', 'S')),
      sample_index INTEGER NOT NULL CHECK (sample_index >= 0),
      time_ms INTEGER NOT NULL,
      uncertainty_sec REAL NOT NULL CHECK (uncertainty_sec > 0),
      method TEXT NOT NULL CHECK (method IN ('auto', 'manual')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'duplicate')),
      parent_pick_id INTEGER REFERENCES picks(id),
      superseded_by_pick_id INTEGER REFERENCES picks(id),
      duplicate_of_pick_id INTEGER REFERENCES picks(id),
      created_by TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seismic_events (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'located', 'rejected', 'reviewed')),
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_picks (
      event_id INTEGER NOT NULL REFERENCES seismic_events(id),
      pick_id INTEGER NOT NULL REFERENCES picks(id),
      PRIMARY KEY (event_id, pick_id)
    );

    CREATE TABLE IF NOT EXISTS location_solutions (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES seismic_events(id),
      velocity_model_id INTEGER NOT NULL REFERENCES velocity_models(id),
      origin_time_ms INTEGER,
      east_km REAL,
      north_km REAL,
      depth_km REAL,
      covariance_json TEXT NOT NULL,
      rms_residual_sec REAL,
      max_abs_residual_sec REAL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      rejection_reason TEXT NOT NULL DEFAULT '',
      input_snapshot_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      iterations INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES seismic_events(id),
      solution_id INTEGER REFERENCES location_solutions(id),
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'flagged')),
      reviewer TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_segments_station_start ON waveform_segments(station_id, start_time_ms);
    CREATE INDEX IF NOT EXISTS idx_picks_station_phase_time ON picks(station_id, phase, time_ms);
    CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
    CREATE INDEX IF NOT EXISTS idx_solutions_event ON location_solutions(event_id);
  `);
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
