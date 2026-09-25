import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Überschreibt auch eine lokale .dev.vars – Tests laufen wie in Produktion.
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_MODE: "0",
            MEDIA_BASE_URL: "/media",
            GROUP_CODE: "gruppe-test",
            TAGGER_CODE: "tagger-test",
            R2_ACCESS_KEY_ID: "test-key-id",
            R2_SECRET_ACCESS_KEY: "test-secret",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.js"] },
  };
});
