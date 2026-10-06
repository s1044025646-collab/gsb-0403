// Core discrete Hough line voting.
// Parameterization: rho = x*cos(theta) + y*sin(theta).
// Origin at top-left of the matrix; column = x, row = y; pixel centers at integer coords.
// theta grid: k*thetaStepDeg for k = 0..nTheta-1 (0 <= theta < 180).
// rho bin index: floor(rho / rhoStep + 0.5), negatives allowed (half-cell rounding).

export interface GridConfig {
  thetaStepDeg: number; // positive integer that divides 180
  rhoStep: number; // positive finite
}

export interface EdgePoint {
  x: number;
  y: number;
}

export interface Cell {
  thetaIdx: number;
  rhoIdx: number;
  thetaDeg: number;
  rho: number;
  votes: number;
}

export class HoughError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HoughError";
  }
}

export const LIMITS = {
  maxWidth: 512,
  maxHeight: 512,
  maxThetaBins: 180,
  maxVoteBudget: 5_000_000, // edgePoints * nTheta upper bound
};

export function validateMatrix(matrix: unknown): number[][] {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new HoughError("INVALID_MATRIX", "matrix must be a non-empty array of rows");
  }
  if (!Array.isArray(matrix[0]) || matrix[0].length === 0) {
    throw new HoughError("INVALID_MATRIX", "matrix rows must be non-empty arrays");
  }
  const width = matrix[0].length;
  const height = matrix.length;
  if (width > LIMITS.maxWidth || height > LIMITS.maxHeight) {
    throw new HoughError(
      "MATRIX_TOO_LARGE",
      `matrix ${width}x${height} exceeds limit ${LIMITS.maxWidth}x${LIMITS.maxHeight}`,
    );
  }
  for (const row of matrix) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new HoughError("INVALID_MATRIX", "matrix rows must all have the same length");
    }
    for (const v of row) {
      if (v !== 0 && v !== 1) {
        throw new HoughError("INVALID_MATRIX", "matrix entries must be 0 or 1");
      }
    }
  }
  return matrix as number[][];
}

export function validateGrid(config: unknown): GridConfig {
  if (typeof config !== "object" || config === null) {
    throw new HoughError("INVALID_GRID", "grid config must be an object");
  }
  const { thetaStepDeg, rhoStep } = config as Record<string, unknown>;
  if (
    typeof thetaStepDeg !== "number" ||
    !Number.isInteger(thetaStepDeg) ||
    thetaStepDeg <= 0 ||
    180 % thetaStepDeg !== 0
  ) {
    throw new HoughError(
      "INVALID_GRID",
      "thetaStepDeg must be a positive integer that divides 180",
    );
  }
  const nTheta = 180 / thetaStepDeg;
  if (nTheta > LIMITS.maxThetaBins) {
    throw new HoughError("INVALID_GRID", `theta bins ${nTheta} exceed limit ${LIMITS.maxThetaBins}`);
  }
  if (typeof rhoStep !== "number" || !Number.isFinite(rhoStep) || rhoStep <= 0) {
    throw new HoughError("INVALID_GRID", "rhoStep must be a positive finite number");
  }
  return { thetaStepDeg, rhoStep };
}

export function edgePoints(matrix: number[][]): EdgePoint[] {
  const pts: EdgePoint[] = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x] === 1) pts.push({ x, y });
    }
  }
  return pts;
}

export function rhoBinIndex(rho: number, rhoStep: number): number {
  return Math.floor(rho / rhoStep + 0.5);
}

// Max |rho| for any pixel center: rho = x cos + y sin, |rho| <= x + y <= (w-1)+(h-1).
export function rhoIndexRadius(width: number, height: number, rhoStep: number): number {
  const maxAbs = width - 1 + (height - 1);
  return rhoBinIndex(maxAbs, rhoStep);
}

export interface VoteResult {
  width: number;
  height: number;
  nTheta: number;
  thetaStepDeg: number;
  rhoStep: number;
  rhoRadius: number; // rho indices range over [-rhoRadius, rhoRadius]
  edgeCount: number;
  totalVotes: number; // edgeCount * nTheta
  // acc[thetaIdx][rhoIdx + rhoRadius] = votes
  acc: Uint32Array[];
}

export function runVote(matrix: number[][], grid: GridConfig): VoteResult {
  const height = matrix.length;
  const width = matrix[0].length;
  const pts = edgePoints(matrix);
  const nTheta = 180 / grid.thetaStepDeg;
  const budget = pts.length * nTheta;
  if (budget > LIMITS.maxVoteBudget) {
    throw new HoughError(
      "BUDGET_EXCEEDED",
      `vote budget ${budget} (points ${pts.length} x theta bins ${nTheta}) exceeds limit ${LIMITS.maxVoteBudget}`,
    );
  }
  const rhoRadius = rhoIndexRadius(width, height, grid.rhoStep);
  const nRho = 2 * rhoRadius + 1;
  const acc: Uint32Array[] = [];
  for (let k = 0; k < nTheta; k++) acc.push(new Uint32Array(nRho));

  const cos = new Float64Array(nTheta);
  const sin = new Float64Array(nTheta);
  for (let k = 0; k < nTheta; k++) {
    const rad = (k * grid.thetaStepDeg * Math.PI) / 180;
    cos[k] = Math.cos(rad);
    sin[k] = Math.sin(rad);
  }
  for (const p of pts) {
    for (let k = 0; k < nTheta; k++) {
      const rho = p.x * cos[k] + p.y * sin[k];
      const idx = rhoBinIndex(rho, grid.rhoStep);
      acc[k][idx + rhoRadius]++;
    }
  }
  return {
    width,
    height,
    nTheta,
    thetaStepDeg: grid.thetaStepDeg,
    rhoStep: grid.rhoStep,
    rhoRadius,
    edgeCount: pts.length,
    totalVotes: budget,
    acc,
  };
}

// Select candidate cells: votes >= minVotes, sorted by votes desc, then thetaIdx asc, then rhoIdx asc.
export function selectCandidates(
  result: VoteResult,
  minVotes: number,
  limit: number,
): Cell[] {
  const cells: Cell[] = [];
  for (let k = 0; k < result.nTheta; k++) {
    const row = result.acc[k];
    for (let i = 0; i < row.length; i++) {
      const votes = row[i];
      if (votes >= minVotes && votes > 0) {
        const rhoIdx = i - result.rhoRadius;
        cells.push({
          thetaIdx: k,
          rhoIdx,
          thetaDeg: k * result.thetaStepDeg,
          rho: rhoIdx * result.rhoStep,
          votes,
        });
      }
    }
  }
  cells.sort((a, b) => b.votes - a.votes || a.thetaIdx - b.thetaIdx || a.rhoIdx - b.rhoIdx);
  return cells.slice(0, limit);
}

// Support points for one cell, recomputed with the same quantization rule.
export function supportPoints(
  matrix: number[][],
  grid: GridConfig,
  thetaIdx: number,
  rhoIdx: number,
): EdgePoint[] {
  const rad = (thetaIdx * grid.thetaStepDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const pts: EdgePoint[] = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x] !== 1) continue;
      if (rhoBinIndex(x * c + y * s, grid.rhoStep) === rhoIdx) pts.push({ x, y });
    }
  }
  return pts;
}
