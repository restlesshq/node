import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/_setup.ts"],
    globals: false,
    environment: "node",
    // Compile-only type fixtures (*.test-d.ts) are checked with tsc, not run.
    // Guards the Next adapter's strictFunctionTypes fix. See
    // test/next.adapter.type.test-d.ts.
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./test/tsconfig.json",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
