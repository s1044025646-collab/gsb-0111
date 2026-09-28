# Synthetic Seismic Phase Picking and Location Backend

Local Windows-compatible TypeScript/Node.js backend for fictional seismic data. It provides an HTTP API, CLI, deterministic synthetic waveform generator, SQLite persistence, and automated tests. It does not include a web UI and never connects to a real seismic network.

## Requirements

- Node.js 22+ (developed and verified with Node.js 25)
- npm

## Install

```powershell
npm install
```

## Run Tests

```powershell
npm test
npm run build
```

Tests inject deterministic clocks and random seeds. They cover normal multi-station events, single-station false triggers, overlapping aftershocks, clock corrections, disabled/bad stations, collinear/degenerate networks, repeated reports, pick revisions, velocity-model version isolation, failure paths, transaction writes, and persistence after process restart.

## Start and Stop the API

```powershell
npm start
```

The server listens only on `127.0.0.1` and asks Windows/Node.js for a free ephemeral port. The chosen URL and SQLite path are printed at startup. Stop it with `Ctrl+C` in the terminal.

Override the database path when needed:

```powershell
$env:SEISMIC_DB='./data/local.sqlite'
npm start
```

Migrations run automatically and are idempotent, so startup is repeatable against an existing database.

## Repeatable End-to-End Demo

```powershell
npm run demo
```

The demo recreates `data/demo.sqlite`, builds four fictional stations and a constant-velocity model, generates seeded waveforms, picks P/S phases, associates one event, locates it, publishes the solution, and prints the event report.

## CLI

Prefix every CLI command with the selected database:

```powershell
$env:SEISMIC_DB='./data/cli.sqlite'
```

Common commands:

```powershell
npm run cli -- init --model v1 --p 6 --ratio 1.73
npm run cli -- station --code AAA --east 0 --north 0
npm run cli -- clock --station 1 --offset 2.5 --reason "NTP calibration"
npm run cli -- import-synthetic --station 1 --seed 101 --p 6.46 --s 11.18 --rate 50
npm run cli -- pick --segment 1
npm run cli -- associate --publish
npm run cli -- relocate --event 1
npm run cli -- review --event 1 --decision approved --reviewer operator --note "checked residuals"
npm run cli -- report --event 1
```

State-changing commands print before/after counts or clock/solution state.

## Data and Reproducibility

- Raw waveform samples are stored unchanged.
- Automatic and manual picks are retained; revisions supersede rather than overwrite earlier picks.
- Duplicate reports are recorded as duplicates and do not create extra active arrivals.
- Station clock offsets are calibrated separately and stored with audit logs.
- Each location solution stores its velocity model and complete input snapshot. Changing a pick or model creates a new solution; older published results can still be replayed from their original snapshot.
- Insufficient stations, collinear geometry, unstable uncertainty, and excessive RMS/maximum residuals produce rejected solutions instead of fabricated stable events.

## Main API Routes

- `GET /health`
- `GET|POST /stations`
- `GET|POST /models`
- `GET /segments`
- `POST /segments/synthetic`
- `GET /picks`
- `POST /picks/auto`
- `POST /picks/manual`
- `POST /picks/revise`
- `POST /associate`
- `GET /events?page=1&limit=50`
- `POST /events/relocate`
- `POST /solutions/replay`
- `POST /reviews`
- `GET /events/:id/report`

Invalid input returns `VALIDATION_ERROR`, missing resources return `NOT_FOUND`, and paginated collection responses include `page`, `limit`, and `items`.
