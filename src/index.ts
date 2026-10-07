import { loadConfig } from "./config.js";
import { createServices } from "./core/services.js";
import { createApp } from "./transport/app.js";
import { createAuthenticator } from "./transport/auth.js";

const config = loadConfig();
const services = createServices(config);
const app = createApp(services, createAuthenticator(config.agentTokens));

// bind to localhost only; ngrok reaches it locally in M3
app.listen(config.port, "127.0.0.1", () => {
  console.log(`mcp-workspace listening on http://127.0.0.1:${config.port}/mcp`);
  console.log(`workspace root: ${config.workspaceRoot}`);
  console.log(
    `agents configured: ${[...config.agentTokens.values()].join(", ")}`,
  );
});
