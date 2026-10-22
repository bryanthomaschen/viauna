import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { startFeedRefresher } from "./calendar.ts";
import { config } from "./config.ts";
import { getServerSecret } from "./crypto.ts";
import { stopAll } from "./imap/pool.ts";
import { loadInstanceSettings } from "./instance.ts";
import { log } from "./log.ts";
import { listenForSettings } from "./settings-bus.ts";
import { closeStorage, initStorage } from "./storage.ts";

getServerSecret();
await initStorage();
// Changes made elsewhere (the command line, other instances) apply as they're announced.
const stopListening = await listenForSettings(loadInstanceSettings);

if (!config.imap && !config.allowCustomServers) {
  log.warn("no mail server configured: set IMAP_HOST and SMTP_HOST (or ALLOW_CUSTOM_SERVERS=true)");
}

// Calendars from the web are fetched again when they're due.
const stopFeeds = startFeedRefresher();

const server = serve({ fetch: createApp().fetch, port: config.port, hostname: config.host }, (info) => {
  log.info("listening", { host: info.address, port: info.port, imap: config.imap?.host ?? null });
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  server.close();
  stopFeeds();
  await Promise.race([stopAll(), new Promise((r) => setTimeout(r, 5000))]);
  await stopListening().catch(() => {});
  await closeStorage().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", { error: (err as Error)?.message, stack: (err as Error)?.stack }));
