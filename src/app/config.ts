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
  return {
    port,
    dbPath: env.BEELINE_DB ?? "beeline.duckdb",
    privateDbPath: env.BEELINE_PRIVATE_DB ?? "private.duckdb",
    privateDbKey,
    origin: env.BEELINE_ORIGIN ?? `http://localhost:${port}`,
    environment,
    devLogin: environment === "development" ? (env.BEELINE_DEV_LOGIN ?? null) : null,
    syncProjects: (env.BEELINE_SYNC_PROJECTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map(Number),
    sweepDays: env.BEELINE_SWEEP_DAYS ? Number(env.BEELINE_SWEEP_DAYS) : 365,
  };
}
