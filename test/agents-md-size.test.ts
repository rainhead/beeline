// AGENTS.md (and CLAUDE.md, a link to it) is read at the start of every agent session, so
// every byte competes with every rule for the agent's attention. It was trimmed from 23 KB
// on 2026-11-19, two weeks after an earlier trim had grown back. This test stops it growing
// past the limit unnoticed: detail that matters only for one kind of work belongs in
// docs/agents/, behind a line in AGENTS.md that says when to read it.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const LIMIT_BYTES = 12_000;

it("AGENTS.md stays short enough to read in every session", () => {
  const size = readFileSync(new URL("../AGENTS.md", import.meta.url)).byteLength;
  expect(
    size,
    `AGENTS.md is ${size} bytes, over the limit of ${LIMIT_BYTES}. Move detail that applies only to one kind of work into docs/agents/, and leave a line in AGENTS.md that says when to read it ("Before changing X, read docs/agents/x.md"). Raise the limit only if the new text must be read in every session.`,
  ).toBeLessThanOrEqual(LIMIT_BYTES);
});
