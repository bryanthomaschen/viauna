// Keeps a release's version, notes and docs in step (docs/development.md, "Releasing").
// Uses nothing but Node and git, so the Release workflow can run it before `npm ci`.
//
//   node dev/release.mjs check         package.json, CHANGELOG.md and the docs agree (CI)
//   node dev/release.mjs check --tag   …and nothing is left under Unreleased (a release)
//   node dev/release.mjs notes         this version's changelog section, as the GitHub
//                                      Release text
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const IMAGE = "ghcr.io/bryanthomaschen/viauna";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const minor = version.split(".").slice(0, 2).join(".");

/** CHANGELOG.md's `## ` sections, in order: "Unreleased", then one per release. */
function changelog() {
  const sections = [];
  let fenced = false;
  fs.readFileSync("CHANGELOG.md", "utf8").split("\n").forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^## (\S+)/.exec(line);
    if (heading) sections.push({ name: heading[1], heading: line, line: i + 1, lines: [] });
    else sections.at(-1)?.lines.push(line);
  });
  return sections.map((s) => ({ ...s, body: s.lines.join("\n").trim() }));
}

function check(tag) {
  const problems = [];
  const problem = (file, line, message) => problems.push({ file, line, message });

  const [unreleased, newest] = changelog();
  if (unreleased?.name !== "Unreleased") {
    problem("CHANGELOG.md", 1, "The first section must be `## Unreleased`.");
  } else if (tag && unreleased.body) {
    problem("CHANGELOG.md", unreleased.line, `Move the entries under Unreleased into the ${version} section.`);
  }
  if (newest?.name !== version) {
    problem("CHANGELOG.md", newest?.line ?? 1, `The newest release is ${newest?.name ?? "missing"}, but package.json says ${version}.`);
  } else if (!/^## \S+ - \d{4}-\d{2}-\d{2}$/.test(newest.heading)) {
    problem("CHANGELOG.md", newest.line, `Write the heading as \`## ${version} - YYYY-MM-DD\`.`);
  } else if (!newest.body) {
    problem("CHANGELOG.md", newest.line, `The ${version} section is empty.`);
  }

  // Version numbers that must follow each release: image references, and the rows of
  // the image-tag table in Getting started (a row that starts with a version). Others,
  // such as "needs Viauna 0.2 or newer" or "From 0.1 to 0.2", are history and stay.
  const files = execFileSync("git", ["ls-files", "*.md", "*.yml", "*.yaml", "Dockerfile", ":!CHANGELOG.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      for (const [, ref] of text.matchAll(/ghcr\.io\/bryanthomaschen\/viauna:([\w.-]+)/g)) {
        if (/^\d/.test(ref) && ref !== minor && ref !== version) {
          problem(file, i + 1, `${IMAGE}:${ref} should be :${minor} (or :${version}).`);
        }
      }
      if (/^\|\s*`\d+\.\d+/.test(text)) {
        for (const [found] of text.matchAll(/(?<![\d.])\d+\.\d+(\.\d+|\.x)?(?![\d.])/g)) {
          const wanted = found.endsWith(".x") ? `${minor}.x` : found.split(".").length === 3 ? version : minor;
          if (found !== wanted) problem(file, i + 1, `This tag table names ${found}; the current release is ${version}.`);
        }
      }
    });
  }

  for (const p of problems) {
    console.error(process.env.GITHUB_ACTIONS ? `::error file=${p.file},line=${p.line}::${p.message}` : `${p.file}:${p.line}: ${p.message}`);
  }
  if (problems.length) {
    console.error(`\nThe version, CHANGELOG.md and the docs disagree. See "Releasing" in docs/development.md.`);
    process.exit(1);
  }
  console.log(`package.json, CHANGELOG.md and the docs agree on ${version}.`);
}

/** The release's section, with its `###` headings raised to `##` for the Release page. */
function notes() {
  const section = changelog().find((s) => s.name === version);
  if (!section?.body) {
    console.error(`CHANGELOG.md has no notes for ${version}.`);
    process.exit(1);
  }
  let fenced = false;
  const lines = section.body.split("\n").map((line) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && line.startsWith("###") ? line.slice(1) : line;
  });
  console.log(lines.join("\n"));
}

const [command, ...flags] = process.argv.slice(2);
if (command === "check") check(flags.includes("--tag"));
else if (command === "notes") notes();
else {
  console.error("Usage: node dev/release.mjs check [--tag] | notes");
  process.exit(2);
}
