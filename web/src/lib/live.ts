// Server-sent events: the server pushes "this account's folders changed" and the
// affected queries refetch. New mail appears within a second of arriving; contacts
// synced from the CardDAV server appear when the sync ends.
import { type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { refreshWhenSettled } from "./actions";
import { prefs, toast } from "./store";

interface ChangeEvent {
  index: number;
  mailboxIds: number[];
  arrived?: { threadId: number; from: string; subject: string }[];
}

export function useLiveUpdates(client: QueryClient, accountCount: number, onOpenThread: (index: number, threadId: number) => void) {
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const pending = new Set<number>();
    let flush: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      flush = null;
      // While actions are in flight, their own refresh follows them; one now would show
      // the server midway (a star back for a moment after unstarring).
      for (const index of pending) refreshWhenSettled(client, index);
      pending.clear();
    };

    const connect = () => {
      source = new EventSource("/api/events");
      source.addEventListener("change", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as ChangeEvent;
        pending.add(data.index);
        if (!flush) flush = setTimeout(refresh, 250);
        if (data.arrived?.length && prefs.get().notifications && document.hidden && "Notification" in window && Notification.permission === "granted") {
          for (const m of data.arrived.slice(0, 3)) {
            const n = new Notification(m.from || "New message", { body: m.subject, tag: `viauna-${data.index}-${m.threadId}` });
            n.onclick = () => {
              window.focus();
              onOpenThread(data.index, m.threadId);
              n.close();
            };
          }
        }
      });
      source.addEventListener("contacts", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        void client.invalidateQueries({ queryKey: ["contacts", index] });
      });
      source.addEventListener("reauth", (e) => {
        const { index } = JSON.parse((e as MessageEvent).data) as { index: number };
        toast(`Account ${index + 1} needs you to sign in again.`, {
          error: true,
          action: { label: "Sign in", run: () => (location.href = "/login?add=1") },
          ms: 20000,
        });
      });
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
    };
  }, [client, accountCount, onOpenThread]);
}
