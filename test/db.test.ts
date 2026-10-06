import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, saveAnalysis, getAnalysis, compareAnalyses } from '../src/db.js';
import { cross, vertical } from './fixtures.js';

const dir = join(tmpdir(), `hough-test-${process.pid}`);
const dbPath = join(dir, 'test.sqlite');
let db = openDatabase(dbPath);

before(() => {
  db = openDatabase(dbPath);
});

after(() => {
  db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发文件锁，忽略 */ }
});

test('保存后重新打开可完整复现报告', () => {
  const saved = saveAnalysis(db, cross, { thetaStepDeg: 15, rhoStep: 1 }, 'cross');
  db.close();
  db = openDatabase(dbPath);
  const loaded = getAnalysis(db, saved.id);
  assert.ok(loaded);
  if (!loaded) return;
  assert.deepEqual(loaded.matrix, cross);
  assert.deepEqual(loaded.cells, saved.cells);
  assert.equal(loaded.meta.totalVotes, saved.meta.totalVotes);
});

test('非法输入不写入任何记录', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number };
  assert.throws(() => saveAnalysis(db, [[1, 2]], { thetaStepDeg: 15, rhoStep: 1 }));
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number };
  assert.equal(afterCount.n, before.n);
});

test('不同分辨率比较只并排报告，不宣称原图变化', () => {
  const a = saveAnalysis(db, vertical, { thetaStepDeg: 15, rhoStep: 1 }, 'v15');
  const b = saveAnalysis(db, vertical, { thetaStepDeg: 30, rhoStep: 2 }, 'v30');
  const cmp = compareAnalyses(a, b, { minVotes: 1, limit: 10 });
  assert.ok(cmp.note.includes('不表示原始图像发生了变化'));
  assert.equal(cmp.a.thetaBins, 12);
  assert.equal(cmp.b.thetaBins, 6);
});

