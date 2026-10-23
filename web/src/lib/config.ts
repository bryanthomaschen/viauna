// The server's settings as the page sees them, and keeping every copy of them fresh.
// The server announces a change over the live-updates stream (live.ts); after a reload of
// the stream, or saving on the admin page, the page refreshes everything that depends on
// a setting, so nothing waits for a manual reload.
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** /api/config, shared by every component that asks; refetched on focus after a minute. */
export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: 60_000 });
}

/** Everything shown from the instance's settings, for every account. */
export function refreshSettings(client: QueryClient) {
  for (const key of ["config", "session", "settings", "filters", "contacts", "calendars", "events", "admin", "links"]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}

/** Everything shown from one mailbox's own settings (page size, images, names). */
export function refreshAccountSettings(client: QueryClient, index: number) {
  void client.invalidateQueries({ queryKey: ["settings", index] });
  void client.invalidateQueries({ queryKey: ["identities", index] });
  void client.invalidateQueries({ queryKey: ["session"] });
  void client.invalidateQueries({ queryKey: ["threads", index] });
  void client.invalidateQueries({ queryKey: ["message", index] });
}
