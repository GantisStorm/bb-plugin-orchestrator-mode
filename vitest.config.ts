import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // The same `@/*` alias tsconfig and `bb plugin build` resolve, so a test
    // imports the vendored components exactly the way app.tsx does.
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
  test: {
    // Per-file: app.test.tsx declares jsdom in its own docblock.
    environment: "node",
    include: ["*.test.ts", "*.test.tsx"],
  },
});
