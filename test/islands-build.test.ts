import { describe, expect, it } from "vitest";
import { build } from "vite";

/**
 * The browser bundle builds (beeline-r0fq). The image build runs `pnpm
 * app:build`, and nothing else did: CI ran the typecheck and the tests, so a
 * change that made the Lit islands import server code passed every check and
 * then failed the deploy. That is what happened on 2026-11-13: the islands
 * import the message catalogue, the catalogue imported a module that imported
 * the API, and the API had just begun importing the store, so the bundle
 * tried to include DuckDB's native module.
 *
 * Built with the project's own configuration and nothing written to disk.
 */
describe("the browser bundle", () => {
  it("builds, and holds nothing that only a server can load", async () => {
    const result = await build({ logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []));
    const modules = outputs.flatMap((o) => ("modules" in o ? Object.keys(o.modules) : []));
    expect(modules.length).toBeGreaterThan(0);
    // The store, its driver, the HTTP server and the query builder never belong in a page's script.
    const serverOnly = modules.filter((id) => /@duckdb|kysely|@hono\/node-server|[/\\]src[/\\](db|model)\.ts$/.test(id));
    expect(serverOnly).toEqual([]);
  });
});
