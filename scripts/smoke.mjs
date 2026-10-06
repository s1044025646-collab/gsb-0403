// Smoke test: start server on a free port, exercise the API, shut down.
import { spawn } from "node:child_process";
import fs from "node:fs";

const db = "data/smoke.db";
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.rmSync(db + suffix); } catch {}
}
const child = spawn(process.execPath, ["dist/server.js", "--port", "0", "--db", db], {
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((resolve, reject) => {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    const m = buf.match(/127\.0\.0\.1:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  child.on("exit", () => reject(new Error("server exited early")));
  setTimeout(() => reject(new Error("timeout waiting for port")), 10000);
});
const base = `http://127.0.0.1:${port}`;
const vertical = Array.from({ length: 6 }, () => [0, 0, 1, 0, 0, 0]);

const created = await fetch(`${base}/api/analyses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ matrix: vertical, thetaStepDeg: 90, rhoStep: 1 }),
}).then((r) => r.json());
console.log("created:", JSON.stringify(created.meta));
console.log("top candidate:", JSON.stringify(created.candidates[0]));

const id = created.meta.id;
const points = await fetch(`${base}/api/analyses/${id}/cells/0/2/points?limit=3`).then((r) => r.json());
console.log("cell points:", JSON.stringify(points));

const bad = await fetch(`${base}/api/analyses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ matrix: [[1, 2]], thetaStepDeg: 90, rhoStep: 1 }),
});
console.log("invalid matrix ->", bad.status, JSON.stringify(await bad.json()));

child.kill("SIGINT");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.rmSync(db + suffix); } catch {}
}
console.log("smoke test OK");
