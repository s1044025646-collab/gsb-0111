import type { Database } from "better-sqlite3";

export const SCHEMA_VERSION = 1;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_m REAL NOT NULL DEFAULT 0,
    clock_offset_ms REAL NOT NULL DEFAULT 0,
    clock_uncertainty_ms REAL NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS station_clock_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    offset_ms REAL NOT NULL,
    uncertainty_ms REAL NOT NULL,
    changed_at_ms INTEGER NOT NULL,
    reason TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS velocity_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    p_velocity_mps REAL NOT NULL,
    vp_vs_ratio REAL NOT NULL,
    created_at_ms INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS waveform_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    start_ms INTEGER NOT NULL,
    sample_rate_hz REAL NOT NULL,
    samples TEXT NOT NULL,
    synthetic_event_key TEXT,
    noise_seed INTEGER NOT NULL,
    imported_at_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(station_id, start_ms, content_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL REFERENCES waveform_segments(id),
    station_id INTEGER NOT NULL REFERENCES stations(id),
    phase TEXT NOT NULL CHECK(phase IN ('P','S')),
    sample_index INTEGER NOT NULL,
    observed_time_ms INTEGER NOT NULL,
    corrected_time_ms INTEGER NOT NULL,
    time_uncertainty_ms REAL NOT NULL,
    amplitude REAL,
    status TEXT NOT NULL DEFAULT 'automatic' CHECK(status IN ('automatic','confirmed','rejected','revised')),
    created_at_ms INTEGER NOT NULL,
    revised_from_pick_id INTEGER REFERENCES picks(id),
    revision_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pick_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id INTEGER NOT NULL REFERENCES picks(id),
    old_sample_index INTEGER,
    new_sample_index INTEGER NOT NULL,
    old_uncertainty_ms REAL,
    new_uncertainty_ms REAL NOT NULL,
    old_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    reason TEXT NOT NULL,
    revised_at_ms INTEGER NOT NULL,
    revised_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','located','reviewed','published','rejected')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_picks (
    event_id INTEGER NOT NULL REFERENCES events(id),
    pick_id INTEGER NOT NULL REFERENCES picks(id),
    associated_at_ms INTEGER NOT NULL,
    association_role TEXT NOT NULL DEFAULT 'primary' CHECK(association_role IN ('primary','late')),
    PRIMARY KEY(event_id, pick_id)
  )`,
  `CREATE TABLE IF NOT EXISTS location_solutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    velocity_model_id INTEGER NOT NULL REFERENCES velocity_models(id),
    input_hash TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    depth_m REAL NOT NULL,
    origin_time_ms INTEGER NOT NULL,
    rms_residual_ms REAL NOT NULL,
    max_abs_residual_ms REAL NOT NULL,
    horizontal_uncertainty_m REAL NOT NULL,
    depth_uncertainty_m REAL NOT NULL,
    origin_time_uncertainty_ms REAL NOT NULL,
    quality TEXT NOT NULL CHECK(quality IN ('stable','rejected')),
    rejection_reason TEXT,
    created_at_ms INTEGER NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_id, input_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS solution_residuals (
    solution_id INTEGER NOT NULL REFERENCES location_solutions(id),
    pick_id INTEGER NOT NULL REFERENCES picks(id),
    observed_ms INTEGER NOT NULL,
    predicted_ms INTEGER NOT NULL,
    residual_ms REAL NOT NULL,
    PRIMARY KEY(solution_id, pick_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    solution_id INTEGER REFERENCES location_solutions(id),
    decision TEXT NOT NULL CHECK(decision IN ('confirm','reject','needs_revision')),
    note TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    reviewed_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_picks_time ON picks(corrected_time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_picks_station_phase ON picks(station_id, phase, corrected_time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_event_picks_pick ON event_picks(pick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_solutions_event ON location_solutions(event_id, created_at_ms)`
];

export function migrate(db: Database, now: number): void {
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )`);
    const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta").get() as { version: number };
    if (row.version > SCHEMA_VERSION) {
      throw new Error(`Database is from unsupported schema version ${row.version}`);
    }
    for (const sql of statements) db.exec(sql);
    db.prepare("INSERT OR IGNORE INTO schema_meta(version, applied_at_ms) VALUES (?, ?)").run(SCHEMA_VERSION, now);
  });
  tx.immediate();
}
