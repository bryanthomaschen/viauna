import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { getServerSecret } from "./crypto.ts";
import { db } from "./db.ts";
import { stopAll } from "./imap/pool.ts";
import { log } from "./log.ts";

db();
getServerSecret();

if (!config.imap && !config.allowCustomServers) {
  log.warn("no mail server configured: set IMAP_HOST and SMTP_HOST (or ALLOW_CUSTOM_SERVERS=true)");
}

const server = serve({ fetch: createApp().fetch, port: config.port, hostname: config.host }, (info) => {
  log.info("listening", { host: info.address, port: info.port, imap: config.imap?.host ?? null });
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  server.close();
  await Promise.race([stopAll(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", { error: (err as Error)?.message, stack: (err as Error)?.stack }));
