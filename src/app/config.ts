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
  /** Encryption key for the private store, or null to skip attaching it. */
  privateDbKey: string | null;
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
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = env.BEELINE_ENV ?? "development";
  if (environment !== "development" && environment !== "sandbox" && environment !== "production") {
    throw new Error(`BEELINE_ENV must be development|sandbox|production, got '${environment}'`);
  }
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    dbPath: env.BEELINE_DB ?? "beeline.duckdb",
    privateDbPath: env.BEELINE_PRIVATE_DB ?? "private.duckdb",
    privateDbKey: env.BEELINE_PRIVATE_DB_KEY ?? null,
    environment,
    devLogin: environment === "development" ? (env.BEELINE_DEV_LOGIN ?? null) : null,
  };
}
