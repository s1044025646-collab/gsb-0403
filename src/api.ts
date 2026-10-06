import http from "node:http";
import { URL } from "node:url";
import {
  HoughError,
  runVote,
  supportPoints,
  validateGrid,
  validateMatrix,
} from "./hough";
import { Store } from "./store";

const MAX_LIMIT = 1000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HoughError) {
    const status =
      err.code === "NOT_FOUND" ? 404 : err.code === "BUDGET_EXCEEDED" || err.code === "MATRIX_TOO_LARGE" ? 413 : 400;
    sendJson(res, status, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new HoughError("BAD_REQUEST", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new HoughError("BAD_REQUEST", `query param ${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      // POST /api/analyses  { matrix, thetaStepDeg, rhoStep, note? }
      if (method === "POST" && path === "/api/analyses") {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          throw new HoughError("BAD_REQUEST", "request body must be valid JSON");
        }
        if (typeof body !== "object" || body === null) {
          throw new HoughError("BAD_REQUEST", "request body must be a JSON object");
        }
        const b = body as Record<string, unknown>;
        const matrix = validateMatrix(b.matrix);
        const grid = validateGrid({ thetaStepDeg: b.thetaStepDeg, rhoStep: b.rhoStep });
        const note = typeof b.note === "string" ? b.note : null;
        const result = runVote(matrix, grid); // throws before any DB write on budget overflow
        const id = store.saveAnalysis(matrix, result, note);
        const meta = store.getMeta(id);
        sendJson(res, 201, { meta, candidates: store.getCandidates(id, 1, 20) });
        return;
      }

      // GET /api/analyses
      if (method === "GET" && path === "/api/analyses") {
        sendJson(res, 200, { analyses: store.listAnalyses() });
        return;
      }

      const m = path.match(/^\/api\/analyses\/(\d+)(\/(candidates|slice|cells|export|compare))?(\/.*)?$/);
      if (m && method === "GET") {
        const id = Number(m[1]);
        const sub = m[3];
        const rest = m[4] ?? "";

        if (!sub) {
          sendJson(res, 200, { meta: store.getMeta(id) });
          return;
        }
        if (sub === "candidates") {
          const minVotes = intParam(url, "minVotes", 1, 1, 1_000_000);
          const limit = intParam(url, "limit", 20, 1, MAX_LIMIT);
          sendJson(res, 200, { meta: store.getMeta(id), candidates: store.getCandidates(id, minVotes, limit) });
          return;
        }
        if (sub === "slice") {
          const thetaIdx = intParam(url, "thetaIdx", -1, 0, 179);
          if (thetaIdx < 0) throw new HoughError("BAD_REQUEST", "query param thetaIdx is required");
          sendJson(res, 200, { cells: store.getSlice(id, thetaIdx) });
          return;
        }
        if (sub === "cells") {
          const cm = rest.match(/^\/(-?\d+)\/(-?\d+)\/points$/);
          if (!cm) throw new HoughError("BAD_REQUEST", "expected /api/analyses/:id/cells/:thetaIdx/:rhoIdx/points");
          const thetaIdx = Number(cm[1]);
          const rhoIdx = Number(cm[2]);
          const cell = store.getCell(id, thetaIdx, rhoIdx);
          const offset = intParam(url, "offset", 0, 0, 1_000_000);
          const limit = intParam(url, "limit", 100, 1, MAX_LIMIT);
          const matrix = store.getMatrix(id);
          const grid = store.getGrid(id);
          const all = supportPoints(matrix, grid, thetaIdx, rhoIdx);
          sendJson(res, 200, {
            cell,
            totalPoints: all.length,
            offset,
            limit,
            points: all.slice(offset, offset + limit),
          });
          return;
        }
        if (sub === "export") {
          const data = store.exportAnalysis(id);
          const json = JSON.stringify(data, null, 2);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="analysis-${id}.json"`,
          });
          res.end(json);
          return;
        }
        if (sub === "compare") {
          const otherRaw = url.searchParams.get("with");
          if (!otherRaw || !/^\d+$/.test(otherRaw)) {
            throw new HoughError("BAD_REQUEST", "query param 'with' must be another analysis id");
          }
          const otherId = Number(otherRaw);
          const minVotes = intParam(url, "minVotes", 1, 1, 1_000_000);
          const limit = intParam(url, "limit", 10, 1, MAX_LIMIT);
          sendJson(res, 200, {
            a: { meta: store.getMeta(id), candidates: store.getCandidates(id, minVotes, limit) },
            b: { meta: store.getMeta(otherId), candidates: store.getCandidates(otherId, minVotes, limit) },
            caveat:
              "Different resolutions form different analyses; changed quantized candidates do not imply the source image changed.",
          });
          return;
        }
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}
