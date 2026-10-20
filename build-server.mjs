// Bundles the server into dist/server/index.js, and the `viauna` command into
// dist/server/cli.js. Dependencies stay in node_modules
// (several load files at runtime), so the production image installs them with
// `npm ci --omit=dev`.
import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

await build({
  entryPoints: ["server/index.ts", "server/cli.ts"],
  outdir: "dist/server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  define: { "process.env.VIAUNA_VERSION": JSON.stringify(process.env.VIAUNA_VERSION || pkg.version) },
  banner: { js: "// Viauna — https://github.com/bryanthomaschen/viauna (AGPL-3.0). Built bundle; edit server/*.ts instead." },
  logLevel: "info",
});
