import { defineConfig } from "vitest/config";

// Vite builds only the Lit islands (ADR 0005 stack: no Vite in the server
// path). The server locates the hashed bundle via the manifest.
export default defineConfig({
  build: {
    outDir: "dist/app",
    manifest: true,
    rollupOptions: {
      input: "src/app/islands/index.ts",
    },
  },
  test: {
    // Integration tests build real DuckDB databases and run the promote
    // pipeline, sometimes twice; on CI's 2-core runner with parallel
    // workers the 5s default trips on machine speed, not on hangs.
    testTimeout: 30_000,
    server: {
      deps: {
        // Ships ESM with extensionless internal imports (bundler-only
        // packaging); Node can't resolve it natively, so vitest must
        // process it. tsx (the server runtime) handles it on its own.
        inline: ["@material/material-color-utilities"],
      },
    },
  },
});
