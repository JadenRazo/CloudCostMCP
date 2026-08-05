import { startServer } from "./server.js";

let shutdown: (() => Promise<void>) | null = null;
let exiting = false;

/**
 * Close the server (MCP connection + SQLite pricing cache) exactly once,
 * then exit with the given code. Safe to call from multiple signal/error
 * paths concurrently.
 */
async function closeAndExit(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await shutdown?.();
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`Error during shutdown: ${msg}\n`);
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  void closeAndExit(0);
});

process.on("SIGTERM", () => {
  void closeAndExit(0);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`);
  void closeAndExit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`Unhandled rejection: ${msg}\n`);
  void closeAndExit(1);
});

startServer()
  .then((stop) => {
    shutdown = stop;
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`Failed to start server: ${msg}\n`);
    process.exit(1);
  });
