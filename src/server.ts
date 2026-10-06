import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { HoughError, selectCandidates, supportPoints, angleSlice, type Cell } from './hough.js';
import { saveAnalysis, getAnalysis, listAnalyses, exportAnalysis, compareAnalyses } from './db.js';

export interface ApiDeps {
  db: DatabaseSync;
  baseUrl?: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (deps: ApiDeps, req: IncomingMessage, res: ServerResponse, params: RegExpMatchArray, body: unknown) => unknown;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: () => ({ status: 'ok' }) },
  { method: 'POST', pattern: /^\/api\/analyses$/, handler: (deps, _r, _s, _p, body) => createAnalysis(deps, body) },
  { method: 'GET', pattern: /^\/api\/analyses$/, handler: (deps) => ({ analyses: listAnalyses(deps.db) }) },
  { method: 'GET', pattern: /^\/api\/analyses\/([\w-]+)$/, handler: (deps, _r, _s, p) => mustAnalysis(deps, p[1] as string) },
  {
    method: 'GET',
    pattern: /^\/api\/analyses\/([\w-]+)\/candidates$/,
    handler: (deps, req, _s, p) => candidates(deps, req, p[1] as string),
  },
  {
    method: 'GET',
    pattern: /^\/api\/analyses\/([\w-]+)\/slices\/(\d+)$/,
    handler: (deps, _r, _s, p) => {
      const rec = mustAnalysis(deps, p[1] as string);
      const thetaIndex = Number(p[2]);
      return { thetaIndex, cells: angleSlice(rec, thetaIndex) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/analyses\/([\w-]+)\/cells\/(-?\d+)\/(-?\d+)\/support$/,
    handler: (deps, req, _s, p) => {
      const rec = mustAnalysis(deps, p[1] as string);
      const thetaIndex = Number(p[2]);
      const rhoIndex = Number(p[3]);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const page = Number(url.searchParams.get('page') ?? '0');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '100');
      const support = supportPoints(rec, thetaIndex, rhoIndex, page, pageSize);
      const cell: Cell | undefined = rec.cells.find((c) => c.thetaIndex === thetaIndex && c.rhoIndex === rhoIndex);
      return { cell: cell ?? null, ...support };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/analyses\/([\w-]+)\/export$/,
    handler: (deps, _r, res, p) => {
      const rec = mustAnalysis(deps, p[1] as string);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${rec.id}.json"`);
      res.end(exportAnalysis(rec));
      return undefined;
    },
  },
  { method: 'POST', pattern: /^\/api\/compare$/, handler: (deps, _r, _s, _p, body) => compare(deps, body) },
];

function createAnalysis(deps: ApiDeps, body: unknown) {
  if (typeof body !== 'object' || body === null) {
    throw new HoughError('INVALID_BODY', '请求体必须是 JSON 对象');
  }
  const b = body as { matrix?: unknown; config?: unknown; name?: unknown };
  if (typeof b.name !== 'undefined' && typeof b.name !== 'string') {
    throw new HoughError('INVALID_BODY', 'name 必须是字符串');
  }
  const rec = saveAnalysis(deps.db, b.matrix, b.config, b.name);
  return { id: rec.id, meta: rec.meta, cells: rec.cells };
}

function mustAnalysis(deps: ApiDeps, id: string) {
  const rec = getAnalysis(deps.db, id);
  if (!rec) throw new HoughError('NOT_FOUND', `分析 ${id} 不存在`);
  return rec;
}

function candidates(deps: ApiDeps, req: IncomingMessage, id: string) {
  const rec = mustAnalysis(deps, id);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const minVotes = Number(url.searchParams.get('minVotes') ?? '1');
  const limit = Number(url.searchParams.get('limit') ?? String(rec.cells.length || 1));
  const cells = selectCandidates(rec, { minVotes, limit });
  return {
    meta: { ...rec.meta, returned: cells.length },
    candidates: cells,
    note: '候选是参数格而非线段；相邻格可能表示相近几何直线，本服务不做合并。',
  };
}

function compare(deps: ApiDeps, body: unknown) {
  if (typeof body !== 'object' || body === null) throw new HoughError('INVALID_BODY', '请求体必须是 JSON 对象');
  const b = body as { a?: unknown; b?: unknown; minVotes?: unknown; limit?: unknown };
  if (typeof b.a !== 'string' || typeof b.b !== 'string') {
    throw new HoughError('INVALID_BODY', 'a 与 b 必须是分析 id 字符串');
  }
  const a = mustAnalysis(deps, b.a);
  const other = mustAnalysis(deps, b.b);
  const minVotes = typeof b.minVotes === 'number' ? b.minVotes : 1;
  const limit = typeof b.limit === 'number' ? b.limit : 50;
  return compareAnalyses(a, other, { minVotes, limit });
}

const ERROR_STATUS: Record<string, number> = {
  INVALID_MATRIX: 400,
  INVALID_CONFIG: 400,
  INVALID_THETA_STEP: 400,
  INVALID_RHO_STEP: 400,
  INVALID_QUERY: 400,
  INVALID_CELL: 400,
  INVALID_BODY: 400,
  MATRIX_TOO_LARGE: 413,
  GRID_TOO_LARGE: 413,
  VOTE_BUDGET_EXCEEDED: 413,
  NOT_FOUND: 404,
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 8 * 1024 * 1024) throw new HoughError('BODY_TOO_LARGE', '请求体超过 8MB 限制');
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HoughError('INVALID_BODY', '请求体不是合法 JSON');
  }
}

export function createApiServer(deps: ApiDeps): Server {
  return createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
      if (!route) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${pathname}` } });
        return;
      }
      const match = pathname.match(route.pattern) as RegExpMatchArray;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readJson(req) : null;
      const result = route.handler(deps, req, res, match, body);
      if (result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof HoughError) {
        sendJson(res, ERROR_STATUS[err.code] ?? 400, { error: { code: err.code, message: err.message } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: { code: 'INTERNAL', message } });
      }
    }
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function listenFree(server: Server, preferredPort: number, host = '127.0.0.1'): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 端口 0 让操作系统分配空闲端口；非 0 被占用时 Node 会抛 EADDRINUSE，回退到 0。
    server.listen(preferredPort, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve({ port: addr.port });
      else reject(new Error('无法获取监听端口'));
    });
  });
}

export async function listenWithFallback(server: Server, preferredPort: number, host = '127.0.0.1'): Promise<{ port: number }> {
  try {
    return await listenFree(server, preferredPort, host);
  } catch (err) {
    if (preferredPort === 0 || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return listenFree(server, 0, host);
  }
}
