import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OldBeelineCredentials } from "../src/legacy-copy.js";

/**
 * A stand-in for the old Beeline's API, written from its code
 * (OBP-Server server/src/controllers/OccurrencesController.js, AdminController
 * login, shared/lib/utils/utilities.ts parseQueryParameters and
 * OccurrenceService.upsertOccurrence): a JWT in a cookie after login; a GET
 * that reads each column given as a test on it, ANDed — `(empty)`,
 * `(non-empty)`, or a comma-separated list of whole, case-insensitive
 * matches — and pages in a stable order; a POST that
 * upserts each record by _id, setting only the fields given, whose reply
 * counts go null once one record is new; and Express's 100 kB body limit.
 */
export class FakeOldBeeline {
  records = new Map<string, Record<string, unknown>>();
  posts: Record<string, string>[][] = [];
  /** The query string of every GET, in order. */
  reads: string[] = [];
  logins = 0;
  /** Runs once, after the copy's read and before its write lands: a volunteer saving in between. */
  beforeNextWrite: (() => void) | null = null;
  /** A field this server fails to store, so the read-back differs from what was sent. */
  dropOnWrite: string | null = null;
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
        if (!authed) return send(401, { error: "Unauthorized requests must query a single userLogin" });
        const per = Math.min(Number(url.searchParams.get("per_page") ?? 50), 5000);
        const page = Number(url.searchParams.get("page") ?? 1);
        this.reads.push(url.search);
        const tests = [...url.searchParams].filter(([k]) => k !== "per_page" && k !== "page");
        const blank = (v: unknown) => v === undefined || v === null || v === "";
        const all = [...this.records.values()]
          .filter((r) =>
            tests.every(([k, v]) =>
              v === "(empty)" ? blank(r[k]) : v === "(non-empty)" ? !blank(r[k])
                : v.split(",").some((w) => String(r[k] ?? "").toLowerCase() === w.toLowerCase()),
            ),
          )
          .sort((a, b) => String(a._id).localeCompare(String(b._id)));
        const data = all.slice((page - 1) * per, page * per);
        return send(200, { data, pagination: { hasNextPage: page * per < all.length } });
      }
      if (req.method === "POST") {
        if (Buffer.byteLength(body) > 100 * 1024) return send(413, { error: "request entity too large" });
        if (!authed) return send(401, { error: "admin only in this stand-in" });
        const { occurrences } = JSON.parse(body) as { occurrences: (Record<string, string> & { _id: string })[] };
        this.posts.push(occurrences);
        this.beforeNextWrite?.();
        this.beforeNextWrite = null;
        let anyNew = false;
        for (const sent of occurrences) {
          const o = { ...sent };
          if (this.dropOnWrite) delete o[this.dropOnWrite];
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
