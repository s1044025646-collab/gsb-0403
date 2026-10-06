import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runHough, type AnalysisResult, type Cell, type Point } from './hough.js';

export interface AnalysisRecord extends AnalysisResult {
  id: string;
  name: string;
  createdAt: string;
  matrix: number[][];
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      theta_step_deg INTEGER NOT NULL,
      rho_step REAL NOT NULL,
      theta_bins INTEGER NOT NULL,
      rho_index_min INTEGER NOT NULL,
      rho_index_max INTEGER NOT NULL,
      edge_point_count INTEGER NOT NULL,
      total_votes INTEGER NOT NULL,
      vote_budget INTEGER NOT NULL,
      matrix_json TEXT NOT NULL,
      points_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cells (
      analysis_id TEXT NOT NULL,
      theta_index INTEGER NOT NULL,
      rho_index INTEGER NOT NULL,
      theta_deg INTEGER NOT NULL,
      rho REAL NOT NULL,
      votes INTEGER NOT NULL,
      PRIMARY KEY (analysis_id, theta_index, rho_index),
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cells_analysis ON cells(analysis_id);
  `);
  return db;
}

/** 校验 + 投票 + 事务持久化；投票失败时不写任何数据。 */
export function saveAnalysis(
  db: DatabaseSync,
  matrix: unknown,
  config: unknown,
  name?: string,
): AnalysisRecord {
  // 先完成全部校验与计算，再进入事务，避免半张成功累加器/半成品记录。
  const result = runHough(matrix, config);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const label = name ?? `analysis-${id.slice(0, 8)}`;

  const insertAnalysis = db.prepare(`
    INSERT INTO analyses (id, name, created_at, width, height, theta_step_deg, rho_step,
      theta_bins, rho_index_min, rho_index_max, edge_point_count, total_votes, vote_budget,
      matrix_json, points_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCell = db.prepare(`
    INSERT INTO cells (analysis_id, theta_index, rho_index, theta_deg, rho, votes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // node:sqlite 在 Node 22.5+ 为实验 API；@types/node 部分版本未暴露 transaction 辅助方法，
  // 这里用显式 BEGIN/COMMIT 保证原子写入。
  db.exec('BEGIN IMMEDIATE');
  try {
    insertAnalysis.run(
      id, label, createdAt, result.meta.width, result.meta.height,
      result.meta.thetaStepDeg, result.meta.rhoStep, result.meta.thetaBins,
      result.meta.rhoIndexMin, result.meta.rhoIndexMax, result.meta.edgePointCount,
      result.meta.totalVotes, result.meta.voteBudget,
      JSON.stringify(matrix), JSON.stringify(result.edgePoints),
    );
    for (const cell of result.cells) {
      insertCell.run(id, cell.thetaIndex, cell.rhoIndex, cell.thetaDeg, cell.rho, cell.votes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ...result, id, name: label, createdAt, matrix: matrix as number[][] };
}

interface AnalysisRow {
  id: string; name: string; created_at: string;
  width: number; height: number; theta_step_deg: number; rho_step: number;
  theta_bins: number; rho_index_min: number; rho_index_max: number;
  edge_point_count: number; total_votes: number; vote_budget: number;
  matrix_json: string;
  points_json: string;
}

export function getAnalysis(db: DatabaseSync, id: string): AnalysisRecord | null {
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as unknown as AnalysisRow | undefined;
  if (!row) return null;
  const cellRows = db
    .prepare('SELECT theta_index, rho_index, theta_deg, rho, votes FROM cells WHERE analysis_id = ? ORDER BY theta_index, rho_index')
    .all(id) as unknown as Array<{ theta_index: number; rho_index: number; theta_deg: number; rho: number; votes: number }>;
  return hydrate(row, cellRows);
}

export function listAnalyses(db: DatabaseSync): Array<Pick<AnalysisRecord, 'id' | 'name' | 'createdAt' | 'meta'>> {
  const rows = db.prepare('SELECT * FROM analyses ORDER BY created_at DESC').all() as unknown as AnalysisRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    meta: metaFromRow(row),
  }));
}

function metaFromRow(row: AnalysisRow) {
  return {
    thetaStepDeg: row.theta_step_deg,
    rhoStep: row.rho_step,
    width: row.width,
    height: row.height,
    thetaBins: row.theta_bins,
    rhoIndexMin: row.rho_index_min,
    rhoIndexMax: row.rho_index_max,
    edgePointCount: row.edge_point_count,
    totalVotes: row.total_votes,
    voteBudget: row.vote_budget,
  };
}

function hydrate(row: AnalysisRow, cellRows: Array<{ theta_index: number; rho_index: number; theta_deg: number; rho: number; votes: number }>): AnalysisRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    meta: metaFromRow(row),
    edgePoints: JSON.parse(row.points_json) as Point[],
    matrix: JSON.parse(row.matrix_json) as number[][],
    cells: cellRows.map((c) => ({
      thetaIndex: c.theta_index,
      rhoIndex: c.rho_index,
      thetaDeg: c.theta_deg,
      rho: c.rho,
      votes: c.votes,
    })),
  };
}

export function exportAnalysis(record: AnalysisRecord): string {
  return JSON.stringify(
    {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      coordinateSystem: { origin: 'top-left', x: 'column', y: 'row', pixelCenter: 'integer' },
      meta: record.meta,
      matrix: record.matrix,
      note: 'cells 为参数空间累加器格，不是线段；相邻格可能描述同一条几何直线。',
      cells: record.cells,
    },
    null,
    2,
  );
}

/**
 * 比较两次分析（通常是同一矩阵的不同分辨率）。
 * 只并排报告各自候选；量化差异不得解释为原图变化。
 */
export function compareAnalyses(
  a: AnalysisRecord,
  b: AnalysisRecord,
  opts: { minVotes: number; limit: number },
) {
  return {
    a: {
      id: a.id, name: a.name,
      thetaStepDeg: a.meta.thetaStepDeg, rhoStep: a.meta.rhoStep,
      thetaBins: a.meta.thetaBins,
      cells: a.cells.filter((c) => c.votes >= opts.minVotes).slice(0, opts.limit),
    },
    b: {
      id: b.id, name: b.name,
      thetaStepDeg: b.meta.thetaStepDeg, rhoStep: b.meta.rhoStep,
      thetaBins: b.meta.thetaBins,
      cells: b.cells.filter((c) => c.votes >= opts.minVotes).slice(0, opts.limit),
    },
    note: '候选差异来自量化网格分辨率，不表示原始图像发生了变化；本服务不做近邻格合并。',
  };
}

