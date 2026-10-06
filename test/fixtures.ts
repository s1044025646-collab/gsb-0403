// 预写坐标与答案的测试夹具。答案可用独立逐点求和核对。
import { quantizeRho } from '../src/hough.js';

export const RHO_STEP = 1;
export const THETA_STEP = 15; // 12 个角度格

/** 垂直线 x=2，共 4 个点 (2,0..3)。 */
export const vertical: number[][] = [
  [0, 0, 1, 0],
  [0, 0, 1, 0],
  [0, 0, 1, 0],
  [0, 0, 1, 0],
];

/** 水平线 y=3，共 4 个点 (0..3,3)。 */
export const horizontal: number[][] = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [1, 1, 1, 1],
];

/** 十字交叉：共享交点 (2,3)，垂直线 4 点 + 水平线再补 3 点 = 7 点。 */
export const cross: number[][] = [
  [0, 0, 1, 0],
  [0, 0, 1, 0],
  [0, 0, 1, 0],
  [1, 1, 1, 1],
];

export const empty: number[][] = [
  [0, 0, 0],
  [0, 0, 0],
];

export const single: number[][] = [
  [0, 0, 0],
  [0, 1, 0],
];

export const allOnes: number[][] = [
  [1, 1],
  [1, 1],
];

/**
 * 预期答案：
 * - vertical 在 theta=0(thetaIndex=0)、rho=2(rhoIndex=2) 得 4 票
 * - horizontal 在 theta=90(thetaIndex=6)、rho=3(rhoIndex=3) 得 4 票
 * - cross 在 (thetaIndex=0,rhoIndex=2) 与 (thetaIndex=6,rhoIndex=3) 均为 4 票，
 *   共享交点 (2,3) 分别投给两条线所在的格。
 * - single 的单点在 12 个角度格各投 1 票，总票数 12。
 * - allOnes 总票数 4*12=48。
 */
export const expected = {
  verticalPeak: { thetaIndex: 0, thetaDeg: 0, rhoIndex: 2, rho: 2, votes: 4 },
  horizontalPeak: { thetaIndex: 6, thetaDeg: 90, rhoIndex: 3, rho: 3, votes: 4 },
  crossSharedPoint: { x: 2, y: 3 },
  crossPointCount: 7,
};

/** 半格舍入夹具：rhoStep=2 时，rho=1 正好处于 0.5 边界，floor(0.5+0.5)=1；
 * 负侧 rho=-1 => floor(-0.5+0.5)=floor(0)=0；rho=-1.0001 => floor(-0.00005)=-1。 */
export const roundingCases: Array<{ rho: number; step: number; index: number }> = [
  { rho: 0, step: 2, index: 0 },
  { rho: 0.99, step: 2, index: 0 },
  { rho: 1, step: 2, index: 1 },
  { rho: 3, step: 2, index: 2 }, // floor(1.5+0.5)=2
  { rho: -1, step: 2, index: 0 }, // floor(-0.5+0.5)=0
  { rho: -1.01, step: 2, index: -1 }, // floor(-0.505+0.5)=floor(-0.005)=-1
  { rho: -3, step: 2, index: -1 }, // floor(-1.5+0.5)=floor(-1)=-1
  { rho: -3.01, step: 2, index: -2 },
];

export function verifyRoundingFixture(): void {
  for (const c of roundingCases) {
    if (quantizeRho(c.rho, c.step) !== c.index) {
      throw new Error(`舍入夹具不一致: rho=${c.rho} step=${c.step}`);
    }
  }
}

/** 近邻参数格平局夹具：单点在 15 度网格上，thetaIndex=0 与 thetaIndex=1 各 1 票，
 * 候选排序固定按角度格再距离格。 */
export function tieOrderFixture() {
  return { matrix: single, thetaStepDeg: THETA_STEP, rhoStep: RHO_STEP };
}
