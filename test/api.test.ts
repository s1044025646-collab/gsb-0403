import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db.js';
import { createApiServer, listenWithFallback } from '../src/server.js';
import type { Server } from 'node:http';
import { cross } from './fixtures.js';

const dir = join(tmpdir(), `hough-api-${process.pid}`);
const dbPath = join(dir, 'api.sqlite');
let server: Server;
let base: string;

before(async () => {
  const db = openDatabase(dbPath);
  server = createApiServer({ db });
  const { port } = await listenWithFallback(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发文件锁，忽略 */ }
});

async function call(path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test('健康检查', async () => {
  const { status, body } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('完整 API 流程：创建->候选->支持点->切片->导出', async () => {
  const created = await call('/api/analyses', {
    method: 'POST',
    body: JSON.stringify({ matrix: cross, config: { thetaStepDeg: 15, rhoStep: 1 }, name: 'cross' }),
  });
  assert.equal(created.status, 200);
  const id = (created.body as { id: string }).id;

  const candidates = await call(`/api/analyses/${id}/candidates?minVotes=4&limit=10`);
  const cells = (candidates.body as { candidates: Array<{ votes: number }> }).candidates;
  assert.ok(cells.some((c) => c.votes === 4));

  const support = await call(`/api/analyses/${id}/cells/0/2/support?page=0&pageSize=2`);
  const sb = support.body as { total: number; points: unknown[] };
  assert.equal(sb.total, 4);
  assert.equal(sb.points.length, 2);

  const slice = await call(`/api/analyses/${id}/slices/6`);
  const sliceCells = (slice.body as { cells: Array<{ thetaIndex: number }> }).cells;
  assert.ok(sliceCells.every((c) => c.thetaIndex === 6));

  const exported = await call(`/api/analyses/${id}/export`);
  assert.equal(exported.status, 200);
});

test('非法矩阵返回 400 错误码且不落库', async () => {
  const bad = await call('/api/analyses', {
    method: 'POST',
    body: JSON.stringify({ matrix: [[1, 2]], config: { thetaStepDeg: 15, rhoStep: 1 } }),
  });
  assert.equal(bad.status, 400);
  assert.equal((bad.body.error as { code: string }).code, 'INVALID_MATRIX');

  const list = await call('/api/analyses');
  const analyses = (list.body as { analyses: unknown[] }).analyses;
  assert.equal(analyses.length, 1); // 只有前一个测试成功的 cross
});

test('不存在的分析返回 404', async () => {
  const r = await call('/api/analyses/nope');
  assert.equal(r.status, 404);
});

