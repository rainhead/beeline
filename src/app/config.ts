import { CHANGE_LOG } from "../person-change.js";
import { SAMPLE_CHANGE_LOG, SAMPLE_STATE_SNAPSHOT } from "../sample-change.js";

/**
 * App configuration, read once from the environment at startup.
 *
 * The app process is the sole owner of the database (ADR 0005); paths here
 * name the files it opens. The private-store key must come from the
 * environment, never from a file beside the database (ADR 0003).
 */
export interface AppConfig {
  /** Listening port. */
  port: number;
  /** Path to the main database file the app owns read-write. */
  dbPath: string;
  /** Path to the encrypted private store; attached only when a key is set. */
  privateDbPath: string;
  /** Encryption key for the private store; may be null in development only. */
  privateDbKey: string | null;
  /** Public origin of this instance, e.g. https://beeline.example — OAuth redirect target and CSRF origin check. */
  origin: string;
  /**
   * iNat logins allowed on the admin surface (/jobs, beeline-6va). The
   * checked-in default below is the real roster; BEELINE_ADMIN_LOGINS
   * overrides it when set (dev/testing). Development bypasses the check
   * entirely either way.
   */
  adminLogins: string[];
  /**
   * App-written correction events (in-app sample edits, beeline-2c3.8) —
   * outside the blow-away path so they survive rebuilds; promotion reads
   * them union the git-curated CSV (ADR 0004).
   */
  correctionsPath: string;
  /**
   * App-written store of staff decisions about people — account bindings,
   * home atlas, admin rights, name fixes, merges. Outside the blow-away path
   * for the same reason corrections are (ADR 0004): a rebuild must replay
   * them, not lose them.
   */
  personOverlayPath: string;
  /**
   * The append-only log of what happened to a person, and when (beeline-o22).
   * Outside the blow-away path like the two overlays, and for a sharper
   * reason: a history a rebuild erases answers "who changed this" with
   * "nobody, we rebuilt it".
   */
  personChangesPath: string;
  /** Where sample history lives — the log, and the snapshot that is its
   * baseline (beeline-ewl; the split is deliberate, see src/sample-change.ts). */
  sampleChangesPath: string;
  sampleStatePath: string;
  /**
   * Deployment environment. Anything but 'production' renders the
   * environment banner (sandbox-until-launch, beeline-2u8).
   */
  environment: "development" | "sandbox" | "production";
  /**
   * Development-only session stub: sign every request in as this iNat login
   * until real auth lands (beeline-2c3.3). Ignored outside development.
   */
  devLogin: string | null;
  /** iNat project ids the sync jobs cover; empty = the jobs report nothing-to-do. */
  syncProjects: number[];
  /** Anti-entropy sweep depth in days: the presence-proof window (d1 = today - sweepDays). */
  sweepDays: number;
}

/**
 * The admin roster, checked in: who may see /jobs and trigger ingestion.
 * iNat logins, which are not names — 'beesofcanada' is Lincoln Best — and are
 * matched exactly, so each was verified against the iNat API rather than
 * inferred from a person's name (beeline-eft).
 */
export const ADMIN_LOGINS = [
  "rainhead", // Peter Abrahamsen, 728554
  "amelathopoulos", // Andony Melathopoulos, 429964
  "clankford", // Caleb Lankford, 8407319
  "bzand", // Bonnie Zand, 3269791
  "karen_wright", // Karen Wright, 6560268
  "beesofcanada", // Lincoln R. Best, 760776
];

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = env.BEELINE_ENV ?? "development";
  if (environment !== "development" && environment !== "sandbox" && environment !== "production") {
    throw new Error(`BEELINE_ENV must be development|sandbox|production, got '${environment}'`);
  }
  const privateDbKey = env.BEELINE_PRIVATE_DB_KEY ?? null;
  if (privateDbKey === null && environment !== "development") {
    throw new Error(`BEELINE_PRIVATE_DB_KEY is required outside development: the private store must be encrypted (ADR 0003)`);
  }
  const port = env.PORT ? Number(env.PORT) : 0xbee; // 3054: unmistakably ours among the neighbors' dev servers
  // The origin decides the cookie Secure flag, the OAuth redirect_uri, and
  // the CSRF origin check; a deploy that forgot it must not limp along on
  // localhost defaults (beeline-4cb).
  const origin = env.BEELINE_ORIGIN ?? null;
  if (origin === null && environment !== "development") {
    throw new Error(`BEELINE_ORIGIN is required outside development, e.g. https://beeline.beeatlas.net`);
  }
  // Sync settings fail here, at boot, not at 2am when the nightly first
  // reads them (beeline-vni).
  const syncProjects = (env.BEELINE_SYNC_PROJECTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const id = Number(s);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`BEELINE_SYNC_PROJECTS must be comma-separated iNat project ids, got '${s}'`);
      }
      return id;
    });
  const sweepDays = env.BEELINE_SWEEP_DAYS ? Number(env.BEELINE_SWEEP_DAYS) : 365;
  if (!Number.isInteger(sweepDays) || sweepDays <= 0) {
    throw new Error(`BEELINE_SWEEP_DAYS must be a whole number of days, got '${env.BEELINE_SWEEP_DAYS}'`);
  }
  return {
    port,
    dbPath: env.BEELINE_DB ?? "beeline.duckdb",
    privateDbPath: env.BEELINE_PRIVATE_DB ?? "private.duckdb",
    privateDbKey,
    origin: origin ?? `http://localhost:${port}`,
    adminLogins:
      env.BEELINE_ADMIN_LOGINS === undefined
        ? ADMIN_LOGINS
        : env.BEELINE_ADMIN_LOGINS.split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
    correctionsPath: env.BEELINE_CORRECTIONS ?? "data/corrections.csv",
    personOverlayPath: env.BEELINE_PERSON_OVERLAY ?? "data/person-overlay.csv",
    personChangesPath: env.BEELINE_PERSON_CHANGES ?? CHANGE_LOG,
    sampleChangesPath: env.BEELINE_SAMPLE_CHANGES ?? SAMPLE_CHANGE_LOG,
    sampleStatePath: env.BEELINE_SAMPLE_STATE ?? SAMPLE_STATE_SNAPSHOT,
    environment,
    devLogin: environment === "development" ? (env.BEELINE_DEV_LOGIN ?? null) : null,
    syncProjects,
    sweepDays,
  };
}
