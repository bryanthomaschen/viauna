// Bundles the server into dist/server/index.js. Dependencies stay in node_modules
// (several load files at runtime), so the production image installs them with
// `npm ci --omit=dev`.
import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  define: { "process.env.WREN_VERSION": JSON.stringify(process.env.WREN_VERSION || pkg.version) },
  banner: { js: "// Wren — https://github.com/ (AGPL-3.0). Built bundle; edit server/*.ts instead." },
  logLevel: "info",
});
