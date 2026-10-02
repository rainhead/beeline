import { configDefaults, defineConfig } from "vitest/config";

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
    // A setup step is held to the same clock: the legacy fixtures'
    // beforeEach is the heaviest in the suite and sat close enough to the
    // 10s hook default that a loaded machine tripped it (beeline-f42).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // An agent's git worktree under .claude/ is a whole second checkout;
    // without this the suite discovers its tests too and runs every test
    // twice, reporting on code that is not the working tree (beeline-f42).
    exclude: [...configDefaults.exclude, ".claude/**"],
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
