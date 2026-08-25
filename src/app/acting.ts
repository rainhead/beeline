import type { Context } from "hono";
import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Session } from "./session.js";

/**
 * Acting for somebody else.
 *
 * A household shares one iNat login and an account belongs to exactly one
 * person (beeline-oyl), so the partner who does not hold it never signs in
 * and their samples are unreachable by the person who does — 1,087 of the
 * Pedersons' 2,233 are in that state. `person_delegate` says who may reach
 * whose; this is how that reach is switched on.
 *
 * It is an explicit switch rather than a widening of `mine`. `mine` keeps
 * meaning mine everywhere in the app: while the switch is on, "mine" is the
 * person being acted for, and while it is off it is the person signed in.
 * The two are never blended, because a page mixing Gretchen's 1,146 samples
 * with Robert's 1,087 leaves a volunteer unable to say whose work they are
 * reading — and Master Melittology progress hangs off the person.
 *
 * Reach, never credit: nothing here changes who collected anything. A sample
 * saved while acting for Robert is still Robert's.
 *
 * NOT in the query string, unlike scope and every filter. Those are questions
 * about the records and travel fine in a pasted URL; this is a question about
 * who is asking, and the recipient of a pasted link may hold no grant at all.
 * So it is a cookie, and the grant behind it is re-checked on every request —
 * a revoked delegation stops working at once, and a forged cookie names a
 * person the signed-in user was never granted and resolves to nothing.
 */
export const ACTING_COOKIE = "beeline_acting";

export interface Acting {
  /** Whose records "mine" means: the acted-for person, or the signed-in one. */
  personId: number;
  /** The acted-for person, or null when the switch is off. */
  actingFor: { personId: number; name: string } | null;
  /**
   * Everyone this session may act for — empty for almost everybody, since a
   * grant is a staff decision about a household. Resolved here rather than
   * again at render time: validating the cookie already has to read the
   * grants, so the chrome's picker costs nothing extra.
   */
  canActFor: readonly { personId: number; name: string }[];
}

/** Everyone the signed-in person may act for, for the chrome's picker. */
export async function delegations(
  db: Kysely<Database>,
  personId: number,
): Promise<{ personId: number; name: string }[]> {
  const rows = await db
    .selectFrom("person_delegate as d")
    .innerJoin("person as p", "p.entity_id", "d.acts_for_id")
    .select(["p.entity_id as personId", "p.display_name as name"])
    .where("d.person_id", "=", personId)
    .orderBy("p.display_name")
    .execute();
  return rows.map((r) => ({ personId: Number(r.personId), name: r.name }));
}

/**
 * Resolve the switch for one request. Falls back to the signed-in person
 * whenever the cookie is absent, unparseable, or names somebody this session
 * holds no grant over — the last of which is also what a revocation looks
 * like, so it needs no separate path.
 */
export async function resolveActing(
  db: Kysely<Database>,
  session: Session,
  c: Context,
): Promise<Acting> {
  const canActFor = await delegations(db, session.personId);
  const self: Acting = { personId: session.personId, actingFor: null, canActFor };
  const raw = getCookie(c, ACTING_COOKIE);
  if (raw === undefined || !/^\d+$/.test(raw)) return self;
  const granted = canActFor.find((d) => d.personId === Number(raw));
  if (granted === undefined) return self;
  return { personId: granted.personId, actingFor: granted, canActFor };
}

/**
 * `secure` follows the origin, as the session and OAuth-state cookies do
 * (src/app/auth.tsx) and as the scope cookie does not. This one sits with the
 * session cookies rather than with scope: scope only filters what you read,
 * while this decides whose records the sample-edit gate lets you WRITE.
 */
export const startActing = (c: Context, personId: number, origin: string) =>
  setCookie(c, ACTING_COOKIE, String(personId), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: origin.startsWith("https:"),
  });

export const stopActing = (c: Context) => deleteCookie(c, ACTING_COOKIE, { path: "/" });
