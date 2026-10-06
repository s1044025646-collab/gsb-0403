import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Cell, GridConfig, HoughError, VoteResult } from "./hough";

export interface AnalysisMeta {
  id: number;
  createdAt: string;
  width: number;
  height: number;
  thetaStepDeg: number;
  rhoStep: number;
  nTheta: number;
  rhoRadius: number;
  edgeCount: number;
  totalVotes: number;
  note: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        matrix_json TEXT NOT NULL,
        theta_step_deg REAL NOT NULL,
        rho_step REAL NOT NULL,
        n_theta INTEGER NOT NULL,
        rho_radius INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        total_votes INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS votes (
        analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
        theta_idx INTEGER NOT NULL,
        rho_idx INTEGER NOT NULL,
        votes INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, theta_idx, rho_idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // Save matrix snapshot + full accumulator atomically; failures leave nothing behind.
  saveAnalysis(matrix: number[][], result: VoteResult, note: string | null): number {
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare(
        `INSERT INTO analyses
         (created_at, width, height, matrix_json, theta_step_deg, rho_step, n_theta, rho_radius, edge_count, total_votes, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const r = ins.run(
        new Date().toISOString(),
        result.width,
        result.height,
        JSON.stringify(matrix),
        result.thetaStepDeg,
        result.rhoStep,
        result.nTheta,
        result.rhoRadius,
        result.edgeCount,
        result.totalVotes,
        note,
      );
      const id = Number(r.lastInsertRowid);
      const insVote = this.db.prepare(
        "INSERT INTO votes (analysis_id, theta_idx, rho_idx, votes) VALUES (?, ?, ?, ?)",
      );
      for (let k = 0; k < result.nTheta; k++) {
        const row = result.acc[k];
        for (let i = 0; i < row.length; i++) {
          if (row[i] > 0) insVote.run(id, k, i - result.rhoRadius, row[i]);
        }
      }
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMeta(id: number): AnalysisMeta {
    const row = this.db
      .prepare(
        `SELECT id, created_at, width, height, theta_step_deg, rho_step, n_theta, rho_radius, edge_count, total_votes, note
         FROM analyses WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HoughError("NOT_FOUND", `analysis ${id} not found`);
    return {
      id: row.id as number,
      createdAt: row.created_at as string,
      width: row.width as number,
      height: row.height as number,
      thetaStepDeg: row.theta_step_deg as number,
      rhoStep: row.rho_step as number,
      nTheta: row.n_theta as number,
      rhoRadius: row.rho_radius as number,
      edgeCount: row.edge_count as number,
      totalVotes: row.total_votes as number,
      note: (row.note as string) ?? null,
    };
  }

  listAnalyses(): AnalysisMeta[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, width, height, theta_step_deg, rho_step, n_theta, rho_radius, edge_count, total_votes, note
         FROM analyses ORDER BY id`,
      )
      .all() as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      createdAt: row.created_at as string,
      width: row.width as number,
      height: row.height as number,
      thetaStepDeg: row.theta_step_deg as number,
      rhoStep: row.rho_step as number,
      nTheta: row.n_theta as number,
      rhoRadius: row.rho_radius as number,
      edgeCount: row.edge_count as number,
      totalVotes: row.total_votes as number,
      note: (row.note as string) ?? null,
    }));
  }

  getMatrix(id: number): number[][] {
    const row = this.db.prepare("SELECT matrix_json FROM analyses WHERE id = ?").get(id) as
      | { matrix_json: string }
      | undefined;
    if (!row) throw new HoughError("NOT_FOUND", `analysis ${id} not found`);
    return JSON.parse(row.matrix_json);
  }

  getGrid(id: number): GridConfig {
    const meta = this.getMeta(id);
    return { thetaStepDeg: meta.thetaStepDeg, rhoStep: meta.rhoStep };
  }

  getCell(id: number, thetaIdx: number, rhoIdx: number): Cell {
    const meta = this.getMeta(id);
    if (!Number.isInteger(thetaIdx) || thetaIdx < 0 || thetaIdx >= meta.nTheta) {
      throw new HoughError("BAD_REQUEST", `thetaIdx must be an integer in [0, ${meta.nTheta - 1}]`);
    }
    if (!Number.isInteger(rhoIdx) || Math.abs(rhoIdx) > meta.rhoRadius) {
      throw new HoughError(
        "BAD_REQUEST",
        `rhoIdx must be an integer in [${-meta.rhoRadius}, ${meta.rhoRadius}]`,
      );
    }
    const row = this.db
      .prepare("SELECT votes FROM votes WHERE analysis_id = ? AND theta_idx = ? AND rho_idx = ?")
      .get(id, thetaIdx, rhoIdx) as { votes: number } | undefined;
    return {
      thetaIdx,
      rhoIdx,
      thetaDeg: thetaIdx * meta.thetaStepDeg,
      rho: rhoIdx * meta.rhoStep,
      votes: row ? row.votes : 0,
    };
  }

  // All cells of one theta slice with votes > 0, ordered by rhoIdx.
  getSlice(id: number, thetaIdx: number): Cell[] {
    const meta = this.getMeta(id);
    if (!Number.isInteger(thetaIdx) || thetaIdx < 0 || thetaIdx >= meta.nTheta) {
      throw new HoughError("BAD_REQUEST", `thetaIdx must be an integer in [0, ${meta.nTheta - 1}]`);
    }
    const rows = this.db
      .prepare(
        "SELECT rho_idx, votes FROM votes WHERE analysis_id = ? AND theta_idx = ? ORDER BY rho_idx",
      )
      .all(id, thetaIdx) as unknown as { rho_idx: number; votes: number }[];
    return rows.map((r) => ({
      thetaIdx,
      rhoIdx: r.rho_idx,
      thetaDeg: thetaIdx * meta.thetaStepDeg,
      rho: r.rho_idx * meta.rhoStep,
      votes: r.votes,
    }));
  }

  // Candidates from stored votes: votes >= minVotes, votes desc, thetaIdx asc, rhoIdx asc.
  getCandidates(id: number, minVotes: number, limit: number): Cell[] {
    const meta = this.getMeta(id);
    const rows = this.db
      .prepare(
        `SELECT theta_idx, rho_idx, votes FROM votes
         WHERE analysis_id = ? AND votes >= ?
         ORDER BY votes DESC, theta_idx ASC, rho_idx ASC
         LIMIT ?`,
      )
      .all(id, minVotes, limit) as unknown as { theta_idx: number; rho_idx: number; votes: number }[];
    return rows.map((r) => ({
      thetaIdx: r.theta_idx,
      rhoIdx: r.rho_idx,
      thetaDeg: r.theta_idx * meta.thetaStepDeg,
      rho: r.rho_idx * meta.rhoStep,
      votes: r.votes,
    }));
  }

  exportAnalysis(id: number): Record<string, unknown> {
    const meta = this.getMeta(id);
    const matrix = this.getMatrix(id);
    const rows = this.db
      .prepare("SELECT theta_idx, rho_idx, votes FROM votes WHERE analysis_id = ? ORDER BY theta_idx, rho_idx")
      .all(id) as unknown as { theta_idx: number; rho_idx: number; votes: number }[];
    return {
      format: "hough-edge-analysis/1",
      coordinateConvention:
        "origin at top-left; column = x, row = y; pixel centers at integer coordinates; rho = x*cos(theta) + y*sin(theta); rhoIdx = floor(rho/rhoStep + 0.5)",
      meta,
      matrix,
      votes: rows.map((r) => ({
        thetaIdx: r.theta_idx,
        rhoIdx: r.rho_idx,
        thetaDeg: r.theta_idx * meta.thetaStepDeg,
        rho: r.rho_idx * meta.rhoStep,
        votes: r.votes,
      })),
    };
  }
}
