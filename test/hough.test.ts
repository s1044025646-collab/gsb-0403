import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runHough,
  selectCandidates,
  supportPoints,
  angleSlice,
  pointwiseVotes,
  totalCellVotes,
  quantizeRho,
  validateMatrix,
  HoughError,
} from '../src/hough.js';
import {
  vertical,
  horizontal,
  cross,
  empty,
  single,
  allOnes,
  expected,
  roundingCases,
  verifyRoundingFixture,
  RHO_STEP,
  THETA_STEP,
} from './fixtures.js';

const cfg = { thetaStepDeg: THETA_STEP, rhoStep: RHO_STEP };

test('垂直线 x=2 在 theta=0 rho=2 聚票', () => {
  const r = runHough(vertical, cfg);
  const peak = r.cells.find((c) => c.thetaIndex === 0 && c.rhoIndex === 2);
  assert.ok(peak);
  if (!peak) return;
  assert.equal(peak.thetaDeg, 0);
  assert.equal(peak.rho, 2);
  assert.equal(peak.votes, expected.verticalPeak.votes);
});

test('水平线 y=3 在 theta=90 rho=3 聚票', () => {
  const r = runHough(horizontal, cfg);
  const peak = r.cells.find((c) => c.thetaIndex === 6 && c.rhoIndex === 3);
  assert.ok(peak);
  if (!peak) return;
  assert.equal(peak.thetaDeg, 90);
  assert.equal(peak.votes, 4);
});

test('交叉线共享交点分别投票', () => {
  const r = runHough(cross, cfg);
  const v = r.cells.find((c) => c.thetaIndex === 0 && c.rhoIndex === 2);
  const h = r.cells.find((c) => c.thetaIndex === 6 && c.rhoIndex === 3);
  assert.equal(v?.votes, 4);
  assert.equal(h?.votes, 4);
  // 共享交点必须同时出现在两条线的支持点中
  const vs = supportPoints(r, 0, 2).points;
  const hs = supportPoints(r, 6, 3).points;
  assert.ok(vs.some((p) => p.x === 2 && p.y === 3));
  assert.ok(hs.some((p) => p.x === 2 && p.y === 3));
  assert.equal(r.meta.edgePointCount, 7);
});

test('单点：每个角度格恰一票', () => {
  const r = runHough(single, cfg);
  assert.equal(totalCellVotes(r), 12);
  const perTheta = new Map<number, number>();
  for (const c of r.cells) perTheta.set(c.thetaIndex, (perTheta.get(c.thetaIndex) ?? 0) + c.votes);
  assert.equal(perTheta.size, 12);
  for (const [, n] of perTheta) assert.equal(n, 1);
});

test('空白矩阵不生成任何有票格', () => {
  const r = runHough(empty, cfg);
  assert.equal(r.cells.length, 0);
  assert.equal(r.meta.totalVotes, 0);
  assert.deepEqual(selectCandidates(r, { minVotes: 1, limit: 10 }), []);
});

test('全一矩阵票数守恒：总票数=点数*角度格数', () => {
  const r = runHough(allOnes, cfg);
  assert.equal(totalCellVotes(r), 4 * 12);
  assert.equal(r.meta.totalVotes, 48);
});

test('支持点总数等于保存票数', () => {
  const r = runHough(cross, cfg);
  for (const cell of r.cells) {
    const s = supportPoints(r, cell.thetaIndex, cell.rhoIndex, 0, 1000);
    assert.equal(s.total, cell.votes, `格 (${cell.thetaIndex},${cell.rhoIndex}) 支持点数 != 票数`);
  }
});

test('支持点分页不改变报告总票数', () => {
  const r = runHough(vertical, cfg);
  const p0 = supportPoints(r, 0, 2, 0, 2);
  const p1 = supportPoints(r, 0, 2, 1, 2);
  assert.equal(p0.points.length, 2);
  assert.equal(p1.points.length, 2);
  assert.equal(p0.total, 4);
});

test('半格舍入（含负半格）按 floor(rho/step+0.5)', () => {
  verifyRoundingFixture();
  for (const c of roundingCases) assert.equal(quantizeRho(c.rho, c.step), c.index);
});

test('近邻格平局按角度格再距离格固定排序', () => {
  const r = runHough(single, cfg);
  const top = selectCandidates(r, { minVotes: 1, limit: 3 });
  assert.equal(top.length, 3);
  assert.equal(top[0]?.votes, 1);
  for (let i = 1; i < top.length; i++) {
    const prev = top[i - 1]!;
    const cur = top[i]!;
    assert.ok(
      prev.thetaIndex < cur.thetaIndex || (prev.thetaIndex === cur.thetaIndex && prev.rhoIndex <= cur.rhoIndex),
    );
  }
});

test('独立逐点求和核对指定格与完整小矩阵', () => {
  for (const m of [vertical, horizontal, cross, single, allOnes]) {
    const r = runHough(m, cfg);
    for (const cell of r.cells) {
      assert.equal(
        pointwiseVotes(m, cfg, cell.thetaIndex, cell.rhoIndex),
        cell.votes,
        `逐点求和不一致 (${cell.thetaIndex},${cell.rhoIndex})`,
      );
    }
    assert.equal(totalCellVotes(r), r.meta.totalVotes);
  }
  assert.equal(pointwiseVotes(vertical, cfg, 0, 2), 4);
  assert.equal(pointwiseVotes(horizontal, cfg, 6, 3), 4);
});

test('角度切片只含该角度', () => {
  const r = runHough(cross, cfg);
  const slice = angleSlice(r, 6);
  assert.ok(slice.every((c) => c.thetaIndex === 6));
  const peak = slice.find((c) => c.rhoIndex === 3);
  assert.equal(peak?.votes, 4);
});

test('输入转置后对应角度关系：垂直线峰值转为水平线峰值', () => {
  const transposed = vertical[0]!.map((_, x) => vertical.map((row) => row[x]!));
  const r = runHough(transposed, cfg);
  // 原 x=2 的竖线转置后成为 y=2 的横线：theta=90, rho=2
  const peak = r.cells.find((c) => c.thetaIndex === 6 && c.rhoIndex === 2);
  assert.equal(peak?.votes, 4);
  // 原 theta 与转置 theta 相差 90 度（x,y 互换）
  const oldPeak = runHough(vertical, cfg).cells.find((c) => c.thetaIndex === 0 && c.rhoIndex === 2);
  assert.ok(peak && oldPeak);
  if (!peak || !oldPeak) return;
  assert.equal(oldPeak!.thetaIndex + 6, peak!.thetaIndex);
});

test('负 rho 格真实存在且不为零截断', () => {
  const r = runHough(single, cfg);
  assert.ok(r.meta.rhoIndexMin < 0);
  const negative = r.cells.filter((c) => c.rhoIndex < 0);
  assert.ok(negative.length > 0);
});

test('非法矩阵报错且不返回累加器', () => {
  assert.throws(() => runHough([], cfg), HoughError);
  assert.throws(() => runHough([[1], [1, 0]], cfg), (e: unknown) => (e as HoughError).code === 'INVALID_MATRIX');
  assert.throws(() => runHough([[1, 2]], cfg), (e: unknown) => (e as HoughError).code === 'INVALID_MATRIX');
});

test('非有限步长与不能整除180的角度步被拒绝', () => {
  assert.throws(() => runHough(single, { thetaStepDeg: 7, rhoStep: 1 }), (e: unknown) => (e as HoughError).code === 'INVALID_THETA_STEP');
  assert.throws(() => runHough(single, { thetaStepDeg: 15, rhoStep: 0 }), (e: unknown) => (e as HoughError).code === 'INVALID_RHO_STEP');
  assert.throws(() => runHough(single, { thetaStepDeg: 15, rhoStep: Number.NaN }), (e: unknown) => (e as HoughError).code === 'INVALID_RHO_STEP');
  assert.throws(() => runHough(single, { thetaStepDeg: 15, rhoStep: -1 }), (e: unknown) => (e as HoughError).code === 'INVALID_RHO_STEP');
});

test('超预算请求被拒绝', () => {
  const big = Array.from({ length: 400 }, () => Array.from({ length: 400 }, () => 1));
  assert.throws(() => runHough(big, { thetaStepDeg: 1, rhoStep: 1 }), (e: unknown) => (e as HoughError).code === 'VOTE_BUDGET_EXCEEDED');
});

test('宽高超限被拒绝', () => {
  assert.throws(() => validateMatrix([Array(2000).fill(0)]), (e: unknown) => (e as HoughError).code === 'MATRIX_TOO_LARGE');
});

