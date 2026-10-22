// The service worker (web/public/sw.js), run with a stand-in for the browser's worker
// globals: what it shows for a pushed reminder, and where a click on it goes.
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function worker(openTabs: { url: string; visibilityState: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }[] = []) {
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://mail.example.com" },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { claim: async () => {}, matchAll: async () => openTabs, openWindow: async (u: string) => void opened.push(u) },
  };
  vm.runInNewContext(fs.readFileSync("web/public/sw.js", "utf8"), { self, Intl, Date, URL, Math, JSON });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { shown, opened, fire };
}

const reminder = {
  type: "reminder", title: "Standup", allDay: false, start: "2026-10-23T01:00:00.000Z", end: "2026-10-23T01:15:00.000Z",
  zone: "Asia/Singapore", location: "Room 3", tag: "reminder-1--1", url: "/mailbox/ann%40example.com/calendar/day/2026-10-23",
};

describe("the service worker", () => {
  it("shows a pushed reminder: its title, its time in the calendar's zone, and where", async () => {
    const w = worker();
    await w.fire("push", { data: { json: () => reminder } });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe("Standup");
    expect(w.shown[0].options).toMatchObject({ tag: "reminder-1--1", data: { url: reminder.url }, silent: false });
    // 09:00 to 09:15 in Singapore, however the machine writes times.
    expect(String(w.shown[0].options.body)).toMatch(/9.00.*9.15.* · Room 3$/);
  });

  it("is quiet when a tab is in view, and shows a test as sent", async () => {
    const w = worker([{ url: "https://mail.example.com/u/0/inbox", visibilityState: "visible", focus: async () => {}, navigate: async () => {} }]);
    await w.fire("push", { data: { json: () => ({ type: "test", title: "Viauna", body: "Notifications work in this browser." }) } });
    expect(w.shown[0]).toMatchObject({ title: "Viauna", options: { body: "Notifications work in this browser.", silent: true } });
  });

  it("opens the reminder's page in a Viauna tab if there is one, else a new one", async () => {
    const navigated: string[] = [];
    const tab = { url: "https://mail.example.com/u/0/inbox", visibilityState: "hidden", focus: async () => {}, navigate: async (u: string) => void navigated.push(u) };
    const click = { notification: { close: () => {}, data: { url: reminder.url } } };
    const w = worker([tab]);
    await w.fire("notificationclick", click);
    expect(navigated).toEqual([`https://mail.example.com${reminder.url}`]);
    const none = worker([]);
    await none.fire("notificationclick", click);
    expect(none.opened).toEqual([`https://mail.example.com${reminder.url}`]);
  });
});
