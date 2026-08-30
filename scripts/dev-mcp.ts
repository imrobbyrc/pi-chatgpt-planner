import { loadConfig } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { PlannerMcpHttpServer } from "../src/mcp/server.js";

const config = await loadConfig();
const store = new TaskStore(config.stateDir);
const server = new PlannerMcpHttpServer(store, config);
await server.start();
console.log(`MCP listening at ${server.localUrl}`);
console.log("Press Ctrl+C to stop.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
