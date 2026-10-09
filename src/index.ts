import { loadConfig } from "./config.js";
import { createServices } from "./core/services.js";
import { createApp } from "./transport/app.js";
import { createAuthenticator } from "./transport/auth.js";

const config = loadConfig();
const services = createServices(config);

try {
  const repo = await services.git.ensureRepo();
  console.log(repo.created ? "[git] initialised workspace repo" : "[git] workspace repo ready");
} catch (err) {
  // the file tools still work; git tools will report the problem
  console.warn("[git] unavailable:", (err as Error).message);
}

const app = createApp(services, createAuthenticator(config.agentTokens));

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`mcp-workspace listening on http://127.0.0.1:${config.port}/mcp`);
  console.log(`workspace root: ${config.workspaceRoot}`);
  console.log(`agents configured: ${[...config.agentTokens.values()].join(", ")}`);
  console.log(`audit log: ${services.audit.path}`);
});

// pm2 sends SIGINT on restart: finish writing the audit log first
const shutdown = async () => {
  server.close();
  await services.audit.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);