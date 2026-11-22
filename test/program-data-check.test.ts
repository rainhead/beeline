import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { ECDYSIS_CHECK_JOB } from "../src/app/ecdysis-upload.js";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import { rows, scratchPaths } from "./helpers.js";
import { BC, fixture } from "./ecdysis-upload-fixture.js";

/**
 * "Check Ecdysis now" on a program's Data tab (beeline-q8di): a lead cannot open
 * the Jobs page, so the tab starts the job itself, through the same runner, and says
 * whether a check is running and how the last one ended.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const c = en.programData.ecdysis.check;
const TAB = "/programs/BC/data";

async function setup({ running = null, accepts = true }: { running?: string | null; accepts?: boolean } = {}) {
  const f = await fixture();
  const [[lead]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Lena Lead') RETURNING entity_id`)) as [[number]];
  await f.conn.run(`INSERT INTO program_lead (program_id, person_id) VALUES ((SELECT entity_id FROM program WHERE code = 'BC'), ${lead})`);
  await f.cacheArchive(BC, [], { readHoursAgo: 1 });
  const started: string[] = [];
  let live = running;
  const app = createApp({
    ...(await scratchPaths()),
    ecdysisDir: f.dir,
    db: f.db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: f.dir },
    inat: unusedInat,
    jobs: { list: [], start: async (name) => (started.push(name), accepts), running: () => live },
    resolveSession: async () => ({ personId: lead, login: "lena", iconUrl: null }),
  });
  const press = () => app.request(`${TAB}/check-ecdysis`, { method: "POST", headers: { origin: "http://localhost:3054" } });
  const run = (name: string, outcome: "succeeded" | "failed", hoursAgo: number, detail: string) =>
    f.conn.run(
      `INSERT INTO job_run (job_name, started_at, completed_at, outcome, detail)
       VALUES ('${name}', now() - INTERVAL '${hoursAgo + 1} hours', now() - INTERVAL '${hoursAgo} hours', '${outcome}', '${detail}')`,
    );
  return { f, app, press, started, run, setRunning: (name: string | null) => (live = name) };
}

describe("Check Ecdysis now, from the Data tab", () => {
  it("starts the check once, through the job runner, and goes back to the tab; step 1 no longer sends anyone to Jobs", async () => {
    const s = await setup();
    const res = await s.press();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TAB);
    expect(s.started).toEqual([ECDYSIS_CHECK_JOB]);
    expect(ECDYSIS_CHECK_JOB).toBe("ecdysis-read-now");
    const page = await (await s.app.request(TAB)).text();
    expect(page).toContain(`action="${TAB}/check-ecdysis"`);
    expect(en.programData.ecdysis.steps.readNow).not.toContain("Jobs");
    expect(page).not.toContain('href="/jobs');
  });

  it("does not start a second check while one is running, and the tab says it is running", async () => {
    const s = await setup({ running: "ecdysis-read-now" });
    const res = await s.press();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TAB);
    expect(s.started).toEqual([]);
    expect(await (await s.app.request(TAB)).text()).toContain(c.running);
    // The nightly read is a check too.
    s.setRunning("ecdysis-fetch");
    await s.press();
    expect(s.started).toEqual([]);
  });

  it("says the last check finished, and when", async () => {
    const s = await setup();
    await s.run("ecdysis-read-now", "succeeded", 3, "6 records");
    const page = await (await s.app.request(TAB)).text();
    const [[at]] = (await rows(s.f.conn, `SELECT completed_at FROM job_run`)) as [[Date]];
    expect(page).toContain(c.finished(en.format.dateTime(new Date(at as unknown as string))));
    expect(page).not.toContain(c.running);
  });

  it("says the last check failed, with no detail of why, and to tell whoever runs Beeline", async () => {
    const s = await setup();
    await s.run("ecdysis-read-now", "succeeded", 30, "6 records");
    await s.run("ecdysis-fetch", "failed", 2, "ECONNRESET at ecdysis.org secret-internal-detail");
    const page = await (await s.app.request(TAB)).text();
    expect(page).toContain("tell whoever runs Beeline");
    expect(page).not.toContain("secret-internal-detail");
    expect(page).not.toContain("ECONNRESET");
  });

  it("says Beeline is busy when another job is running and the check could not start", async () => {
    const s = await setup({ running: "nightly-pipeline", accepts: false });
    const res = await s.press();
    expect(res.headers.get("location")).toBe(`${TAB}?check=busy`);
    expect(s.started).toEqual([ECDYSIS_CHECK_JOB]);
    expect(await (await s.app.request(`${TAB}?check=busy`)).text()).toContain(c.busy);
  });

  it("does not start a check when the last one finished under five minutes ago, and says when Ecdysis was checked", async () => {
    const s = await setup();
    await s.run("ecdysis-read-now", "succeeded", 0, "6 records");
    const res = await s.press();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${TAB}?check=recent`);
    expect(s.started).toEqual([]);
    const [[at]] = (await rows(s.f.conn, `SELECT completed_at FROM job_run`)) as [[Date]];
    const page = await (await s.app.request(`${TAB}?check=recent`)).text();
    expect(page).toContain(c.recent(en.format.dateTime(new Date(at as unknown as string))).replaceAll("'", "&#39;"));
  });

  it("starts a check once the last one finished more than five minutes ago, and after a failed one", async () => {
    const s = await setup();
    await s.run("ecdysis-read-now", "succeeded", 1, "6 records");
    expect((await s.press()).headers.get("location")).toBe(TAB);
    expect(s.started).toEqual([ECDYSIS_CHECK_JOB]);
    const t = await setup();
    await t.run("ecdysis-read-now", "failed", 0, "x");
    expect((await t.press()).headers.get("location")).toBe(TAB);
    expect(t.started).toEqual([ECDYSIS_CHECK_JOB]);
  });

  it("sets its steps in the same component as How Beeline works and the design page: one ordered list, class steps, numbered by the list", async () => {
    const s = await setup();
    const tab = await (await s.app.request(TAB)).text();
    const how = await (await s.app.request("/how-it-works")).text();
    const design = await (await s.app.request("/design/components")).text();
    for (const [name, html] of [["the Data tab", tab], ["How Beeline works", how], ["the design page", design]] as const) {
      expect(html, name).toContain('<ol class="steps">');
    }
    // The tab's seven steps, the button's step with its control under the text, and the note under the list.
    const list = /<ol class="steps">([^]*?)<\/ol>/.exec(tab)![1]!;
    expect(list.match(/<li>/g)).toHaveLength(10);
    expect(Object.keys(en.programData.ecdysis.steps).length - 1).toBe(10);
    expect(list).toContain(`<div class="step-below"><form method="post" action="${TAB}/check-ecdysis">`);
    expect(tab).toContain(en.programData.ecdysis.steps.localities);
    expect(list).not.toContain(en.programData.ecdysis.steps.localities);
    // Nothing numbers a step in its own text.
    expect(list).not.toMatch(/<p>\s*(Step )?\d+[.:)]/);
  });

  it("is not offered for a program with no Ecdysis collection", async () => {
    const s = await setup();
    await s.f.conn.run(`INSERT INTO program_lead (program_id, person_id) SELECT p.entity_id, l.person_id FROM program p, program_lead l WHERE p.code = 'OBA' LIMIT 1`);
    const res = await s.app.request("/programs/OBA/data/check-ecdysis", { method: "POST", headers: { origin: "http://localhost:3054" } });
    expect(res.status).toBe(404);
    expect(s.started).toEqual([]);
  });
});
