// 端到端演示：垂直线、水平线、交叉共享交点、负 rho 与近邻平局。
// 使用临时数据目录，不污染默认 data/。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, saveAnalysis, compareAnalyses } from './db.js';
import { selectCandidates, supportPoints, angleSlice } from './hough.js';
import { vertical, horizontal, cross } from '../test/fixtures.js';

function hr(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const dir = mkdtempSync(join(tmpdir(), 'hough-demo-'));
const db = openDatabase(join(dir, 'demo.sqlite'));
const cfg = { thetaStepDeg: 15, rhoStep: 1 };

hr('1. 垂直线 x=2（theta=0 法线沿 x 轴，rho=2）');
const v = saveAnalysis(db, vertical, cfg, 'vertical');
console.table(
  selectCandidates(v, { minVotes: 4, limit: 5 }).map((c) => ({
    角度格: c.thetaIndex,
    距离格: c.rhoIndex,
    法线角: c.thetaDeg,
    rho: c.rho,
    票数: c.votes,
  })),
);

hr('2. 水平线 y=3（theta=90 法线沿 y 轴，rho=3）');
const h = saveAnalysis(db, horizontal, cfg, 'horizontal');
console.table(
  selectCandidates(h, { minVotes: 4, limit: 5 }).map((c) => ({
    角度格: c.thetaIndex,
    距离格: c.rhoIndex,
    法线角: c.thetaDeg,
    rho: c.rho,
    票数: c.votes,
  })),
);

hr('3. 交叉线：共享交点 (2,3) 分别投票');
const c1 = saveAnalysis(db, cross, cfg, 'cross');
const vp = supportPoints(c1, 0, 2);
const hp = supportPoints(c1, 6, 3);
console.log('竖线候选 (theta=0,rho=2) 票数 =', vp.total, '支持点 =', JSON.stringify(vp.points));
console.log('横线候选 (theta=90,rho=3) 票数 =', hp.total, '支持点 =', JSON.stringify(hp.points));
console.log('交点 (2,3) 同时出现在两组支持点中（一个点对每个角度各投一票）');
console.log(`票数守恒检查: 边缘点 ${c1.meta.edgePointCount} × 角度格 ${c1.meta.thetaBins} = ${c1.meta.totalVotes}`);

hr('4. 文本角度切片（thetaIndex=6 即 90 度）');
for (const cell of angleSlice(c1, 6)) {
  console.log(`角度格=${cell.thetaIndex} 距离格=${String(cell.rhoIndex).padStart(3)} rho=${cell.rho.toFixed(2)} 票数=${cell.votes}`);
}

hr('5. 分辨率比较（同一垂直线：15 度/rhoStep=1 vs 30 度/rhoStep=2）');
const v2 = saveAnalysis(db, vertical, { thetaStepDeg: 30, rhoStep: 2 }, 'vertical-coarse');
const cmp = compareAnalyses(v, v2, { minVotes: 4, limit: 5 });
console.log('细网格峰值:', cmp.a.cells.map((c) => `(t=${c.thetaIndex},r=${c.rhoIndex},v=${c.votes})`).join(' '));
console.log('粗网格峰值:', cmp.b.cells.map((c) => `(t=${c.thetaIndex},r=${c.rhoIndex},v=${c.votes})`).join(' '));
console.log(cmp.note);

hr('说明');
console.log('输出是参数空间累加器格，不是线段检测器；不做非极大值抑制或近邻格合并。');
console.log('演示数据库位于临时目录:', dir);
db.close();
