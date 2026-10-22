// The app speaks for itself: what it shows never names Gmail (the user's rule). Code
// comments may, where they say which behaviour the code follows. The README and docs
// keep "Gmail-style" in the slogan and otherwise describe Viauna in its own words.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));

/** A source file without its comments: what can reach the page. */
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the app's words", () => {
  it("never name Gmail", () => {
    const files = [...walk("web/src").filter((f) => /\.(tsx?|css)$/.test(f)), "web/index.html"];
    const found = files.flatMap((f) => (/gmail/i.test(uncommented(fs.readFileSync(f, "utf8"))) ? [f] : []));
    expect(found).toEqual([]);
  });
});

describe("the README and docs", () => {
  it("name Gmail only in the slogan, and to say it isn't a mail server Viauna supports", () => {
    const allowed = [/Gmail-style webmail/, /\*\*Gmail\*\* isn't a target/];
    const files = ["README.md", ...walk("docs").filter((f) => f.endsWith(".md"))];
    const found = files.flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (/gmail/i.test(line) && !allowed.some((a) => a.test(line)) ? [`${f}:${i + 1}: ${line}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
