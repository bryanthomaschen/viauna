// The docs say what the code does: these fail when one changes without the other.
// Every environment variable the server reads is in the configuration page, every
// shortcut in the help panel, mail's and the calendar's, is in the shortcuts page (and
// the other way round), every
// server file is in the architecture page's layout, and every page is in the sidebar.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS } from "../server/config.ts";

const read = (file: string) => fs.readFileSync(file, "utf8");
const walk = (dir: string, keep: (f: string) => boolean): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return [".vitepress", "node_modules"].includes(e.name) ? [] : walk(full, keep);
    return keep(full) ? [full] : [];
  });

describe("the docs", () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
    vi.resetModules();
  });

  it("document every environment variable the server reads", async () => {
    // config.ts reads the environment as it loads, some of it only when other things are
    // set: load it under each of those with a process.env that notes every name asked for.
    const asked = new Set<string>();
    const variants: Record<string, string>[] = [
      {},
      { PASSWORD_CHANGE: "ldap", PASSWORD_CHANGE_LDAP_URL: "ldap://directory.test", PASSWORD_CHANGE_LDAP_USER_DN: "uid={user},dc=test" },
      { PASSWORD_CHANGE: "webhook", PASSWORD_CHANGE_WEBHOOK: "https://hook.test/", PASSWORD_CHANGE_WEBHOOK_SECRET: "s".repeat(32) },
      { PASSWORD_CHANGE_LDAP_URL: "ldap://directory.test", PASSWORD_CHANGE_LDAP_SEARCH_BASE: "dc=test", PASSWORD_CHANGE_LDAP_BIND_DN: "cn=a", PASSWORD_CHANGE_LDAP_BIND_PASSWORD: "b" },
      { MANAGESIEVE_HOST: "sieve.test" },
    ];
    for (const extra of variants) {
      const values: Record<string, string | undefined> = { ...original, ...extra };
      process.env = new Proxy(values, {
        get: (t, k) => {
          if (typeof k === "string") asked.add(k);
          return t[k as string];
        },
      }) as NodeJS.ProcessEnv;
      vi.resetModules();
      const config = await import("../server/config.ts");
      config.readEnvironment(process.env);
      process.env = original;
    }
    // Read directly elsewhere in the server.
    for (const file of walk("server", (f) => f.endsWith(".ts"))) {
      for (const m of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) asked.add(m[1]);
    }
    for (const def of SETTINGS) asked.add(def.env);
    // Node and the test runner read the environment too while modules load: a name is
    // Viauna's if the server's code names it, itself or as `${prefix}_SUFFIX`.
    const source = walk("server", (f) => f.endsWith(".ts")).map(read).join("\n");
    const suffixes = [...source.matchAll(/`\$\{prefix\}_([A-Z0-9_]+)`/g)].map((m) => m[1]);
    const ours = [...asked].filter(
      (k) => /^[A-Z][A-Z0-9_]*$/.test(k) && (source.includes(`"${k}"`) || source.includes(`env.${k}`) || suffixes.some((x) => k.endsWith(`_${x}`))),
    );
    const page = read("docs/self-hosting/configuration.md");
    expect(ours.length).toBeGreaterThan(40);
    expect(ours.filter((k) => !page.includes(`\`${k}\``)).sort()).toEqual([]);
  });

  it("list the same single-key shortcuts as the help panel, in the same order", () => {
    const code = read("web/src/components/shortcuts.ts");
    const list = (name: string) => {
      const body = code.slice(code.indexOf(`export const ${name}`), code.indexOf("];", code.indexOf(`export const ${name}`)));
      return [...body.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
    };
    // The page's first table is mail's; the one under "In the calendar", the calendar's.
    const page = read("docs/using/shortcuts.md");
    const table = (text: string) =>
      [...text.matchAll(/^\| (.+?) \| (.+?) \|$/gm)].map((m) => [m[1].replaceAll("`", ""), m[2]]).filter(([k]) => k !== "Key" && !/^-+$/.test(k));
    const split = page.indexOf("## In the calendar");
    for (const [panel, docs] of [[list("SHORTCUTS"), table(page.slice(0, split))], [list("CALENDAR_SHORTCUTS"), table(page.slice(split))]]) {
      expect(panel.length).toBeGreaterThan(8);
      expect(docs.map(([k]) => k)).toEqual(panel.map(([k]) => k));
      // A page may say more than the panel, never something else.
      for (const [i, [, what]] of panel.entries()) expect(docs[i][1].startsWith(what), `${panel[i][0]}: "${docs[i][1]}"`).toBe(true);
    }
  });

  it("name every server file in the architecture page's layout", () => {
    const page = read("docs/architecture.md");
    const files = walk("server", (f) => f.endsWith(".ts")).map((f) => path.relative("server", f).split(path.sep).join("/"));
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((f) => !new RegExp(`^ {2}${f.replace(/[.]/g, "\\.")}\\s`, "m").test(page)).sort()).toEqual([]);
  });

  it("put every page in the sidebar, and every sidebar link on a page", () => {
    const config = read(fs.existsSync("docs/.vitepress/config.mts") ? "docs/.vitepress/config.mts" : "docs/.vitepress/config.ts");
    const links = new Set([...config.matchAll(/link: "(\/[^"#]*)"/g)].map((m) => m[1]));
    const pages = walk("docs", (f) => f.endsWith(".md"))
      .map((f) => "/" + path.relative("docs", f).split(path.sep).join("/").replace(/\.md$/, ""))
      .filter((p) => p !== "/index");
    expect(pages.filter((p) => !links.has(p) && !links.has(p.replace(/\/index$/, "/"))).sort()).toEqual([]);
    for (const link of links) {
      const file = link.endsWith("/") ? `docs${link}index.md` : `docs${link}.md`;
      expect(fs.existsSync(file), `${link} has no page`).toBe(true);
    }
  });
});
