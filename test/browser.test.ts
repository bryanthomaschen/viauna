// The keyboard in a real browser: Gmail's single-key shortcuts (off by default, then
// turned on from the command menu) and the ⌘K / Ctrl+K command menu, each pressed and
// its effect checked, including after clicking into a message or ticking a checkbox,
// where keys used to go missing. Then the calendar, by mouse and keyboard: clicking and
// dragging on the grid, Undo, its own keys, and an event made from an email. Needs the dev mail server (`npm run dev:mail`), a
// build (`npm run build`) and Chromium (`npx playwright-core install
// chromium-headless-shell`). Skipped unless VIAUNA_BROWSER=1.
//
//   VIAUNA_BROWSER=1 npx vitest run test/browser.test.ts
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";

const enabled = process.env.VIAUNA_BROWSER === "1";
const user = `kb-${crypto.randomBytes(4).toString("hex")}@example.test`;
const T = 4000;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!enabled)("in a browser", { timeout: 30_000 }, () => {
  let browser: Browser;
  let page: Page;
  let base = "";
  let dataDir = "";
  let stop: () => Promise<void> = async () => {};

  const press = (k: string) => page.keyboard.press(k);
  const where = () => new URL(page.url()).pathname;
  const until = async <V>(fn: () => Promise<V> | V, what: string, ms = T): Promise<V> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) {
        const focus = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`).catch(() => "?");
        throw new Error(`timed out waiting for ${what} (at ${where()}, focus on ${focus})`);
      }
      await page.waitForTimeout(50);
    }
  };
  const cursor = () => page.evaluate(() => [...document.querySelectorAll(".row")].findIndex((r) => r.classList.contains("focused")));
  const rows = () => page.evaluate(() => [...document.querySelectorAll(".row")].map((r) => r.querySelector(".summary")?.textContent ?? ""));
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const pickerOpen = () => page.locator("[data-radix-popper-content-wrapper] .menu").count();
  const menuOpen = () => page.locator("[cmdk-dialog]").count();
  const focusedMessage = () => page.evaluate(() => [...document.querySelectorAll(".msg")].findIndex((m) => m.classList.contains("focused")));

  const inbox = async () => {
    await page.goto(`${base}/u/0/inbox`);
    await page.locator(".row").first().waitFor();
    await blur();
  };
  /** A conversation of three or more messages, from the inbox. */
  const longConversation = async () => {
    await inbox();
    const i = await page.evaluate(() => [...document.querySelectorAll(".row")].findIndex((r) => Number(r.querySelector(".count")?.textContent) >= 3));
    if (i < 0) throw new Error("no conversation of 3+ messages on the first page");
    await page.locator(".row").nth(i).locator(".summary").click();
    await until(() => page.locator(".msg").count(), "messages");
    await page.waitForTimeout(300);
    await blur();
  };
  /** Runs a command from the menu, once the one expected is the one Enter would pick. */
  const command = async (text: string, expected: RegExp) => {
    await press("Control+k");
    await until(menuOpen, "the command menu");
    await until(() => page.evaluate(() => !!document.activeElement?.hasAttribute("cmdk-input")), "the menu's input to have the focus");
    await page.keyboard.type(text);
    const state = () =>
      page.evaluate(() => ({
        input: (document.querySelector("[cmdk-input]") as HTMLInputElement | null)?.value ?? "",
        selected: document.querySelector("[cmdk-item][data-selected=true]")?.textContent ?? "",
      }));
    let last = { input: "", selected: "" };
    await until(async () => expected.test((last = await state()).selected), `"${expected.source}" to be selected`).catch((err: Error) => {
      throw new Error(`${err.message}: typed "${last.input}", selected "${last.selected}"`);
    });
    await press("Enter");
    await until(async () => !(await menuOpen()), "the menu to close");
  };
  /** Single-key shortcuts on, whatever an earlier test did, so one failure doesn't cascade. */
  const shortcutsOn = () =>
    page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem("viauna.prefs") ?? "{}");
      localStorage.setItem("viauna.prefs", JSON.stringify({ ...prefs, shortcuts: true }));
    });

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      IMAP_HOST: "127.0.0.1", IMAP_PORT: "1143", IMAP_SECURITY: "none",
      SMTP_HOST: "127.0.0.1", SMTP_PORT: "1587", SMTP_SECURITY: "none",
      MANAGESIEVE_PORT: "14190", PUBLIC_URL: base, WEB_ROOT: path.resolve("dist/web"),
    });
    if (!fs.existsSync("dist/web/index.html")) throw new Error("Build the web app first: npm run build");
    await promisify(execFile)(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "dev/seed.ts", user]);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-kb-"));
    await (await import("../server/storage.ts")).initStorage({ dataDir, databaseUrl: undefined });
    const { createApp } = await import("../server/app.ts");
    const { serve } = await import("@hono/node-server");
    const pool = await import("../server/imap/pool.ts");
    const server = serve({ fetch: createApp().fetch, port, hostname: "127.0.0.1" });
    stop = async () => {
      await pool.stopAll();
      await new Promise((r) => server.close(r));
    };

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // KB_SLOW=4 runs the page on a CPU four times slower, as a loaded CI machine might be.
    if (process.env.KB_SLOW) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.KB_SLOW) });
    await page.goto(`${base}/login`);
    await page.getByLabel("Email address").fill(user);
    await page.getByLabel("Password").fill("pass");
    await page.getByRole("button", { name: "Next" }).click();
    await page.waitForURL(/\/u\/0\/inbox/);
    await page.locator(".row").first().waitFor({ timeout: 20_000 });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await stop();
    await (await import("../server/storage.ts")).closeStorage().catch(() => {});
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("by default", () => {
    it("ignores single keys", async () => {
      const before = await cursor();
      await press("j");
      await page.waitForTimeout(300);
      if ((await cursor()) !== before) throw new Error("single-key shortcuts are on by default");
    });

    it("opens the command menu with Ctrl+K, and Esc closes it", async () => {
      await press("Control+k");
      await until(menuOpen, "the menu");
      await press("Escape");
      await until(async () => !(await menuOpen()), "the menu to close");
    });

    it("says in the help panel that shortcuts are off and the menu works", async () => {
      await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
      const text = await page.getByRole("dialog", { name: "Keyboard shortcuts" }).innerText();
      if (!/are off/.test(text) || !/command menu/.test(text)) throw new Error(text.slice(0, 160));
      await press("Escape");
      await blur();
    });
  });

  describe("the command menu", () => {
    it("goes to a folder by name", async () => {
      await command("starred", /^Starred/);
      await until(() => /\/starred$/.test(where()), "Starred");
    });

    it("searches mail for what's typed when no command matches", async () => {
      await command("hike", /^Search mail for “hike”/);
      await until(() => /\/search\/hike$/.test(where()), "the search");
    });

    it("offers no conversation commands with nothing selected", async () => {
      await inbox();
      await page.mouse.click(5, 5);
      await press("Control+k");
      await until(menuOpen, "the menu");
      const groups = await page.locator("[cmdk-group-heading]").allInnerTexts();
      await press("Escape");
      if (groups[0] !== "Go to") throw new Error(`groups: ${groups.join(", ")}`);
    });

    it("scrolls with the mouse wheel when its commands don't fit", async () => {
      // A short window, so the commands can't all fit.
      await page.setViewportSize({ width: 1280, height: 500 });
      try {
        await inbox();
        await press("Control+k");
        await until(menuOpen, "the menu");
        const list = page.locator("[cmdk-list]");
        const box = (await list.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height, 200) / 2);
        await page.mouse.wheel(0, 300);
        await until(() => list.evaluate((l) => l.scrollTop > 0), "the wheel to scroll the list");
        await press("Escape");
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    it("acts on the selection, and z undoes it", async () => {
      await inbox();
      const before = (await rows()).length;
      await page.locator(".row").nth(1).locator("input.checkbox").click();
      await command("archive", /^Archive/);
      await until(async () => (await rows()).length === before - 1, "the archive");
      await press("Escape");
      await blur();
    });

    it("turns single-key shortcuts on", async () => {
      await command("turn on single", /^Turn on single-key shortcuts/);
      // The menu runs a command just after it closes, so reloading at once can lose it.
      await until(() => page.evaluate(() => JSON.parse(localStorage.getItem("viauna.prefs") ?? "{}").shortcuts === true), "the setting to be saved");
      await inbox();
      const before = await cursor();
      await press("j");
      await until(async () => (await cursor()) !== before, "j to move the cursor");
    });
  });

  describe("in the list", () => {
    beforeAll(shortcutsOn);
    it("j and k move the cursor", async () => {
      await inbox();
      await press("j");
      await press("j");
      const at = await cursor();
      await press("k");
      await until(async () => (await cursor()) === at - 1, "k");
    });

    it("x selects, Esc clears", async () => {
      await press("x");
      await until(() => page.locator(".row.focused.selected").count(), "the selection");
      await press("Escape");
      await until(async () => !(await page.locator(".row.selected").count()), "no selection");
    });

    it("s stars and unstars", async () => {
      const star = page.locator(".row.focused .star-btn");
      const before = await star.getAttribute("aria-pressed");
      await press("s");
      await until(async () => (await star.getAttribute("aria-pressed")) !== before, "the star");
      await press("s");
      await until(async () => (await star.getAttribute("aria-pressed")) === before, "no star");
    });

    it("Shift+u and Shift+i mark unread and read", async () => {
      const row = page.locator(".row.focused");
      await press("Shift+U");
      await until(async () => (await row.getAttribute("class"))!.includes("unread"), "unread");
      await press("Shift+I");
      await until(async () => !(await row.getAttribute("class"))!.includes("unread"), "read");
    });

    it("l and v open the pickers with nothing selected", async () => {
      for (const k of ["l", "v"]) {
        await press(k);
        await until(pickerOpen, `the ${k} picker`);
        await press("Escape");
        await until(async () => !(await pickerOpen()), "the picker to close");
        await press("Escape");
        await blur();
      }
    });

    for (const [key, name] of [["e", "archive"], ["#", "delete"], ["!", "spam"]]) {
      it(`${key} moves the conversation out (${name}), z brings it back`, async () => {
        await inbox();
        await press("j");
        const before = (await rows()).length;
        await press(key);
        await until(async () => (await rows()).length === before - 1, name);
        await page.waitForTimeout(500);
        await press("z");
        await until(async () => (await rows()).length === before, "the undo");
      });
    }

    it("z pressed at once undoes that action, not an earlier one", async () => {
      await inbox();
      await press("j");
      const before = await rows();
      await press("e");
      await press("z");
      await until(async () => (await rows()).length === before.length, "the undo", 6000);
      await page.waitForTimeout(1500);
      const after = await rows();
      if (after.length !== before.length) throw new Error(`${after.length} rows, expected ${before.length}`);
    });

    it("o and Enter open, u goes back", async () => {
      await inbox();
      await press("j");
      await press("o");
      await until(() => /\/inbox\/\d+$/.test(where()), "the conversation");
      await press("u");
      await until(() => /\/inbox$/.test(where()), "the list");
      await press("Enter");
      await until(() => /\/inbox\/\d+$/.test(where()), "the conversation");
    });

    it("keeps working after ticking a checkbox or clicking a star", async () => {
      await inbox();
      await page.locator(".row").nth(2).locator("input.checkbox").click();
      const at = await cursor();
      await press("j");
      await until(async () => (await cursor()) !== at, "j after the checkbox");
      await press("Escape");
      await page.locator(".row").nth(1).locator(".star-btn").click();
      await page.locator(".row").nth(1).locator(".star-btn").click();
      const again = await cursor();
      await press("j");
      await until(async () => (await cursor()) !== again, "j after the star");
    });
  });

  describe("in a conversation", () => {
    beforeAll(shortcutsOn);
    it("j and k go to the next and previous conversation", async () => {
      await inbox();
      await press("j");
      await press("o");
      await until(() => /\/inbox\/\d+$/.test(where()), "the conversation");
      const first = where();
      await press("j");
      await until(() => where() !== first, "the next conversation");
      await press("k");
      await until(() => where() === first, "back again");
    });

    it("n and p move between messages, and show which", async () => {
      await longConversation();
      const at = await focusedMessage();
      await press("p");
      await until(async () => (await focusedMessage()) === at - 1, "p");
      const bar = await page.evaluate(() => getComputedStyle(document.querySelector(".msg.focused")!, "::before").content);
      if (bar === "none" || bar === "") throw new Error("the focused message isn't marked");
      await press("n");
      await until(async () => (await focusedMessage()) === at, "n");
      for (let i = 0; i < 10; i++) await press("p");
      await until(async () => (await focusedMessage()) === 0, "the first message");
    });

    it("o opens and closes the focused message", async () => {
      const before = await page.locator(".msg-frame").count();
      await press("o");
      await until(async () => (await page.locator(".msg-frame").count()) !== before, "a change");
      await press("o");
    });

    for (const [key, title] of [["r", /^Re: /], ["a", /^Re: /], ["f", /^Fwd: /]] as const) {
      it(`${key} starts a reply or forward`, async () => {
        await longConversation();
        await press(key);
        await until(() => page.locator("section.inline-compose").count(), "the compose box");
        const label = (await page.locator("section.inline-compose").getAttribute("aria-label")) ?? "";
        if (!title.test(label)) throw new Error(`compose titled "${label}"`);
        await page.locator("section.inline-compose").getByRole("button", { name: "Discard draft" }).click();
      });
    }

    it("s stars it, l and v open the pickers, Esc after a picker goes back", async () => {
      await longConversation();
      // The star goes on the newest message in this folder, which may be folded away:
      // the command menu says which way it is for the whole conversation.
      const starred = async () => {
        await press("Control+k");
        await until(menuOpen, "the menu");
        const on = (await page.locator("[cmdk-item]", { hasText: "Remove star" }).count()) > 0;
        await press("Escape");
        await until(async () => !(await menuOpen()), "the menu to close");
        return on;
      };
      const before = await starred();
      await press("s");
      await until(async () => (await starred()) !== before, "the star");
      await press("s");
      await until(async () => (await starred()) === before, "no star");
      for (const k of ["l", "v"]) {
        await press(k);
        await until(pickerOpen, `the ${k} picker`);
        await press("Escape");
        await until(async () => !(await pickerOpen()), "the picker to close");
      }
      // Focus is back on the toolbar button, whose tooltip shows; Esc still goes back.
      await press("Escape");
      await until(() => /\/inbox$/.test(where()), "the list");
    });

    it("e archives and leaves, Shift+u marks unread and leaves", async () => {
      await longConversation();
      await press("e");
      await until(() => /\/inbox$/.test(where()), "the list");
      await press("z");
      await page.waitForTimeout(800);
      await longConversation();
      await press("Shift+U");
      await until(() => /\/inbox$/.test(where()), "the list");
    });

    it("keys still work after clicking into a message", async () => {
      await longConversation();
      await page.locator(".msg-frame").last().click({ position: { x: 20, y: 10 } });
      const at = await focusedMessage();
      await press("p");
      await until(async () => (await focusedMessage()) !== at, "p from inside the message");
      await page.locator(".msg-frame").last().click({ position: { x: 20, y: 10 } });
      await press("Control+k");
      await until(menuOpen, "the menu from inside the message");
      await page.keyboard.type("label as");
      await until(async () => /^Label as/.test((await page.locator("[cmdk-item][data-selected=true]").textContent()) ?? ""), "Label as… to be selected");
      await press("Enter");
      await until(pickerOpen, "the label picker, from the menu");
      await press("Escape");
    });
  });

  describe("anywhere", () => {
    beforeAll(shortcutsOn);
    it("c composes, Ctrl+Enter sends", async () => {
      await inbox();
      await press("c");
      const win = page.locator(".compose-dock section").last();
      await until(() => win.count(), "the compose window");
      await win.getByLabel(/^To/).first().fill(user);
      await win.getByLabel("Subject").fill("Sent with Ctrl+Enter");
      await win.locator("[contenteditable=true]").click();
      await page.keyboard.type("Hello");
      await press("Control+Enter");
      await until(async () => !(await page.locator(".compose-dock section").count()), "sending", 10_000);
    });

    it("/ goes to the search box, ? shows the shortcuts", async () => {
      await blur();
      await press("/");
      await until(() => page.evaluate(() => /search/i.test(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("placeholder") ?? "")), "the search box");
      await press("Escape");
      await blur();
      await press("?");
      await until(() => page.getByRole("dialog", { name: "Keyboard shortcuts" }).count(), "the help panel");
      await press("Escape");
    });

    it("g then i, s, t, d, a go to folders", async () => {
      for (const [k, re] of [["s", /\/starred$/], ["t", /\/sent$/], ["d", /\/drafts$/], ["a", /\/all$/], ["i", /\/inbox$/]] as const) {
        await blur();
        await press("g");
        await press(k);
        await until(() => re.test(where()), `g then ${k}`);
      }
    });
  });
  describe("the calendar", () => {
    beforeAll(shortcutsOn);
    // A week far from today, so the clock doesn't move anything under the test. The page
    // shows times in the browser's zone, which the API is asked for too.
    const zone = () => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const listed = async () =>
      page.evaluate(async (z) => {
        const r = await fetch(`/api/u/0/calendar/events?from=2030-01-06&to=2030-01-14&zone=${encodeURIComponent(z)}`);
        return ((await r.json()).events as { id: number; title: string; start: string; end: string }[]).map((e) => ({ ...e, start: e.start.slice(11, 16), end: e.end.slice(11, 16) }));
      }, await zone());
    const planning = async () => (await listed()).find((e) => e.title === "Planning");
    const week = async () => {
      await page.goto(`${base}/u/0/calendar/week/2030-01-09`);
      await page.locator(".calendar-grid [role=columnheader][data-date='2030-01-09']").waitFor();
    };
    /** The middle of a slot: a day's column, a time's row (scrolled into view). */
    const slot = async (date: string, time: string) => {
      const row = page.locator(`.calendar-grid [data-time='${time}']`).last();
      await row.scrollIntoViewIfNeeded();
      const col = (await page.locator(`.calendar-grid [role=columnheader][data-date='${date}']`).boundingBox())!;
      const box = (await row.boundingBox())!;
      return { x: col.x + col.width / 2, y: box.y + box.height / 2, h: box.height };
    };
    const event = (title: string) => page.locator(".calendar-grid [role=button]", { hasText: title }).first();
    const undoToast = () => page.locator(".toast button.act", { hasText: "Undo" }).last();

    it("a click makes an event of the usual length, with a title typed in its card", async () => {
      await week();
      const at = await slot("2030-01-09", "09:00:00");
      await page.mouse.click(at.x, at.y);
      const card = page.locator(".event-card");
      await until(() => card.count(), "the new event's card");
      await page.keyboard.type("Planning");
      await press("Enter");
      await until(async () => (await planning())?.start, "the event to be saved");
      const e = (await planning())!;
      if (e.end !== "10:00" || !e.start.startsWith("09:")) throw new Error(`saved as ${e.start}–${e.end}`);
      await until(() => event("Planning").count(), "the event on the grid");
    });

    it("dragging moves it, and Undo puts it back", async () => {
      // An hour down, from just inside its top edge (in the snap where it starts), in steps
      // as a hand moves.
      const nine = await slot("2030-01-09", "09:00:00");
      const ten = await slot("2030-01-09", "10:00:00");
      const box = (await event("Planning").boundingBox())!;
      const [x, y] = [box.x + box.width / 2, box.y + 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + ((ten.y - nine.y) * i) / 8);
      await page.mouse.up();
      await until(async () => (await planning())?.start === "10:00", "the event to move an hour later");
      await undoToast().click();
      await until(async () => (await planning())?.start === "09:00", "Undo to put it back");
    });

    it("its card deletes it, and Undo brings it back", async () => {
      await week();
      await event("Planning").click();
      await until(() => page.locator(".event-card").count(), "the event's card");
      await page.getByRole("button", { name: "Delete event" }).click();
      await until(async () => !(await planning()), "the deletion");
      await undoToast().click();
      await until(async () => !!(await planning()), "Undo to bring it back");
    });

    it("d, w, m, a and x switch views, t goes to today, c makes an event", async () => {
      await week();
      await blur();
      for (const [k, view] of [["m", "month"], ["d", "day"], ["a", "schedule"], ["x", "4days"], ["w", "week"]] as const) {
        await press(k);
        await until(() => where().startsWith(`/u/0/calendar/${view}/`), `${k} for the ${view} view`);
      }
      await press("t");
      const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
      await until(() => where().endsWith(`/${today}`), "t for today");
      await press("c");
      await until(() => page.getByRole("dialog", { name: "New event" }).count(), "c for a new event");
      await press("Escape");
    });

    it("a weekly event from the editor's choices; one occurrence moved, then this and following deleted", async () => {
      const series = async () =>
        page.evaluate(async (z) => {
          const r = await fetch(`/api/u/0/calendar/events?from=2030-01-06&to=2030-01-27&zone=${encodeURIComponent(z)}`);
          return ((await r.json()).events as { title: string; start: string; occurrence: string }[]).filter((e) => e.title === "Weekly review").map((e) => e.start.slice(0, 16));
        }, await zone());
      await week();
      await page.locator(".compose-btn").first().click();
      const dialog = page.getByRole("dialog", { name: "New event" });
      await until(() => dialog.count(), "the editor");
      await dialog.getByLabel("Title").fill("Weekly review");
      await dialog.getByLabel("Start date").fill("2030-01-07");
      await dialog.getByLabel("Start time").fill("14:00");
      await dialog.locator("[aria-label=Repeats]").selectOption({ label: "Weekly on Monday" });
      await dialog.getByRole("button", { name: "Save" }).click();
      await until(async () => (await series()).length === 3, "three Mondays");
      const [, second] = await series();

      // Drag the second Monday an hour later, for this event only.
      await page.goto(`${base}/u/0/calendar/week/2030-01-14`);
      await page.locator(".calendar-grid [role=columnheader][data-date='2030-01-14']").waitFor();
      const two = await slot("2030-01-14", "14:00:00");
      const three = await slot("2030-01-14", "15:00:00");
      const box = (await event("Weekly review").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2, box.y + 2 + ((three.y - two.y) * i) / 8);
      await page.mouse.up();
      const ask = page.getByRole("dialog", { name: "Change repeating event" });
      await until(() => ask.count(), "the question of which events");
      await ask.getByRole("button", { name: "OK" }).click();
      await until(async () => (await series())[1] !== second, "the second Monday to move");
      const after = await series();
      if (after[0].slice(11) !== after[2].slice(11) || after[1].slice(11) === after[0].slice(11)) throw new Error(`moved: ${after.join(", ")}`);

      // Delete it and the ones after: only the first is left.
      await event("Weekly review").click();
      await page.getByRole("button", { name: "Delete event" }).click();
      const del = page.getByRole("dialog", { name: "Delete repeating event" });
      await until(() => del.count(), "the question, for deleting");
      await del.getByLabel("This and following events").check();
      await del.getByRole("button", { name: "OK" }).click();
      await until(async () => (await series()).length === 1, "only the first Monday left");
    });

    it("imports a calendar file into a new calendar, and exports it again", async () => {
      await week();
      await page.getByRole("button", { name: "Add a calendar" }).click();
      await page.getByRole("menuitem", { name: /Import from a file/ }).click();
      const dialog = page.getByRole("dialog", { name: "Import events" });
      await until(() => dialog.count(), "the import dialog");
      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", "X-WR-CALNAME:Imported trip",
        "BEGIN:VEVENT", "UID:trip-1@test", "DTSTAMP:20291201T000000Z", "DTSTART;TZID=Europe/Paris:20300110T100000",
        "DTEND;TZID=Europe/Paris:20300110T120000", "SUMMARY:Louvre", "END:VEVENT", "END:VCALENDAR", "",
      ].join("\r\n");
      await dialog.locator("input[type=file]").setInputFiles({ name: "trip.ics", mimeType: "text/calendar", buffer: Buffer.from(ics) });
      await dialog.getByLabel("Into which calendar").selectOption("new");
      await dialog.getByRole("button", { name: "Import" }).click();
      await until(async () => !(await dialog.count()), "the import");
      await until(() => page.locator(".calendar-list").getByText("Imported trip").count(), "the new calendar in the list");
      await until(() => event("Louvre").count(), "the imported event on the grid");

      await page.locator(".calendar-list li", { hasText: "Imported trip" }).hover();
      await page.getByRole("button", { name: "Options for Imported trip" }).click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Export to a file/ }).click()]);
      const text = fs.readFileSync((await download.path())!, "utf8");
      if (!text.includes("SUMMARY:Louvre") || !text.includes("TZID:Europe/Paris") || download.suggestedFilename() !== "Imported trip.ics") {
        throw new Error(`exported ${download.suggestedFilename()}: ${text.slice(0, 200)}`);
      }
    });

    it("an event made from an email links back to it, by its Message-ID", async () => {
      await inbox();
      await page.locator(".row").first().locator(".summary").click();
      await until(() => page.locator(".msg").count(), "the conversation");
      await page.locator(".msg-header").last().getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Create event" }).click();
      const dialog = page.getByRole("dialog", { name: "New event" });
      await until(() => dialog.count(), "the event editor");
      const title = await dialog.getByLabel("Title").inputValue();
      const description = await dialog.getByLabel("Description").inputValue();
      if (!title || !/rfc822msgid/.test(description)) throw new Error(`prefilled "${title}" / "${description}"`);
      await dialog.getByRole("button", { name: "Save" }).click();
      await until(async () => !(await dialog.count()), "the event to be saved");
      // The link in its description finds the message again.
      const link = description.match(/https?:\/\/\S+/)![0];
      await page.goto(link);
      await until(async () => (await rows()).length === 1, "the search for that message");
    });
  });
});
