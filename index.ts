import { startMcpService } from "./src/mcp.ts";

const port = Number(Bun.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
if (!Bun.env.BOOKORBIT_BASE_URL) throw new Error("BOOKORBIT_BASE_URL must be configured");

const service = await startMcpService({
  baseUrl: Bun.env.BOOKORBIT_BASE_URL,
  refreshToken: Bun.env.BOOKORBIT_REFRESH_TOKEN,
  historyPath: Bun.env.HISTORY_PATH ?? "/data/bookorbit-history.sqlite",
  port,
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void service.close().finally(() => process.exit(0));
  });
}
