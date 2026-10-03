import path from "node:path";
import fs from "node:fs";
import { Ops } from "./ops.js";
import { createApp } from "./http.js";

// Tiny .env loader (no extra dependency)
const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = path.resolve(process.env.WORKSPACE_ROOT ?? "./workspace");
const TOKEN = process.env.AUTH_TOKEN ?? "";

if (TOKEN.length < 16 || TOKEN === "change-me") {
  console.error("Refusing to start: set AUTH_TOKEN (16+ chars) in .env. Generate one with: openssl rand -hex 32");
  process.exit(1);
}

const ops = new Ops(ROOT);
await ops.init();
createApp(ops, TOKEN).listen(PORT, "127.0.0.1", () => {
  console.log(`MCP file server on http://127.0.0.1:${PORT}/mcp  (workspace: ${ROOT})`);
});
