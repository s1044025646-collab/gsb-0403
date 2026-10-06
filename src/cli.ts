#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase, saveAnalysis, getAnalysis, listAnalyses, exportAnalysis, compareAnalyses } from './db.js';
import { selectCandidates, supportPoints, angleSlice, HoughError } from './hough.js';
import { createApiServer, listenWithFallback } from './server.js';

const DATA_DIR = resolve(process.env.HOUGH_DATA_DIR ?? 'data');
const DB_PATH = resolve(DATA_DIR, 'hough.sqlite');

function usage(): never {
  console.error(`用法: hough <命令> [选项]

命令:
  serve [--port N] [--host H]            启动 HTTP API（默认端口 0=自动选择空闲端口）
  import --matrix FILE --theta D --rho R [--name N]
                                         导入矩阵并运行投票
  list                                   列出已保存分析
  get <id>                               查看分析元数据与全部有票格
  candidates <id> [--min-votes N] [--limit N]
                                         查看候选格（平局按角度格、距离格升序）
  slice <id> <thetaIndex>                查看某个角度切片
  support <id> <thetaIndex> <rhoIndex> [--page N] [--page-size N]
                                         查询候选格的来源支持点
  compare <idA> <idB> [--min-votes N] [--limit N]
                                         比较两次分析（如不同分辨率）
  export <id> [--out FILE]               导出 JSON 报告（默认打印到 stdout）

矩阵文件: JSON 二维 0/1 数组，例如 [[0,1,0],[1,1,1]]
环境变量: HOUGH_DATA_DIR 覆盖数据目录（默认 ./data）
`);
  process.exit(1);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readMatrix(path: string): Promise<number[][]> {
  const raw = await readFile(resolve(path), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HoughError('INVALID_MATRIX', `文件 ${path} 不是合法 JSON`);
  }
  return parsed as number[][];
}

function printCells(cells: Array<{ thetaIndex: number; rhoIndex: number; thetaDeg: number; rho: number; votes: number }>): void {
  console.log('角度格  距离格  法线角(°)  rho        票数');
  for (const c of cells) {
    console.log(
      `${String(c.thetaIndex).padStart(5)}  ${String(c.rhoIndex).padStart(5)}  ${String(c.thetaDeg).padStart(8)}  ${c.rho.toFixed(4).padStart(9)}  ${c.votes}`,
    );
  }
}

function printSupport(points: Array<{ x: number; y: number }>, total: number, page: number, pageSize: number): void {
  console.log(`支持点总数(=该格票数): ${total}；第 ${page} 页，每页 ${pageSize}，本页 ${points.length} 个`);
  console.log('  x    y');
  for (const p of points) console.log(`${String(p.x).padStart(3)}  ${String(p.y).padStart(3)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) usage();
  const args = argv.slice(1);

  if (cmd === 'serve') {
    const port = Number(arg(args, '--port') ?? process.env.PORT ?? '0');
    const host = arg(args, '--host') ?? '127.0.0.1';
    const db = openDatabase(DB_PATH);
    const server = createApiServer({ db });
    const { port: actual } = await listenWithFallback(server, port, host);
    console.log(`Hough API 已启动: http://${host}:${actual}`);
    console.log(`数据目录: ${DATA_DIR}`);
    console.log('提示: POST /api/analyses 运行分析；GET /api/health 健康检查');
    return;
  }

  const db = openDatabase(DB_PATH);

  switch (cmd) {
    case 'import': {
      const matrixPath = arg(args, '--matrix');
      const theta = Number(arg(args, '--theta'));
      const rho = Number(arg(args, '--rho'));
      const name = arg(args, '--name');
      if (!matrixPath || !Number.isFinite(theta) || !Number.isFinite(rho)) usage();
      const matrix = await readMatrix(matrixPath);
      const rec = saveAnalysis(db, matrix, { thetaStepDeg: theta, rhoStep: rho }, name);
      console.log(`已保存分析 id=${rec.id} name=${rec.name}`);
      console.log(`矩阵 ${rec.meta.width}x${rec.meta.height}，边缘点 ${rec.meta.edgePointCount}，角度格 ${rec.meta.thetaBins}，总票数 ${rec.meta.totalVotes}`);
      console.log('票数最高的前 10 个候选格:');
      printCells(selectCandidates(rec, { minVotes: 1, limit: 10 }));
      break;
    }
    case 'list': {
      const rows = listAnalyses(db);
      for (const r of rows) {
        console.log(`${r.id}  ${r.name}  点${r.meta.edgePointCount}  角格${r.meta.thetaBins}  rhoStep=${r.meta.rhoStep}  ${r.createdAt}`);
      }
      if (rows.length === 0) console.log('(无记录)');
      break;
    }
    case 'get': {
      const rec = getAnalysis(db, requireId(args[0]));
      if (!rec) throw new HoughError('NOT_FOUND', '分析不存在');
      console.log(`id=${rec.id} name=${rec.name} createdAt=${rec.createdAt}`);
      console.log(JSON.stringify(rec.meta));
      printCells(rec.cells);
      break;
    }
    case 'candidates': {
      const rec = must(db, args[0]);
      const minVotes = Number(arg(args, '--min-votes') ?? '1');
      const limit = Number(arg(args, '--limit') ?? '50');
      printCells(selectCandidates(rec, { minVotes, limit }));
      break;
    }
    case 'slice': {
      const rec = must(db, args[0]);
      const thetaIndex = Number(args[1]);
      const cells = angleSlice(rec, thetaIndex);
      console.log(`thetaIndex=${thetaIndex} (${thetaIndex * rec.meta.thetaStepDeg}°) 切片上的有票格:`);
      printCells(cells);
      break;
    }
    case 'support': {
      const rec = must(db, args[0]);
      const thetaIndex = Number(args[1]);
      const rhoIndex = Number(args[2]);
      const page = Number(arg(args, '--page') ?? '0');
      const pageSize = Number(arg(args, '--page-size') ?? '100');
      const s = supportPoints(rec, thetaIndex, rhoIndex, page, pageSize);
      printSupport(s.points, s.total, page, pageSize);
      break;
    }
    case 'compare': {
      const a = must(db, args[0]);
      const b = must(db, args[1]);
      const minVotes = Number(arg(args, '--min-votes') ?? '1');
      const limit = Number(arg(args, '--limit') ?? '20');
      console.log(JSON.stringify(compareAnalyses(a, b, { minVotes, limit }), null, 2));
      break;
    }
    case 'export': {
      const rec = must(db, args[0]);
      const out = arg(args, '--out');
      const text = exportAnalysis(rec);
      if (out) await writeFile(resolve(out), text, 'utf8');
      else console.log(text);
      break;
    }
    default:
      usage();
  }
}

function requireId(v: string | undefined): string {
  if (!v) usage();
  return v;
}

function must(database: ReturnType<typeof openDatabase>, id: string | undefined) {
  const rec = getAnalysis(database, requireId(id));
  if (!rec) throw new HoughError('NOT_FOUND', `分析 ${id} 不存在`);
  return rec;
}

main().catch((err: unknown) => {
  if (err instanceof HoughError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error('错误:', err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
