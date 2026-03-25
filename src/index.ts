import { startServer } from "./server.js";

process.on("uncaughtException", (err) => {
  process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`Unhandled rejection: ${msg}\n`);
  process.exit(1);
});

startServer().catch((err) => {
  process.stderr.write(`Failed to start server: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
