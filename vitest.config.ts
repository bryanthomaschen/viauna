import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: { SECRET_KEY: "test-secret", DATA_DIR: "./data-test", LOG_LEVEL: "error", IMAP_HOST: "imap.internal.test", SMTP_HOST: "smtp.internal.test" },
  },
});
