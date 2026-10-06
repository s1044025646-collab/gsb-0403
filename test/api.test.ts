import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api";
import { Store } from "../src/store";
import { AddressInfo } from "node:net";

async function withServer(
  fn: (base: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hough-test-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, dbPath);
  } finally {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function post(base: string, p: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base: string, p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p);
  return { status: res.status, json: await res.json() };
}

const vertical = Array.from({ length: 6 }, () => [0, 0, 1, 0, 0, 0]);

test("create analysis, query candidates, slice, points, export, persistence", async () => {
  await withServer(async (base, dbPath) => {
    const created = await post(base, "/api/analyses", {
      matrix: vertical,
      thetaStepDeg: 90,
      rhoStep: 1,
      note: "vertical x=2",
    });
    assert.equal(created.status, 201);
    const id = created.json.meta.id;
    assert.equal(created.json.meta.edgeCount, 6);
    assert.equal(created.json.meta.totalVotes, 12);
    assert.equal(created.json.candidates[0].thetaDeg, 0);
    assert.equal(created.json.candidates[0].rho, 2);
    assert.equal(created.json.candidates[0].votes, 6);

    const slice = await get(base, `/api/analyses/${id}/slice?thetaIdx=0`);
    assert.equal(slice.status, 200);
    const peak = slice.json.cells.find((c: any) => c.rhoIdx === 2);
    assert.equal(peak.votes, 6);

    const pts = await get(base, `/api/analyses/${id}/cells/0/2/points?offset=1&limit=3`);
    assert.equal(pts.status, 200);
    assert.equal(pts.json.totalPoints, 6);
    assert.equal(pts.json.points.length, 3);
    assert.deepEqual(pts.json.points[0], { x: 2, y: 1 });

    const exp = await get(base, `/api/analyses/${id}/export`);
    assert.equal(exp.json.format, "hough-edge-analysis/1");
    assert.ok(Array.isArray(exp.json.votes));

    // Reopen the database: the report is reproducible after restart.
    const store2 = new Store(dbPath);
    const meta = store2.getMeta(id);
    assert.equal(meta.edgeCount, 6);
    assert.equal(store2.getCandidates(id, 1, 1)[0].votes, 6);
    store2.close();
  });
});

test("invalid requests return error codes and leave no partial state", async () => {
  await withServer(async (base, dbPath) => {
    const bad1 = await post(base, "/api/analyses", { matrix: [[1, 2]], thetaStepDeg: 90, rhoStep: 1 });
    assert.equal(bad1.status, 400);
    assert.equal(bad1.json.error.code, "INVALID_MATRIX");

    const bad2 = await post(base, "/api/analyses", { matrix: [[1]], thetaStepDeg: 7, rhoStep: 1 });
    assert.equal(bad2.json.error.code, "INVALID_GRID");

    const bad3 = await post(base, "/api/analyses", { matrix: [[1]], thetaStepDeg: 90, rhoStep: -1 });
    assert.equal(bad3.json.error.code, "INVALID_GRID");

    const bad4 = await post(base, "/api/analyses", { matrix: [[1]], thetaStepDeg: 90, rhoStep: "x" });
    assert.equal(bad4.json.error.code, "INVALID_GRID");

    const big = Array.from({ length: 300 }, () => Array.from({ length: 300 }, () => 1));
    const bad5 = await post(base, "/api/analyses", { matrix: big, thetaStepDeg: 1, rhoStep: 1 });
    assert.equal(bad5.status, 413);
    assert.equal(bad5.json.error.code, "BUDGET_EXCEEDED");

    const missing = await get(base, "/api/analyses/999");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "NOT_FOUND");

    const list = await get(base, "/api/analyses");
    assert.equal(list.json.analyses.length, 0); // nothing half-saved

    const store2 = new Store(dbPath);
    assert.equal(store2.listAnalyses().length, 0);
    store2.close();
  });
});

test("compare endpoint returns both analyses with caveat", async () => {
  await withServer(async (base) => {
    const a = await post(base, "/api/analyses", { matrix: vertical, thetaStepDeg: 90, rhoStep: 1 });
    const b = await post(base, "/api/analyses", { matrix: vertical, thetaStepDeg: 90, rhoStep: 0.5 });
    const cmp = await get(base, `/api/analyses/${a.json.meta.id}/compare?with=${b.json.meta.id}`);
    assert.equal(cmp.status, 200);
    assert.equal(cmp.json.a.meta.rhoStep, 1);
    assert.equal(cmp.json.b.meta.rhoStep, 0.5);
    assert.ok(cmp.json.caveat.length > 0);
  });
});
