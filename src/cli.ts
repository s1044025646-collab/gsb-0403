import fs from "node:fs";
import path from "node:path";
import { Cell, runVote, supportPoints, validateGrid, validateMatrix } from "./hough";
import { Store } from "./store";

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function dbPath(args: string[]): string {
  return argValue(args, "db") ?? path.join(process.cwd(), "data", "hough.db");
}

function printCells(cells: Cell[]): void {
  console.log("thetaIdx  thetaDeg  rhoIdx      rho  votes");
  for (const c of cells) {
    console.log(
      `${String(c.thetaIdx).padStart(8)} ${String(c.thetaDeg).padStart(9)} ${String(c.rhoIdx).padStart(7)} ${String(c.rho).padStart(9)} ${String(c.votes).padStart(6)}`,
    );
  }
}

const USAGE = `hough-edge-cli <command> [options] [--db <path>]

Commands:
  import <matrix.json> --theta-step <deg> --rho-step <s> [--note <text>]
  list
  show <id>
  candidates <id> [--min-votes N] [--limit N]
  slice <id> <thetaIdx>
  points <id> <thetaIdx> <rhoIdx> [--offset N] [--limit N]
  compare <idA> <idB> [--min-votes N] [--limit N]
  export <id> [out.json]
  demo

matrix.json: JSON 0/1 2D array, or { "matrix": [[...]] }.
`;

function loadMatrixFile(file: string): number[][] {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const matrix = Array.isArray(data) ? data : data.matrix;
  return validateMatrix(matrix);
}

function runDemo(store: Store): void {
  // Vertical line x = 2 in a 6x6 image.
  const vertical = Array.from({ length: 6 }, () => [0, 0, 1, 0, 0, 0]);
  // Horizontal line y = 3 in a 6x6 image.
  const horizontal = Array.from({ length: 6 }, (_, y) =>
    y === 3 ? [1, 1, 1, 1, 1, 1] : [0, 0, 0, 0, 0, 0],
  );
  // Crossing lines: x = 2 and y = 3 share the point (2, 3).
  const cross = vertical.map((row, y) => row.map((v, x) => (v === 1 || y === 3 ? 1 : 0)));

  const grid = { thetaStepDeg: 90, rhoStep: 1 };
  const cases: [string, number[][]][] = [
    ["vertical line x=2", vertical],
    ["horizontal line y=3", horizontal],
    ["crossing lines x=2 and y=3 (shared point (2,3))", cross],
  ];
  for (const [name, matrix] of cases) {
    const result = runVote(matrix, grid);
    const id = store.saveAnalysis(matrix, result, `demo: ${name}`);
    console.log(`\n=== demo: ${name} (analysis ${id}) ===`);
    console.log(`edge points: ${result.edgeCount}, total votes: ${result.totalVotes}`);
    printCells(store.getCandidates(id, 1, 4));
  }

  // Show how the shared point (2,3) votes in both line cells of the cross image.
  const crossId = store.listAnalyses().at(-1)!.id;
  const gridCfg = store.getGrid(crossId);
  const matrix = store.getMatrix(crossId);
  for (const [thetaIdx, rhoIdx, label] of [
    [0, 2, "theta=0 (normal along +x), rho=2 -> vertical line x=2"],
    [1, 3, "theta=90 (normal along +y), rho=3 -> horizontal line y=3"],
  ] as const) {
    const pts = supportPoints(matrix, gridCfg, thetaIdx, rhoIdx);
    const cell = store.getCell(crossId, thetaIdx, rhoIdx);
    console.log(`\ncell thetaIdx=${thetaIdx} rhoIdx=${rhoIdx}: ${label}`);
    console.log(`votes=${cell.votes}, support points: ${pts.map((p) => `(${p.x},${p.y})`).join(" ")}`);
  }
  console.log(
    "\nNote: the shared point (2,3) appears in both cells: each edge point casts one vote per theta bin, so an intersection contributes to every line it lies on.",
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const store = new Store(dbPath(args));
  try {
    switch (cmd) {
      case "import": {
        const file = args[1];
        if (!file) throw new Error("usage: import <matrix.json> --theta-step <deg> --rho-step <s>");
        const matrix = loadMatrixFile(file);
        const grid = validateGrid({
          thetaStepDeg: Number(argValue(args, "theta-step") ?? 1),
          rhoStep: Number(argValue(args, "rho-step") ?? 1),
        });
        const note = argValue(args, "note");
        const result = runVote(matrix, grid);
        const id = store.saveAnalysis(matrix, result, note);
        console.log(`saved analysis ${id}`);
        console.log(JSON.stringify(store.getMeta(id), null, 2));
        printCells(store.getCandidates(id, 1, 10));
        break;
      }
      case "list": {
        for (const m of store.listAnalyses()) {
          console.log(
            `#${m.id} ${m.createdAt} ${m.width}x${m.height} thetaStep=${m.thetaStepDeg} rhoStep=${m.rhoStep} edges=${m.edgeCount} votes=${m.totalVotes}${m.note ? ` note="${m.note}"` : ""}`,
          );
        }
        break;
      }
      case "show": {
        console.log(JSON.stringify(store.getMeta(Number(args[1])), null, 2));
        break;
      }
      case "candidates": {
        const id = Number(args[1]);
        const minVotes = Number(argValue(args, "min-votes") ?? 1);
        const limit = Number(argValue(args, "limit") ?? 20);
        printCells(store.getCandidates(id, minVotes, limit));
        break;
      }
      case "slice": {
        const id = Number(args[1]);
        const thetaIdx = Number(args[2]);
        printCells(store.getSlice(id, thetaIdx));
        break;
      }
      case "points": {
        const id = Number(args[1]);
        const thetaIdx = Number(args[2]);
        const rhoIdx = Number(args[3]);
        const offset = Number(argValue(args, "offset") ?? 0);
        const limit = Number(argValue(args, "limit") ?? 100);
        const cell = store.getCell(id, thetaIdx, rhoIdx);
        const all = supportPoints(store.getMatrix(id), store.getGrid(id), thetaIdx, rhoIdx);
        console.log(
          `cell thetaIdx=${thetaIdx} theta=${cell.thetaDeg}deg rhoIdx=${rhoIdx} rho=${cell.rho} votes=${cell.votes}`,
        );
        console.log(`total support points: ${all.length} (showing ${offset}..${offset + limit - 1})`);
        for (const p of all.slice(offset, offset + limit)) console.log(`  (${p.x}, ${p.y})`);
        break;
      }
      case "compare": {
        const a = Number(args[1]);
        const b = Number(args[2]);
        const minVotes = Number(argValue(args, "min-votes") ?? 1);
        const limit = Number(argValue(args, "limit") ?? 10);
        for (const [label, id] of [["A", a], ["B", b]] as const) {
          const meta = store.getMeta(id);
          console.log(
            `\n[${label}] analysis #${id}: thetaStep=${meta.thetaStepDeg} rhoStep=${meta.rhoStep} edges=${meta.edgeCount}`,
          );
          printCells(store.getCandidates(id, minVotes, limit));
        }
        console.log(
          "\nCaveat: different resolutions form different analyses; changed quantized candidates do not imply the source image changed.",
        );
        break;
      }
      case "export": {
        const id = Number(args[1]);
        const data = store.exportAnalysis(id);
        const out = args[2] ?? `analysis-${id}.json`;
        fs.writeFileSync(out, JSON.stringify(data, null, 2));
        console.log(`exported analysis ${id} to ${out}`);
        break;
      }
      case "demo": {
        runDemo(store);
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`error${err.code ? ` [${err.code}]` : ""}: ${err.message ?? e}`);
  process.exitCode = 1;
}
