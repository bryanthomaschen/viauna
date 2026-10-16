import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies the API to the Node server on :3000, so the browser sees
// one origin, as in production. Both bind to loopback only.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        // SSE must not be buffered.
        configure: (proxy) => proxy.on("proxyRes", (res) => { res.headers["x-accel-buffering"] = "no"; }),
      },
    },
  },
});
