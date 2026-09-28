import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./server.js";
import { Repository } from "../db/repository.js";

describe("HTTP API", () => {
  let repo: Repository;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    repo = new Repository(":memory:");
    server = createApp({ repo, now: () => 1_700_000_000_000 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
  });

  async function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  it("returns health and validation error codes", async () => {
    const health = await request("GET", "/health");
    expect(health.status).toBe(200);
    const invalid = await request("POST", "/stations", { code: "!", latitude: 200, longitude: 0 });
    expect(invalid.status).toBe(400);
    expect((invalid.json.error as { code: string }).code).toBe("VALIDATION");
  });

  it("creates stations and paginates deterministic results", async () => {
    for (const index of [1, 2]) {
      const response = await request("POST", "/stations", { code: `A0${index}`, latitude: index, longitude: index });
      expect(response.status).toBe(201);
    }
    const page = await request("GET", "/stations?limit=1&page=1");
    expect(page.status).toBe(200);
    expect(page.json.limit).toBe(1);
    expect(page.json.data).toHaveLength(1);
    expect(page.json.hasMore).toBe(true);
  });

  it("calibrates a station clock and validates the reason", async () => {
    await request("POST", "/stations", { code: "C01", latitude: 1, longitude: 1 });
    const invalid = await request("POST", "/stations/1/clock", { clockOffsetMs: 100, clockUncertaintyMs: 10, reason: "" });
    expect(invalid.status).toBe(400);
    const saved = await request("POST", "/stations/1/clock", { clockOffsetMs: 100, clockUncertaintyMs: 10, reason: "NTP calibration" });
    expect(saved.status).toBe(200);
    expect(saved.json.clock_offset_ms).toBe(100);
  });

  it("runs synthetic import, picks, association and rejected single-station location over HTTP", async () => {
    await request("POST", "/velocity-models", { name: "api-v1", pVelocityMps: 5800, vpVsRatio: 1.73, activate: true });
    await request("POST", "/stations", { code: "A01", latitude: 0.1, longitude: 0 });
    const imported = await request("POST", "/segments/synthetic", {
      stationCode: "A01",
      eventKey: "api-one",
      originTimeMs: 3_000_000,
      latitude: 0.02,
      longitude: -0.01,
      depthM: 12000,
      options: { durationMs: 120000, noiseLevel: 0.002, seedBase: 55 }
    });
    expect(imported.status).toBe(201);
    const segmentId = (imported.json.id as number);
    const picks = await request("POST", `/segments/${segmentId}/picks`, { pThreshold: 3.2, sThreshold: 2.6 });
    expect(picks.status).toBe(201);
    const invalidRevision = await request("POST", "/picks/999/revision", {
      sampleIndex: 10,
      timeUncertaintyMs: 100,
      status: "confirmed",
      reason: "manual",
      reviewer: "operator"
    });
    expect(invalidRevision.status).toBe(404);
    const associations = await request("POST", "/events/associate", {});
    expect(associations.status).toBe(201);
    const eventId = (associations.json as unknown as { eventId: number }[])[0].eventId;
    const solution = await request("POST", `/events/${eventId}/locate`, {});
    expect(solution.status).toBe(201);
    expect(solution.json.quality).toBe("rejected");
    const explanation = await request("GET", `/solutions/${solution.json.id}`);
    expect(explanation.status).toBe(200);
    expect(explanation.json.interpretation).toMatchObject({ acceptable: false });
  });
});
