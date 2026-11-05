import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { createKysely } from "../src/db.js";
import { prepareRun } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * "Waiting on labels" on the listings (beeline-3v33, Peter 2026-11-04): what
 * still needs labels, held back or not, against what has printed.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const f = en.listings.filters;

/**
 * Five samples of one collector:
 * - P, every specimen imported, so every label is on paper;
 * - W, three specimens and no labels yet;
 * - X, three specimens, two of them imported: one label still to print;
 * - H, held back by a missing locality, with no labels: still waiting;
 * - S, from a settled season with no labels, which never prints.
 * Then a run is prepared, which takes W and X but prints nothing.
 */
async function setup() {
  const { instance, conn } = await createMemoryDb();
  const [[staff]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('Sam Staff', 'Sam', 'Staff') RETURNING entity_id`,
  )) as [[number]];
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  const sample = (number: string, count: number, more: Record<string, string> = {}) =>
    insertCleanSample(conn, { sample_number: `'${number}'`, specimen_count: String(count), ...more });
  const imported = async (sampleId: number, numbers: number[]) => {
    for (const n of numbers) {
      await conn.run(
        `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sampleId}, ${n}, '250000${sampleId}${n}')`,
      );
    }
  };
  const p = await sample("P", 2);
  await imported(p, [1, 2]);
  const w = await sample("W", 3);
  const x = await sample("X", 3);
  await imported(x, [1, 2]);
  const h = await sample("H", 2, { locality: "NULL" });
  // 2025 has settled for good, whatever today's date.
  const s = await sample("S", 2, { date_start: "DATE '2025-07-14'", date_end: "DATE '2025-07-14'" });
  // T, settled too, with one of its two labels on paper: not waiting, since
  // nothing settled prints, and not all printed either.
  const t = await sample("T", 2, { date_start: "DATE '2025-07-15'", date_end: "DATE '2025-07-15'" });
  await imported(t, [1]);
  const run = await prepareRun(conn, { atlasId: null, personId: staff });
  expect(run?.labels).toBe(4); // W's three and X's one
  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: staff, login: "staff", iconUrl: null }),
  });
  const get = async (path: string) => (await app.request(path)).text();
  return { get, conn, ids: { p, w, x, h, s, t } };
}

const sampleLink = (id: number) => `href="/samples/${id}"`;

describe("waiting on labels", () => {
  it("on samples: any specimen without a label on paper, held back or in an unprinted run", async () => {
    const { get, ids } = await setup();
    const waiting = await get("/samples?scope=all&labels=waiting");
    for (const id of [ids.w, ids.x, ids.h]) expect(waiting).toContain(sampleLink(id));
    for (const id of [ids.p, ids.s, ids.t]) expect(waiting).not.toContain(sampleLink(id));
    expect(waiting).toContain(`${f.labels}: ${f.labelsWaiting}`);

    const printed = await get("/samples?scope=all&labels=printed");
    expect(printed).toContain(sampleLink(ids.p));
    // A settled sample never printed, or printed only in part, is neither.
    for (const id of [ids.w, ids.x, ids.h, ids.s, ids.t]) expect(printed).not.toContain(sampleLink(id));
  });

  it("counts what is waiting beside the specimens, and only where something is", async () => {
    const { get } = await setup();
    const page = await get("/samples?scope=all");
    expect(page).toContain(f.labelsWaitingCount(3)); // W
    expect(page).toContain(f.labelsWaitingCount(1)); // X
    expect(page).toContain(f.labelsWaitingCount(2)); // H
    expect(page.split("waiting on labels").length - 1).toBe(3);
  });

  it("on specimens: the specimen's own label", async () => {
    const { get, conn, ids } = await setup();
    const fieldNumbers = async (sampleId: number) =>
      ((await rows(conn, `SELECT field_number FROM specimen WHERE sample_id = ${sampleId} ORDER BY specimen_number`)) as string[][]).map(
        ([n]) => n!,
      );
    const [x1, x2, x3] = await fieldNumbers(ids.x);
    const waiting = await get("/specimens?scope=all&labels=waiting");
    // X's third specimen is in the prepared run; its first two were imported.
    expect(waiting).toContain(x3!);
    expect(waiting).not.toContain(x1!);
    expect(waiting).toContain(f.labelWaiting);
    const printed = await get("/specimens?scope=all&labels=printed");
    expect(printed).toContain(x1!);
    expect(printed).toContain(x2!);
    expect(printed).not.toContain(x3!);
  });
});
