import type { Context } from "hono";

/**
 * Who is signed in. Minted by the auth layer (beeline-2c3.3); until that
 * lands the only resolvers are the dev stub and "nobody".
 */
export interface Session {
  personId: number;
  /** iNat login, for display. */
  login: string;
}

/** Resolves a request to a session, or null for anonymous. */
export type SessionResolver = (c: Context) => Promise<Session | null>;

export const noSession: SessionResolver = async () => null;
