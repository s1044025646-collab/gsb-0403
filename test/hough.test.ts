import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  edgePoints,
  rhoBinIndex,
  runVote,
  selectCandidates,
  supportPoints,
  validateGrid,
  validateMatrix,
  HoughError,
} from "../src/hough";

const fixtures = path.join(__dirname, "..", "..", "fixtures");
function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
}

// Independent per-point reference: recompute one cell by brute force.
function bruteForceCell(
  matrix: number[][],
  thetaDeg: number,
  rhoStep: number,
  rhoIdx: number,
): number {
  const rad = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  let count = 0;
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x] !== 1) continue;
      if (Math.floor((x * c + y * s) / rhoStep + 0.5) === rhoIdx) count++;
    }
  }
  return count;
}

test("single point votes exactly once per theta bin", () => {
  const matrix = [[0, 0, 0], [0, 1, 0], [0, 0, 0]];
  const r = runVote(matrix, { thetaStepDeg: 45, rhoStep: 1 });
  assert.equal(r.edgeCount, 1);
  assert.equal(r.totalVotes, 4);
  let sum = 0;
  for (const row of r.acc) for (const v of row) sum += v;
  assert.equal(sum, 4);
  // point (1,1): theta=0 -> rho=1, theta=90 -> rho=1
  assert.equal(r.acc[0][1 + r.rhoRadius], 1);
  assert.equal(r.acc[2][1 + r.rhoRadius], 1);
});

test("empty edge map produces no candidates", () => {
  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = runVote(matrix, { thetaStepDeg: 30, rhoStep: 1 });
  assert.equal(r.edgeCount, 0);
  assert.equal(r.totalVotes, 0);
  assert.deepEqual(selectCandidates(r, 1, 100), []);
});

test("all-ones matrix: vote conservation and diagonal dominance", () => {
  const matrix = Array.from({ length: 4 }, () => [1, 1, 1, 1]);
  const r = runVote(matrix, { thetaStepDeg: 90, rhoStep: 1 });
  assert.equal(r.totalVotes, 16 * 2);
  let sum = 0;
  for (const row of r.acc) for (const v of row) sum += v;
  assert.equal(sum, 32);
  // theta=0: columns x=0..3 each hold 4 points
  for (let x = 0; x < 4; x++) assert.equal(r.acc[0][x + r.rhoRadius], 4);
  // theta=90: rows y=0..3 each hold 4 points
  for (let y = 0; y < 4; y++) assert.equal(r.acc[1][y + r.rhoRadius], 4);
});

test("negative rho values land in negative bins", () => {
  // theta=135deg normal: rho = x*cos135 + y*sin135 = (y - x)/sqrt(2)
  // point (3,0): rho = -3/sqrt(2) ~= -2.121 -> bin floor(-2.121+0.5) = -2 with rhoStep=1
  const matrix = [[0, 0, 0, 1]];
  const r = runVote(matrix, { thetaStepDeg: 45, rhoStep: 1 });
  const thetaIdx = 3; // 135 deg
  assert.equal(r.acc[thetaIdx][-2 + r.rhoRadius], 1);
  assert.equal(r.acc[thetaIdx][2 + r.rhoRadius], 0);
});

test("half-cell rounding: floor(rho/step + 0.5) including negative half cells", () => {
  assert.equal(rhoBinIndex(0.49, 1), 0);
  assert.equal(rhoBinIndex(0.5, 1), 1);
  assert.equal(rhoBinIndex(-0.49, 1), 0);
  assert.equal(rhoBinIndex(-0.5, 1), 0); // floor(0) = 0: negative half cell rounds toward zero
  assert.equal(rhoBinIndex(-0.51, 1), -1);
  assert.equal(rhoBinIndex(-1.5, 1), -1);
  assert.equal(rhoBinIndex(2.4, 0.5), 5); // 2.4/0.5=4.8 -> floor(5.3)=5
});

test("tie ordering: votes desc, then thetaIdx asc, then rhoIdx asc", () => {
  // Neighboring bins of a vertical line with coarse rhoStep split votes into a tie.
  const matrix = Array.from({ length: 3 }, () => [0, 1, 0]);
  const r = runVote(matrix, { thetaStepDeg: 90, rhoStep: 2 });
  // theta=0: x=1 -> rho=1 -> bin floor(0.5+0.5)=1; theta=90: y=0,1,2 -> bins 0,1,1
  const cells = selectCandidates(r, 1, 100);
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const ok =
      a.votes > b.votes ||
      (a.votes === b.votes && a.thetaIdx < b.thetaIdx) ||
      (a.votes === b.votes && a.thetaIdx === b.thetaIdx && a.rhoIdx < b.rhoIdx);
    assert.ok(ok, `ordering violated at ${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  // The tie between (theta=0,rhoIdx=1,votes=3) and (theta=90,rhoIdx=1,votes=2) is broken by votes first.
  assert.equal(cells[0].votes, 3);
});

test("vertical line x=2 clusters at theta=0, rho=2 (fixture)", () => {
  const f = loadFixture("vertical-x2.json");
  const matrix = validateMatrix(f.matrix);
  const r = runVote(matrix, { thetaStepDeg: 90, rhoStep: 1 });
  const exp = f.expected as { thetaIdx: number; rhoIdx: number; votes: number };
  assert.equal(r.acc[exp.thetaIdx][exp.rhoIdx + r.rhoRadius], exp.votes);
  const top = selectCandidates(r, 1, 1)[0];
  assert.equal(top.thetaIdx, exp.thetaIdx);
  assert.equal(top.rhoIdx, exp.rhoIdx);
  assert.equal(top.votes, exp.votes);
});

test("horizontal line y=3 clusters at theta=90, rho=3 (fixture)", () => {
  const f = loadFixture("horizontal-y3.json");
  const matrix = validateMatrix(f.matrix);
  const r = runVote(matrix, { thetaStepDeg: 90, rhoStep: 1 });
  const exp = f.expected as { thetaIdx: number; rhoIdx: number; votes: number };
  assert.equal(r.acc[exp.thetaIdx][exp.rhoIdx + r.rhoRadius], exp.votes);
  const top = selectCandidates(r, 1, 1)[0];
  assert.equal(top.thetaIdx, exp.thetaIdx);
  assert.equal(top.rhoIdx, exp.rhoIdx);
});

test("crossing lines: shared intersection point votes in both line cells (fixture)", () => {
  const f = loadFixture("cross-x2-y3.json");
  const matrix = validateMatrix(f.matrix);
  const grid = { thetaStepDeg: 90, rhoStep: 1 };
  const r = runVote(matrix, grid);
  const cells = f.expected.cells as { thetaIdx: number; rhoIdx: number; votes: number }[];
  for (const c of cells) {
    assert.equal(r.acc[c.thetaIdx][c.rhoIdx + r.rhoRadius], c.votes);
  }
  const shared = f.expected.sharedPoint as { x: number; y: number };
  for (const c of cells) {
    const pts = supportPoints(matrix, grid, c.thetaIdx, c.rhoIdx);
    assert.equal(pts.length, c.votes); // support recomputation matches stored votes
    assert.ok(pts.some((p) => p.x === shared.x && p.y === shared.y));
  }
});

test("support points use the same quantization, not Euclidean tolerance", () => {
  const f = loadFixture("cross-x2-y3.json");
  const matrix = validateMatrix(f.matrix);
  const grid = { thetaStepDeg: 90, rhoStep: 1 };
  // theta=0, rho=2: only points with x in [1.5, 2.5) -> exactly x=2 column
  const pts = supportPoints(matrix, grid, 0, 2);
  assert.deepEqual(pts, [0, 1, 2, 3, 4, 5].map((y) => ({ x: 2, y })));
});

test("brute-force cross-check of specified cells and full small matrix", () => {
  const matrix = [
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 1, 0, 0],
    [0, 0, 1, 1],
  ];
  const grid = { thetaStepDeg: 45, rhoStep: 1 };
  const r = runVote(matrix, grid);
  for (let k = 0; k < r.nTheta; k++) {
    for (let i = 0; i < r.acc[k].length; i++) {
      const rhoIdx = i - r.rhoRadius;
      const expected = bruteForceCell(matrix, k * grid.thetaStepDeg, grid.rhoStep, rhoIdx);
      assert.equal(r.acc[k][i], expected, `cell theta=${k} rhoIdx=${rhoIdx}`);
    }
  }
  let sum = 0;
  for (const row of r.acc) for (const v of row) sum += v;
  assert.equal(sum, edgePoints(matrix).length * r.nTheta);
});

test("transpose maps theta to 90 - theta", () => {
  const matrix = [
    [1, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
  ];
  const transposed = matrix[0].map((_, x) => matrix.map((row) => row[x]));
  const grid = { thetaStepDeg: 30, rhoStep: 1 };
  const a = runVote(matrix, grid);
  const b = runVote(transposed, grid);
  const nTheta = a.nTheta;

  // Angle relation per point: rho'(theta) = rho(90deg - theta). When 90deg - theta < 0,
  // the same normal line is angle (90deg - theta + 180deg) with negated rho.
  const counterpart = (k: number): { k2: number; sign: 1 | -1 } =>
    k <= 3 ? { k2: 3 - k, sign: 1 } : { k2: 9 - k, sign: -1 };
  const pts = edgePoints(matrix);
  for (let k = 0; k < nTheta; k++) {
    const { k2, sign } = counterpart(k);
    const radB = (k * grid.thetaStepDeg * Math.PI) / 180;
    const radA = (k2 * grid.thetaStepDeg * Math.PI) / 180;
    for (const p of pts) {
      const rhoB = p.y * Math.cos(radB) + p.x * Math.sin(radB); // transposed point (y,x)
      const rhoA = p.x * Math.cos(radA) + p.y * Math.sin(radA);
      assert.ok(Math.abs(sign * rhoA - rhoB) < 1e-9, `theta ${k} vs ${k2}: ${rhoA} vs ${rhoB}`);
    }
  }

  // Accumulator bins match except possibly where a rho sits within float noise of a
  // half-integer quantization boundary (sin/cos of complementary angles differ by 1 ulp).
  for (let k = 0; k < nTheta; k++) {
    const { k2, sign } = counterpart(k);
    for (let i = 0; i < a.acc[k].length; i++) {
      const rhoIdx = i - a.rhoRadius;
      const va = a.acc[k2][sign * rhoIdx + a.rhoRadius];
      const vb = b.acc[k][rhoIdx + b.rhoRadius];
      if (va === vb) continue;
      const radA = (k2 * grid.thetaStepDeg * Math.PI) / 180;
      const nearBoundary = pts.some((p) => {
        const rho = p.x * Math.cos(radA) + p.y * Math.sin(radA);
        return Math.abs(rho / grid.rhoStep + 0.5 - Math.round(rho / grid.rhoStep + 0.5)) < 1e-9;
      });
      assert.ok(nearBoundary, `unexpected bin mismatch theta ${k} rhoIdx ${rhoIdx}: ${va} vs ${vb}`);
    }
  }
});

test("validation rejects bad matrices and grids", () => {
  assert.throws(() => validateMatrix([]), HoughError);
  assert.throws(() => validateMatrix([[1, 0], [1]]), /same length/);
  assert.throws(() => validateMatrix([[0, 2]]), /0 or 1/);
  assert.throws(() => validateGrid({ thetaStepDeg: 7, rhoStep: 1 }), /divides 180/);
  assert.throws(() => validateGrid({ thetaStepDeg: 0, rhoStep: 1 }), HoughError);
  assert.throws(() => validateGrid({ thetaStepDeg: 45, rhoStep: 0 }), HoughError);
  assert.throws(() => validateGrid({ thetaStepDeg: 45, rhoStep: -1 }), HoughError);
  assert.throws(() => validateGrid({ thetaStepDeg: 45, rhoStep: Number.NaN }), HoughError);
  assert.throws(() => validateGrid({ thetaStepDeg: 45, rhoStep: Infinity }), HoughError);
});

test("vote budget limit rejects oversized requests before voting", () => {
  const matrix = Array.from({ length: 300 }, () => Array.from({ length: 300 }, () => 1));
  assert.throws(() => runVote(matrix, { thetaStepDeg: 1, rhoStep: 1 }), /BUDGET_EXCEEDED|budget/);
});
