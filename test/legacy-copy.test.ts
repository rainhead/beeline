import type { DuckDBConnection } from "@duckdb/node-api";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { configFromEnv } from "../src/app/config.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import {
  assertCopied,
  COPIED_COLUMNS,
  copyToOldBeeline,
  describeCopy,
  legacyCopyId,
  specimenOfLegacyCopyId,
  type OldBeelineCredentials,
} from "../src/legacy-copy.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, rows } from "./helpers.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

/**
 * A stand-in for the old Beeline's API, written from its code
 * (OBP-Server server/src/controllers/OccurrencesController.js, AdminController
 * login, shared/lib/utils/utilities.ts parseQueryParameters and
 * OccurrenceService.upsertOccurrence): a JWT in a cookie after login; a GET
 * that reads a comma-separated fieldNumber as whole matches; a POST that
 * upserts each record by _id, setting only the fields given, whose reply
 * counts go null once one record is new; and Express's 100 kB body limit.
 */
class FakeOldBeeline {
  records = new Map<string, Record<string, unknown>>();
  posts: Record<string, string>[][] = [];
  logins = 0;
  server: Server;

  constructor() {
    this.server = createServer(async (req, res) => {
      const body = await read(req);
      const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      const url = new URL(req.url!, "http://old");
      const authed = req.headers.cookie?.split(/;\s*/).includes("token=jwt-for-copier") ?? false;
      if (req.method === "POST" && url.pathname === "/api/admins/login") {
        const { username, password } = JSON.parse(body);
        if (username !== "copier" || password !== "s3cret") return send(401, { error: "Invalid credentials" });
        this.logins++;
        return send(200, undefined, { "set-cookie": "token=jwt-for-copier; Path=/; HttpOnly; SameSite=Strict" });
      }
      if (url.pathname !== "/api/occurrences") return send(404, { error: "no such route" });
      if (req.method === "GET") {
        const numbers = url.searchParams.get("fieldNumber")?.split(",") ?? [];
        if (!authed) return send(401, { error: "Unauthorized requests must query a single userLogin" });
        const per = Number(url.searchParams.get("per_page") ?? 50);
        const page = Number(url.searchParams.get("page") ?? 1);
        const all = [...this.records.values()].filter((r) => numbers.includes(String(r.fieldNumber)));
        const data = all.slice((page - 1) * per, page * per);
        return send(200, { data, pagination: { hasNextPage: page * per < all.length } });
      }
      if (req.method === "POST") {
        if (body.length > 100 * 1024) return send(413, { error: "request entity too large" });
        if (!authed) return send(401, { error: "admin only in this stand-in" });
        const { occurrences } = JSON.parse(body) as { occurrences: (Record<string, string> & { _id: string })[] };
        this.posts.push(occurrences);
        let anyNew = false;
        for (const o of occurrences) {
          const held = this.records.get(o._id);
          if (held) Object.assign(held, o, { scratch: false });
          else {
            anyNew = true;
            this.records.set(o._id, { ...o, scratch: false });
          }
        }
        const n = anyNew ? null : occurrences.length;
        return send(200, { modifiedCount: n, upsertedCount: n, matchedCount: n });
      }
      send(405);
    });
  }

  async start(): Promise<OldBeelineCredentials> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, username: "copier", password: "s3cret" };
  }
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

let conn: DuckDBConnection;
let old: FakeOldBeeline;
let creds: OldBeelineCredentials;
/** Specimens of the sample printed here, by field number. */
const printed = new Map<string, number>();
let unprinted: number;
let canceled: number;
let reprintedImport: number;

/** A print run in a given state, its labels for these specimens. */
async function printRun(specimens: number[], state: "printed" | "canceled"): Promise<void> {
  const by = "(SELECT min(entity_id) FROM person)";
  const result = await conn.run(
    state === "printed"
      ? `INSERT INTO print_run (prepared_by, approved_by, approved_at, printed_by, printed_at)
         VALUES (${by}, ${by}, now(), ${by}, now()) RETURNING entity_id`
      : `INSERT INTO print_run (prepared_by, canceled_by, canceled_at) VALUES (${by}, ${by}, now()) RETURNING entity_id`,
  );
  const [[run]] = (await result.getRows()) as [[number]];
  for (const [cell, id] of specimens.entries()) {
    await conn.run(
      `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                  collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
       SELECT ${run}, sp.entity_id, 1 + ${cell} // 250, ${cell} % 250, 'l', 'c', 'd', 'c', 'm', 'n', 44.5, -123.6, s.date_start, s.date_end
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.entity_id = ${id}`,
    );
  }
}

async function specimen(sampleId: number, n: number, fieldNumber: string | null): Promise<number> {
  const result = await conn.run(
    `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sampleId}, ${n}, ${fieldNumber === null ? "NULL" : `'${fieldNumber}'`})
     RETURNING entity_id`,
  );
  return ((await result.getRows()) as [[number]])[0][0];
}

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  // The legacy fixture's specimens are imported: the old system has them already.
  await loadLegacyStaging(conn, FIXTURE);
  await promoteLegacy(conn, FIXTURE_INPUTS);
  // One sample minted here and printed, with enough specimens that the copy
  // needs more than one request: a hundred and twenty.
  const sample = await insertCleanSample(conn, { sample_number: "'41'", inat_observation_id: "374773381", host_name_as_observed: "'Sedum album'", host_rank: "'species'" });
  for (let n = 1; n <= 120; n++) printed.set(String(26090000 + n), await specimen(sample, n, String(26090000 + n)));
  await printRun([...printed.values()], "printed");
  // Not copied: a specimen with no label yet, and one whose only run was canceled.
  const other = await insertCleanSample(conn, { sample_number: "'42'" });
  unprinted = await specimen(other, 1, null);
  canceled = await specimen(other, 2, "26095002");
  await printRun([canceled], "canceled");
  // Not copied either: an imported specimen Beeline printed again under its own number.
  [[reprintedImport]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '25000001'`)) as [[number]];
  await printRun([reprintedImport], "printed");

  old = new FakeOldBeeline();
  creds = await old.start();
});

afterAll(() => old.server.close());

beforeEach(() => {
  old.posts = [];
  old.logins = 0;
});

describe("copying printed specimens into the old Beeline", () => {
  test("a dry run reads the old system and says what it would send, and sends and records nothing", async () => {
    const r = await copyToOldBeeline(conn, creds, { dryRun: true });
    expect(r).toMatchObject({ printed: 120, unchanged: 0, inserted: 120, updated: 0, dryRun: true });
    expect(describeCopy(r)).toContain("120 would be copied anew");
    expect(old.posts).toEqual([]);
    expect(old.records.size).toBe(0);
    expect(await rows(conn, "SELECT count(*) FROM legacy_copy")).toEqual([[0n]]);
  });

  test("copies every specimen printed here, and nothing imported, unprinted or canceled", async () => {
    const r = await copyToOldBeeline(conn, creds);
    expect(r).toMatchObject({ printed: 120, inserted: 120, updated: 0, collisions: [], unverified: [] });
    expect(old.logins).toBe(1);
    const ids = [...old.records.keys()];
    expect(ids).toHaveLength(120);
    expect(ids).toContain(legacyCopyId(printed.get("26090001")!));
    for (const id of [unprinted, canceled, reprintedImport]) expect(ids).not.toContain(legacyCopyId(id));
    expect(await rows(conn, "SELECT count(*), count(DISTINCT field_number) FROM legacy_copy")).toEqual([[120n, 120n]]);
    // In batches the old server will read: more than one, none near its 100 kB limit.
    expect(old.posts.length).toBeGreaterThan(1);
    for (const post of old.posts) {
      expect(post.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify({ occurrences: post }).length).toBeLessThan(100 * 1024);
    }
  });

  test("writes the export's row: all 63 template columns, the print date, the collector's login, the host", () => {
    const record = old.records.get(legacyCopyId(printed.get("26090007")!))!;
    for (const c of COPIED_COLUMNS) expect(record).toHaveProperty(c);
    expect(record).not.toHaveProperty("occurrenceRemarks");
    expect(record).toMatchObject({
      fieldNumber: "26090007",
      sampleId: "41",
      specimenId: "7",
      speciesPlant: "Sedum album",
      url: "https://www.inaturalist.org/observations/374773381",
      // ADR 0008: Beeline mints no occurrenceID, so there is none to send.
      occurrenceID: "",
    });
    expect(record.dateLabelPrint).toMatch(/^\d{1,2}-[A-Z][a-z]{2}-\d{2}$/);
    expect(record.userLogin).not.toBe("");
  });

  test("sends exactly the row the export writes, though it reads no staged legacy record", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "legacy-copy-")), "occurrences.csv");
    await writeLegacyExport(conn, path);
    const reader = await conn.runAndReadAll(
      `SELECT * FROM read_csv('${path}', header = true, all_varchar = true) WHERE try_cast("fieldNumber" AS BIGINT) BETWEEN 26090001 AND 26090120`,
    );
    const exported = reader.getRowObjectsJson() as Record<string, string | null>[];
    expect(exported).toHaveLength(120);
    for (const row of exported) {
      const record = old.records.get(legacyCopyId(printed.get(row.fieldNumber!)!))!;
      for (const c of COPIED_COLUMNS) expect([row.fieldNumber, c, record[c]]).toEqual([row.fieldNumber, c, row[c] ?? ""]);
    }
  });

  test("a night with nothing changed sends nothing and does not sign in", async () => {
    const r = await copyToOldBeeline(conn, creds);
    expect(r).toMatchObject({ printed: 120, unchanged: 120, inserted: 0, updated: 0 });
    expect(old.logins).toBe(0);
    expect(old.posts).toEqual([]);
  });

  test("a change reaches the old record, and never overwrites what a volunteer entered there", async () => {
    // A volunteer identifies specimen 3 in the old Beeline.
    const three = old.records.get(legacyCopyId(printed.get("26090003")!))!;
    Object.assign(three, { familyVolDet: "Halictidae", genusVolDet: "Lasioglossum", sexVolDet: "female" });
    // Staff correct the sample's locality here.
    await conn.run(`UPDATE sample SET locality = 'Philomath' WHERE sample_number = '41'`);
    const r = await copyToOldBeeline(conn, creds);
    expect(r).toMatchObject({ unchanged: 0, inserted: 0, updated: 120 });
    expect(three).toMatchObject({ locality: "Philomath", familyVolDet: "Halictidae", genusVolDet: "Lasioglossum", sexVolDet: "female" });
    for (const post of old.posts) {
      const sent = post.find((o) => o._id === three._id);
      if (sent) expect(sent).not.toHaveProperty("familyVolDet");
    }
  });

  test("a record the old system lost is made again when everything is sent", async () => {
    const id = legacyCopyId(printed.get("26090010")!);
    old.records.delete(id);
    const r = await copyToOldBeeline(conn, creds, { all: true });
    expect(r).toMatchObject({ inserted: 1, updated: 119 });
    expect(old.records.get(id)).toMatchObject({ fieldNumber: "26090010" });
  });

  test("never sends a field number the old system holds under another record, and fails the night", async () => {
    const id = legacyCopyId(printed.get("26090020")!);
    old.records.set("6b09ffad195b941413e3080619e750ddf3d9a60c600677389600985575dc7c32", { _id: "6b09ffad195b941413e3080619e750ddf3d9a60c600677389600985575dc7c32", fieldNumber: "26090020" });
    const before = { ...old.records.get(id)! };
    await conn.run(`UPDATE sample SET locality = 'Monroe' WHERE sample_number = '41'`);
    const r = await copyToOldBeeline(conn, creds);
    expect(r.collisions).toEqual(["26090020 (held by old record 6b09ffad195b941413e3080619e750ddf3d9a60c600677389600985575dc7c32)"]);
    expect(r.updated).toBe(119);
    expect(old.records.get(id)).toEqual(before);
    expect(() => assertCopied(r)).toThrow(/1 not sent, their field number held by another old record: 26090020/);
    // It was not recorded as copied, so the next night tries again, and only it.
    const again = await copyToOldBeeline(conn, creds, { dryRun: true });
    expect(again).toMatchObject({ unchanged: 119, updated: 0, collisions: [r.collisions[0]] });
    old.records.delete("6b09ffad195b941413e3080619e750ddf3d9a60c600677389600985575dc7c32");
    expect(await copyToOldBeeline(conn, creds)).toMatchObject({ unchanged: 119, updated: 1, collisions: [] });
    expect(old.records.get(id)).toMatchObject({ locality: "Monroe" });
  });

  test("follows a specimen to a second field number, finding its old record by the number it still holds", async () => {
    // A duplicate repair: specimen 30 is given a new number, and the old
    // record must move with it rather than a second one be made, so that a
    // volunteer's entry on it is kept.
    const id = legacyCopyId(printed.get("26090030")!);
    Object.assign(old.records.get(id)!, { genusVolDet: "Bombus" });
    await conn.run(`UPDATE specimen SET field_number = '26090999' WHERE entity_id = ${printed.get("26090030")}`);
    const r = await copyToOldBeeline(conn, creds);
    expect(r).toMatchObject({ inserted: 0, updated: 1, collisions: [] });
    expect(old.records.get(id)).toMatchObject({ fieldNumber: "26090999", genusVolDet: "Bombus" });
    expect([...old.records.values()].filter((o) => o.fieldNumber === "26090030")).toEqual([]);
  });

  test("a refused login fails, naming the old Beeline and not the password", async () => {
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE sample_number = '41'`);
    const err = await copyToOldBeeline(conn, { ...creds, password: "wrong" }).catch((e: Error) => e);
    expect(String(err)).toContain("old Beeline answered POST /api/admins/login with 401");
    expect(String(err)).not.toContain("wrong");
  });
});

describe("the old record's id", () => {
  test("names the specimen it is a copy of, and nothing the old system made", () => {
    expect(legacyCopyId(384751)).toBe("beeline-specimen-384751");
    expect(specimenOfLegacyCopyId("beeline-specimen-384751")).toBe(384751);
    expect(specimenOfLegacyCopyId("8a169a543c2cb166b488ef40e88a5639561a4f2d7eeef3049eda8e1ab7f6b788")).toBeNull();
    expect(specimenOfLegacyCopyId("beeline-specimen-")).toBeNull();
    expect(specimenOfLegacyCopyId("beeline-specimen-012")).toBeNull();
  });

  test("is never a length the old server would read as a Mongo ObjectId", () => {
    for (const id of [1, 12, 123456, 1234567]) {
      const s = legacyCopyId(id);
      expect(s.length).not.toBe(12);
      expect(/^[0-9a-f]{24}$/i.test(s)).toBe(false);
    }
  });
});

describe("the legacy-copy job", () => {
  const job = (env: Record<string, string>) =>
    buildJobs(configFromEnv({ BEELINE_ORIGIN: "https://melittologist.org", ...env })).find((j) => j.name === "legacy-copy")!;

  test("fails in production without a login, since copying nothing would read like a copy", async () => {
    await expect(job({ BEELINE_ENV: "production" }).run({} as never)).rejects.toThrow(/nothing was copied into the old Beeline/);
  });

  test("stands down without a login anywhere else", async () => {
    expect(await job({ BEELINE_ENV: "development" }).run({} as never)).toMatch(/nothing copied/);
  });

  test("wants the login whole", () => {
    expect(() => configFromEnv({ OLD_BEELINE_USERNAME: "copier" })).toThrow(/must be set together/);
  });
});
