// `npm run dev`: the API server (restarting on change) and the Vite dev server with
// hot reload, side by side. Open http://127.0.0.1:5173. Both bind to loopback only.
import { spawn } from "node:child_process";

const procs = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "--env-file-if-exists=.env", "server/index.ts"], { stdio: "inherit", env: { ...process.env, PUBLIC_URL: process.env.PUBLIC_URL ?? "http://127.0.0.1:5173" } }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => { stop(); process.exitCode = code ?? 0; });
