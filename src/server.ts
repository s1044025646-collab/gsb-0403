import path from "node:path";
import { createServer } from "./api";
import { Store } from "./store";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const portArg = argValue("port") ?? process.env.PORT ?? "0";
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid port: ${portArg}`);
  process.exit(2);
}

const dbPath = argValue("db") ?? path.join(process.cwd(), "data", "hough.db");
const store = new Store(dbPath);
const server = createServer(store);

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`hough-edge-server listening on http://127.0.0.1:${actual}`);
  console.log(`database: ${dbPath}`);
});

process.on("SIGINT", () => {
  server.close();
  store.close();
  process.exit(0);
});
