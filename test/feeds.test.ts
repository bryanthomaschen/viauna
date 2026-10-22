// Calendars from the web (server/feeds.ts, and subscribing in server/calendar.ts): fetched
// only from public addresses, within limits, asking only for changes; and kept as
// read-only calendars on each state-store engine. A local server stands in for the web,
// so private addresses are allowed where it's fetched, and refused everywhere else.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEvent,
  deleteCalendar,
  deleteEvent,
  eventsBetween,
  getEvent,
  importEvents,
  listCalendars,
  refreshDueFeeds,
  refreshFeed,
  searchEvents,
  subscribe,
  updateEvent,
} from "../server/calendar.ts";
import { config, setOverrides } from "../server/config.ts";
import { sha256 } from "../server/crypto.ts";
import { FEED_LIMITS, fetchFeed, feedUrl } from "../server/feeds.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const SG = "Asia/Singapore";

const ics = (events: { uid: string; title: string; date: string }[], name = "Public holidays") =>
  [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Feed//EN", "METHOD:PUBLISH", `X-WR-CALNAME:${name}`,
    ...events.flatMap((e) => ["BEGIN:VEVENT", `UID:${e.uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`, `SUMMARY:${e.title}`, "END:VEVENT"]),
    "END:VCALENDAR", "",
  ].join("\r\n");

/** A web server on 127.0.0.1: each path's answer, and what was asked of it. */
function webServer() {
  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();
  const asked: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    asked.push({ path: req.url ?? "", headers: req.headers });
    const route = routes.get(req.url ?? "");
    if (route) route(req, res);
    else res.writeHead(404, "Not Found").end();
  });
  return {
    routes,
    asked,
    start: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("fetching a calendar's address", () => {
  const web = webServer();
  let base = "";
  const allowed = config.allowPrivateServers;

  beforeAll(async () => {
    base = `http://127.0.0.1:${await web.start()}`;
  });
  afterAll(() => web.stop());
  afterEach(() => {
    config.allowPrivateServers = allowed;
    web.routes.clear();
  });

  it("takes https, http and webcal addresses, and nothing else", () => {
    expect(feedUrl(" webcal://example.com/cal.ics ")).toBe("https://example.com/cal.ics");
    expect(feedUrl("http://example.com/a.ics#x")).toBe("http://example.com/a.ics");
    expect(() => feedUrl("ftp://example.com/a.ics")).toThrow(/https/);
    expect(() => feedUrl("https://me:secret@example.com/a.ics")).toThrow(/name and password/);
    expect(() => feedUrl("not an address")).toThrow(/isn't a web address/);
    expect(() => feedUrl("")).toThrow(/Give/);
  });

  it("refuses private addresses, however they're written or found", async () => {
    config.allowPrivateServers = false;
    const port = new URL(base).port;
    for (const address of [`${base}/a.ics`, `http://localhost:${port}/a.ics`, `http://[::1]:${port}/a.ics`, `http://0x7f000001:${port}/a.ics`]) {
      await expect(fetchFeed(address), address).rejects.toThrow(/private network/);
    }
    expect(web.asked).toEqual([]);
  });

  it("follows redirects, decompresses, and asks only for a change since the last fetch", async () => {
    config.allowPrivateServers = true;
    const body = ics([{ uid: "a", title: "New Year", date: "2027-01-01" }]);
    web.routes.set("/moved.ics", (_req, res) => res.writeHead(301, { Location: "/cal.ics" }).end());
    web.routes.set("/cal.ics", (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') return res.writeHead(304).end();
      res.writeHead(200, { "Content-Type": "text/calendar", "Content-Encoding": "gzip", ETag: '"v1"', "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT" });
      res.end(zlib.gzipSync(body));
    });
    const first = await fetchFeed(`${base}/moved.ics`);
    expect(first).toEqual({ notModified: false, text: body, etag: '"v1"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" });
    expect(web.asked.at(-1)?.headers["user-agent"]).toMatch(/^Viauna\//);
    const again = await fetchFeed(`${base}/moved.ics`, { etag: first.etag, lastModified: first.lastModified });
    expect(again.notModified).toBe(true);
    expect(web.asked.at(-1)?.headers["if-modified-since"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("says what went wrong: an error answer, a redirect loop, too large, too slow", async () => {
    config.allowPrivateServers = true;
    await expect(fetchFeed(`${base}/missing.ics`)).rejects.toThrow(/answered 404 Not Found/);
    web.routes.set("/loop.ics", (_req, res) => res.writeHead(302, { Location: "/loop.ics" }).end());
    await expect(fetchFeed(`${base}/loop.ics`)).rejects.toThrow(/redirects too many times/);
    web.routes.set("/huge.ics", (_req, res) => res.writeHead(200, { "Content-Type": "text/calendar" }).end(Buffer.alloc(FEED_LIMITS.bytes + 1, 65)));
    await expect(fetchFeed(`${base}/huge.ics`)).rejects.toThrow(/too large/);
    // Small on the wire, too large unpacked.
    web.routes.set("/bomb.ics", (_req, res) => res.writeHead(200, { "Content-Encoding": "gzip" }).end(zlib.gzipSync(Buffer.alloc(FEED_LIMITS.bytes + 1, 65))));
    await expect(fetchFeed(`${base}/bomb.ics`)).rejects.toThrow(/too large/);
    const timeout = FEED_LIMITS.timeoutMs;
    FEED_LIMITS.timeoutMs = 300;
    try {
      web.routes.set("/slow.ics", () => {});
      await expect(fetchFeed(`${base}/slow.ics`)).rejects.toThrow(/took too long/);
    } finally {
      FEED_LIMITS.timeoutMs = timeout;
    }
  });

  it("tries plain http for a webcal address whose server doesn't answer over https", async () => {
    config.allowPrivateServers = true;
    web.routes.set("/cal.ics", (_req, res) => res.writeHead(200).end(ics([])));
    expect((await fetchFeed(`webcal://127.0.0.1:${new URL(base).port}/cal.ics`)).text).toContain("BEGIN:VCALENDAR");
    await expect(fetchFeed(`https://127.0.0.1:${new URL(base).port}/cal.ics`)).rejects.toThrow(/over https/);
  });
});

describe.each(ENGINES)("calendars from the web on $name", ({ url }) => {
  const web = webServer();
  let base = "";
  let store: StateStore;
  let dir: string;
  let feed = ics([]);
  const allowed = config.allowPrivateServers;
  const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });

  beforeAll(async () => {
    base = `http://127.0.0.1:${await web.start()}`;
    web.routes.set("/holidays.ics", (_req, res) => res.writeHead(200, { "Content-Type": "text/calendar" }).end(feed));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-feeds-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    await web.stop();
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    config.allowPrivateServers = true;
    await state().deleteFrom("events").execute();
    await state().deleteFrom("calendars").execute();
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ id: 7, login: "me@example.test", email: "me@example.test", imap, imap_hash: sha256(imap), smtp: "{}", settings: "{}", created_at: 1 }).execute();
    feed = ics([{ uid: "ny", title: "New Year's Day", date: "2027-01-01" }, { uid: "cny", title: "Lunar New Year", date: "2027-02-06" }]);
    // As the page does: the calendars are listed before one's added.
    await listCalendars(7, "Me");
  });

  afterEach(() => {
    config.allowPrivateServers = allowed;
    setState(null);
  });

  it("adds one by its address, named as it names itself, with its events read-only", async () => {
    const cal = await subscribe(7, { url: `${base}/holidays.ics` });
    expect(cal).toMatchObject({ name: "Public holidays", kind: "feed", readOnly: true, feed: { url: `${base}/holidays.ics`, error: null } });
    expect((await listCalendars(7, "Me")).map((c) => c.kind)).toEqual(["events", "birthdays", "feed"]);
    const events = await eventsBetween(7, "2027-01-01", "2027-03-01", SG);
    expect(events.map((e) => [e.start, e.title, e.readOnly])).toEqual([["2027-01-01", "New Year's Day", true], ["2027-02-06", "Lunar New Year", true]]);
    expect((await getEvent(7, events[0].id, SG)).readOnly).toBe(true);
    expect((await searchEvents(7, "lunar", SG))[0]).toMatchObject({ readOnly: true });
    // The file's METHOD isn't kept with the events.
    expect((await state().selectFrom("events").select("ics").execute()).some((r) => r.ics.includes("METHOD"))).toBe(false);

    await expect(createEvent(7, cal.id, { title: "x", allDay: true, start: "2027-01-02", end: "2027-01-03" }, SG)).rejects.toThrow(/comes from the web/);
    await expect(updateEvent(7, events[0].id, { title: "Mine now" }, SG)).rejects.toThrow(/comes from the web/);
    await expect(deleteEvent(7, events[0].id)).rejects.toThrow(/comes from the web/);
    await expect(importEvents(7, cal.id, feed)).rejects.toThrow(/comes from the web/);
    await expect(subscribe(7, { url: `${base}/holidays.ics` })).rejects.toThrow(/already here, as "Public holidays"/);
    await expect(subscribe(7, { url: `${base}/nothing.ics` })).rejects.toThrow(/answered 404/);
    expect(await state().selectFrom("calendars").select("id").where("kind", "=", "feed").execute()).toHaveLength(1);

    await deleteCalendar(7, cal.id);
    expect(await state().selectFrom("events").select("id").execute()).toEqual([]);
  });

  it("fetches again: adds, changes and removes events as the address does, and keeps them through a failure", async () => {
    const cal = await subscribe(7, { url: `${base}/holidays.ics`, name: "Holidays" });
    expect(cal.name).toBe("Holidays");
    await expect(refreshFeed(7, cal.id)).rejects.toMatchObject({ status: 429 });
    await state().updateTable("calendars").set({ checked_at: 0 }).execute();
    feed = ics([{ uid: "ny", title: "New Year", date: "2027-01-01" }, { uid: "gf", title: "Good Friday", date: "2027-03-26" }]);
    await refreshFeed(7, cal.id);
    expect((await eventsBetween(7, "2027-01-01", "2027-04-01", SG)).map((e) => e.title)).toEqual(["New Year", "Good Friday"]);

    await state().updateTable("calendars").set({ checked_at: 0 }).execute();
    feed = "<html>Down for maintenance</html>";
    await expect(refreshFeed(7, cal.id)).rejects.toThrow(/doesn't give a calendar/);
    const [kept] = (await listCalendars(7, "Me")).filter((c) => c.kind === "feed");
    expect(kept.feed?.error).toMatch(/doesn't give a calendar/);
    expect((await eventsBetween(7, "2027-01-01", "2027-04-01", SG)).map((e) => e.title)).toEqual(["New Year", "Good Friday"]);
  });

  it("fetches those that are due, each once however many instances look", async () => {
    const cal = await subscribe(7, { url: `${base}/holidays.ics` });
    expect(await refreshDueFeeds()).toBe(0);
    await state().updateTable("calendars").set({ next_fetch_at: Date.now() - 1 }).where("id", "=", cal.id).execute();
    feed = ics([{ uid: "x", title: "Something new", date: "2027-05-01" }]);
    const counts = await Promise.all([refreshDueFeeds(), refreshDueFeeds()]);
    expect(counts.sort()).toEqual([0, 1]);
    expect((await eventsBetween(7, "2027-01-01", "2027-06-01", SG)).map((e) => e.title)).toEqual(["Something new"]);
    const row = await state().selectFrom("calendars").select(["next_fetch_at", "fetch_error"]).where("id", "=", cal.id).executeTakeFirstOrThrow();
    expect(row.fetch_error).toBeNull();
    expect(row.next_fetch_at! - Date.now()).toBeGreaterThan(FEED_LIMITS.refreshMs - 60_000);
  });

  it("leaves them out while calendars from the web are off", async () => {
    const cal = await subscribe(7, { url: `${base}/holidays.ics` });
    setOverrides(new Map([["calendarFeeds", false]]));
    try {
      expect((await listCalendars(7, "Me")).map((c) => c.kind)).toEqual(["events", "birthdays"]);
      expect(await eventsBetween(7, "2027-01-01", "2027-03-01", SG)).toEqual([]);
      expect(await searchEvents(7, "year", SG)).toEqual([]);
      await expect(refreshFeed(7, cal.id)).rejects.toMatchObject({ status: 404 });
      await state().updateTable("calendars").set({ next_fetch_at: 0 }).execute();
      expect(await refreshDueFeeds()).toBe(0);
    } finally {
      setOverrides(new Map());
    }
    expect(await eventsBetween(7, "2027-01-01", "2027-03-01", SG)).toHaveLength(2);
  });
});
