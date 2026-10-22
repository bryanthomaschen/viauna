// Viauna's service worker: shows what the server pushes (Web Push, server/push.ts) when no
// Viauna tab may be open, and opens the page a click on it is for. It caches nothing.
// Messages are { type: "reminder", title, allDay, start, end, zone, location, tag, url }
// or { type: "test", title, body }.

const hour12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true;

/** "09:00 – 09:15 · Room 3", "Tomorrow", in the calendar's zone. */
function when(m) {
  if (m.allDay) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: m.zone || undefined }).format(new Date());
    const days = Math.round((Date.parse(m.start) - Date.parse(today)) / 86_400_000);
    return days === 0 ? "Today" : days === 1 ? "Tomorrow"
      : new Date(`${m.start}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  }
  const time = { hour: hour12 ? "numeric" : "2-digit", minute: "2-digit", hour12, timeZone: m.zone || undefined };
  return new Intl.DateTimeFormat(undefined, time).formatRange(new Date(m.start), new Date(m.end));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = {};
  }
  const body = m.type === "reminder" ? [when(m), m.location].filter(Boolean).join(" · ") : m.body || "";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((open) =>
      self.registration.showNotification(m.title || "Reminder", {
        body,
        tag: m.tag,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: m.url || "/" },
        // A tab in view shows it too: no sound twice.
        silent: open.some((c) => c.visibilityState === "visible"),
      }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (open) => {
      const tab = open.find((c) => new URL(c.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        return tab.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    }),
  );
});
