// 离散 Hough 直线投票核心：rho = x*cos(theta) + y*sin(theta)
// 坐标口径：矩阵左上角为原点，列号为 x、行号为 y，像素中心为整数坐标。

export const LIMITS = {
  maxWidth: 1024,
  maxHeight: 1024,
  maxAngleBins: 360, // theta 最小 1 度
  maxVoteBudget: 20_000_000, // 边缘点数 * 角度格数
} as const;

export interface Point {
  x: number;
  y: number;
}

export interface AnalysisConfig {
  thetaStepDeg: number; // 能整除 180 的正整数度
  rhoStep: number; // 正数
}

export interface AnalysisMeta extends AnalysisConfig {
  width: number;
  height: number;
  thetaBins: number;
  rhoIndexMin: number;
  rhoIndexMax: number;
  edgePointCount: number;
  totalVotes: number; // edgePointCount * thetaBins
  voteBudget: number;
}

export interface Cell {
  thetaIndex: number;
  rhoIndex: number;
  thetaDeg: number;
  rho: number;
  votes: number;
}

export interface AnalysisResult {
  meta: AnalysisMeta;
  edgePoints: Point[];
  cells: Cell[]; // 仅票数 > 0 的格，按 (thetaIndex, rhoIndex) 升序
}

export interface CandidateQuery {
  minVotes: number;
  limit: number;
}

export class HoughError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HoughError';
    this.code = code;
  }
}

const DIVISORS_OF_180 = [1, 2, 3, 4, 5, 6, 9, 10, 12, 15, 18, 20, 30, 36, 45, 60, 90, 180];

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 校验并规范化零一矩阵，返回边缘点（值为 1 的像素中心坐标）。 */
export function validateMatrix(matrix: unknown): { width: number; height: number; edgePoints: Point[] } {
  if (!Array.isArray(matrix)) {
    throw new HoughError('INVALID_MATRIX', 'matrix 必须是二维数组（行的数组）');
  }
  const height = matrix.length;
  if (height === 0) {
    throw new HoughError('INVALID_MATRIX', 'matrix 至少需要一行');
  }
  if (height > LIMITS.maxHeight) {
    throw new HoughError('MATRIX_TOO_LARGE', `高度 ${height} 超过上限 ${LIMITS.maxHeight}`);
  }
  let width = -1;
  const edgePoints: Point[] = [];
  matrix.forEach((row, y) => {
    if (!Array.isArray(row)) {
      throw new HoughError('INVALID_MATRIX', `第 ${y} 行不是数组`);
    }
    if (width === -1) {
      if (row.length === 0) throw new HoughError('INVALID_MATRIX', 'matrix 至少需要一列');
      if (row.length > LIMITS.maxWidth) {
        throw new HoughError('MATRIX_TOO_LARGE', `宽度 ${row.length} 超过上限 ${LIMITS.maxWidth}`);
      }
      width = row.length;
    } else if (row.length !== width) {
      throw new HoughError('INVALID_MATRIX', `第 ${y} 行长度 ${row.length} 与首行 ${width} 不一致（不允许锯齿矩阵）`);
    }
    row.forEach((v, x) => {
      if (v !== 0 && v !== 1) {
        throw new HoughError('INVALID_MATRIX', `坐标 (x=${x}, y=${y}) 的值为 ${String(v)}，只允许 0 或 1`);
      }
      if (v === 1) edgePoints.push({ x, y });
    });
  });
  return { width, height, edgePoints };
}

export function validateConfig(config: unknown, edgePointCount: number): AnalysisMeta {
  if (typeof config !== 'object' || config === null) {
    throw new HoughError('INVALID_CONFIG', 'config 必须是对象');
  }
  const { thetaStepDeg, rhoStep } = config as Record<string, unknown>;
  if (!isInt(thetaStepDeg) || thetaStepDeg <= 0) {
    throw new HoughError('INVALID_THETA_STEP', 'thetaStepDeg 必须是正整数（度）');
  }
  if (!DIVISORS_OF_180.includes(thetaStepDeg)) {
    throw new HoughError('INVALID_THETA_STEP', `thetaStepDeg ${thetaStepDeg} 不能整除 180，允许：${DIVISORS_OF_180.join(', ')}`);
  }
  if (typeof rhoStep !== 'number' || !Number.isFinite(rhoStep) || rhoStep <= 0) {
    throw new HoughError('INVALID_RHO_STEP', 'rhoStep 必须是正的有限数');
  }
  const thetaBins = 180 / thetaStepDeg;
  if (thetaBins > LIMITS.maxAngleBins) {
    throw new HoughError('GRID_TOO_LARGE', `角度格数 ${thetaBins} 超过上限 ${LIMITS.maxAngleBins}`);
  }
  const voteBudget = edgePointCount * thetaBins;
  if (voteBudget > LIMITS.maxVoteBudget) {
    throw new HoughError('VOTE_BUDGET_EXCEEDED', `总投票数 ${voteBudget}（边缘点 ${edgePointCount} * 角度格 ${thetaBins}）超过预算 ${LIMITS.maxVoteBudget}`);
  }
  // width/height 由调用方在 meta 中补齐
  return {
    thetaStepDeg,
    rhoStep,
    width: 0,
    height: 0,
    thetaBins,
    rhoIndexMin: 0,
    rhoIndexMax: 0,
    edgePointCount,
    totalVotes: voteBudget,
    voteBudget,
  };
}

/** 距离格编号：floor(rho/step + 0.5)，负值按数学 floor 处理（向负无穷取整）。 */
export function quantizeRho(rho: number, rhoStep: number): number {
  return Math.floor(rho / rhoStep + 0.5);
}

/** 覆盖图像对角线正负距离的格编号范围。 */
export function rhoIndexRange(width: number, height: number, rhoStep: number): { min: number; max: number } {
  const rhoMax = Math.hypot(width - 1, height - 1);
  const max = quantizeRho(rhoMax, rhoStep);
  return { min: -max, max };
}

/** 运行完整投票；任何参数错误在分配累加器之前抛出，不会留下半张累加器。 */
export function runHough(matrix: unknown, config: unknown): AnalysisResult {
  const { width, height, edgePoints } = validateMatrix(matrix);
  const meta = validateConfig(config, edgePoints.length);
  meta.width = width;
  meta.height = height;
  const { min: rMin, max: rMax } = rhoIndexRange(width, height, meta.rhoStep);
  meta.rhoIndexMin = rMin;
  meta.rhoIndexMax = rMax;

  const nRho = rMax - rMin + 1;
  const acc = new Int32Array(meta.thetaBins * nRho);
  const cos: number[] = [];
  const sin: number[] = [];
  for (let t = 0; t < meta.thetaBins; t++) {
    const rad = (t * meta.thetaStepDeg * Math.PI) / 180;
    cos.push(Math.cos(rad));
    sin.push(Math.sin(rad));
  }
  for (const p of edgePoints) {
    for (let t = 0; t < meta.thetaBins; t++) {
      const rho = p.x * (cos[t] as number) + p.y * (sin[t] as number);
      const r = quantizeRho(rho, meta.rhoStep);
      acc[t * nRho + (r - rMin)]!++;
    }
  }

  const cells: Cell[] = [];
  for (let t = 0; t < meta.thetaBins; t++) {
    for (let ri = 0; ri < nRho; ri++) {
      const votes = acc[t * nRho + ri] as number;
      if (votes > 0) {
        const rhoIndex = ri + rMin;
        cells.push({
          thetaIndex: t,
          rhoIndex,
          thetaDeg: t * meta.thetaStepDeg,
          rho: rhoIndex * meta.rhoStep,
          votes,
        });
      }
    }
  }
  return { meta, edgePoints, cells };
}

/** 候选选择：minVotes 过滤 + 最多 limit 个；平局按角度格再距离格升序。 */
export function selectCandidates(result: AnalysisResult, query: CandidateQuery): Cell[] {
  const minVotes = query.minVotes ?? 1;
  const limit = query.limit ?? result.cells.length;
  if (!isInt(minVotes) || minVotes < 1) {
    throw new HoughError('INVALID_QUERY', 'minVotes 必须是 >= 1 的整数');
  }
  if (!isInt(limit) || limit < 1) {
    throw new HoughError('INVALID_QUERY', 'limit 必须是 >= 1 的整数');
  }
  return result.cells.filter((c) => c.votes >= minVotes).slice(0, limit);
}

/** 按同一量化规则重新计算某个格的支持点（不使用欧氏容差，不改变票数）。 */
export function supportPoints(
  result: Pick<AnalysisResult, 'meta' | 'edgePoints'>,
  thetaIndex: number,
  rhoIndex: number,
  page = 0,
  pageSize = 100,
): { points: Point[]; total: number; page: number; pageSize: number } {
  const { meta, edgePoints } = result;
  if (!isInt(thetaIndex) || thetaIndex < 0 || thetaIndex >= meta.thetaBins) {
    throw new HoughError('INVALID_CELL', `thetaIndex 必须在 [0, ${meta.thetaBins - 1}] 内`);
  }
  if (!isInt(rhoIndex) || rhoIndex < meta.rhoIndexMin || rhoIndex > meta.rhoIndexMax) {
    throw new HoughError('INVALID_CELL', `rhoIndex 必须在 [${meta.rhoIndexMin}, ${meta.rhoIndexMax}] 内`);
  }
  if (!isInt(page) || page < 0) throw new HoughError('INVALID_QUERY', 'page 必须是非负整数');
  if (!isInt(pageSize) || pageSize < 1) throw new HoughError('INVALID_QUERY', 'pageSize 必须是 >= 1 的整数');
  const rad = (thetaIndex * meta.thetaStepDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const matched: Point[] = [];
  for (const p of edgePoints) {
    const rho = p.x * c + p.y * s;
    if (quantizeRho(rho, meta.rhoStep) === rhoIndex) matched.push(p);
  }
  const start = page * pageSize;
  return { points: matched.slice(start, start + pageSize), total: matched.length, page, pageSize };
}

/** 取一个角度切片上的所有有票格。 */
export function angleSlice(result: AnalysisResult, thetaIndex: number): Cell[] {
  if (!isInt(thetaIndex) || thetaIndex < 0 || thetaIndex >= result.meta.thetaBins) {
    throw new HoughError('INVALID_CELL', `thetaIndex 必须在 [0, ${result.meta.thetaBins - 1}] 内`);
  }
  return result.cells.filter((cell) => cell.thetaIndex === thetaIndex);
}

/**
 * 独立逐点求和核对：不使用累加器，直接遍历边缘点统计指定格票数。
 * 用于测试交叉核对保存的票数。
 */
export function pointwiseVotes(
  matrix: unknown,
  config: { thetaStepDeg: number; rhoStep: number },
  thetaIndex: number,
  rhoIndex: number,
): number {
  const { edgePoints } = validateMatrix(matrix);
  if (!isInt(thetaStep(config)) || thetaIndex < 0 || thetaIndex >= 180 / config.thetaStepDeg) {
    throw new HoughError('INVALID_CELL', 'thetaIndex 越界');
  }
  const rad = (thetaIndex * config.thetaStepDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  let votes = 0;
  for (const p of edgePoints) {
    if (quantizeRho(p.x * c + p.y * s, config.rhoStep) === rhoIndex) votes++;
  }
  return votes;
}

function thetaStep(config: { thetaStepDeg: number }): number {
  return config.thetaStepDeg;
}

/** 校验所有有票格票数之和等于总投票数（票数守恒）。 */
export function totalCellVotes(result: AnalysisResult): number {
  return result.cells.reduce((sum, cell) => sum + cell.votes, 0);
}
