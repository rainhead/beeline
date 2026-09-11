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
 *
 * It names that person the way the overlay does — by display name, not by
 * `entity_id`. An id is a per-store sequence draw that a rebuild or a
 * `db:reseed` redraws, and this cookie is client-held, so no rebuild can
 * reach it: a delegate holding two grants whose numbers permute would have
 * had a stale cookie land on a *different* granted person, silently, on a
 * switch that gates writes. That is the session bug (beeline-ten) in its
 * second home. A name that no longer matches falls back to self, which is
 * the safe direction; an ambiguous one does too, rather than pick.
 */
export const ACTING_COOKIE = "beeline_acting";

/**
 * Impersonation (beeline-jjt) is the same switch for staff, without a grant:
 * an admin looks at Beeline exactly as one volunteer sees it, to help them
 * over the phone or to check what a volunteer is being told. It reuses
 * everything above — `mine` means that person on every surface, the person
 * is named by display name and re-resolved every request — and differs in
 * three ways the routes enforce rather than this module: it is read-only,
 * it takes the admin surfaces away for the duration so the view is faithful,
 * and turning it on leaves a trace (private.impersonation). Its own cookie,
 * not a mode on the delegation one, so the delegation cookie keeps the
 * property that a forged value resolves to nothing for everyone.
 */
export const IMPERSONATING_COOKIE = "beeline_impersonating";

export interface Acting {
  /** Whose records "mine" means: the acted-for person, or the signed-in one. */
  personId: number;
  /** The acted-for person, or null when the switch is off. */
  actingFor: { personId: number; name: string } | null;
  /**
   * True when actingFor was reached by impersonation rather than by a grant.
   * The chrome says which, and the write paths refuse under it.
   */
  impersonating: boolean;
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
  /** Whether the signed-in person is an admin — the only people impersonation resolves for. */
  admin = false,
): Promise<Acting> {
  // Impersonation wins over delegation: an admin who turned it on chose it
  // deliberately, and the picker that would set the other cookie is hidden
  // for the duration. The delegation grants are deliberately NOT carried
  // across — they are the signed-in person's, and the view is meant to be
  // the volunteer's.
  const impersonated = admin ? await resolveImpersonation(db, c) : null;
  if (impersonated !== null) {
    return { personId: impersonated.personId, actingFor: impersonated, impersonating: true, canActFor: [] };
  }
  const canActFor = await delegations(db, session.personId);
  const self: Acting = { personId: session.personId, actingFor: null, impersonating: false, canActFor };
  const raw = getCookie(c, ACTING_COOKIE);
  if (raw === undefined || raw === "") return self;
  // Exactly one, or nobody: two grants sharing a display name is a household
  // naming problem, and guessing between them is how the wrong person gets
  // written to.
  const matches = canActFor.filter((d) => d.name === raw);
  const granted = matches.length === 1 ? matches[0] : undefined;
  if (granted === undefined) return self;
  return { personId: granted.personId, actingFor: granted, impersonating: false, canActFor };
}

/**
 * The person an impersonation cookie names, or null when there is no cookie
 * or it names nobody or more than one somebody. Two people sharing a display
 * name cannot be told apart by Beeline at all (CONTEXT.md, Person identity),
 * so falling back to self is the same rule the delegation switch follows.
 * Only ever consulted for an admin; a volunteer's cookie is never read.
 */
async function resolveImpersonation(
  db: Kysely<Database>,
  c: Context,
): Promise<{ personId: number; name: string } | null> {
  const raw = getCookie(c, IMPERSONATING_COOKIE);
  if (raw === undefined || raw === "") return null;
  const rows = await db
    .selectFrom("person")
    .select(["entity_id as personId", "display_name as name"])
    .where("display_name", "=", raw)
    .limit(2)
    .execute();
  const [only] = rows;
  if (rows.length !== 1 || only === undefined) return null;
  return { personId: Number(only.personId), name: only.name };
}

/**
 * `secure` follows the origin, as the session and OAuth-state cookies do
 * (src/app/auth.tsx) and as the scope cookie does not. This one sits with the
 * session cookies rather than with scope: scope only filters what you read,
 * while this decides whose records the sample-edit gate lets you WRITE.
 */
export const startActing = (c: Context, name: string, origin: string) =>
  setCookie(c, ACTING_COOKIE, name, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: origin.startsWith("https:"),
  });

export const stopActing = (c: Context) => deleteCookie(c, ACTING_COOKIE, { path: "/" });

/** Same cookie attributes as the delegation switch, for the same reason. */
export const startImpersonating = (c: Context, name: string, origin: string) =>
  setCookie(c, IMPERSONATING_COOKIE, name, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: origin.startsWith("https:"),
  });

export const stopImpersonating = (c: Context) => deleteCookie(c, IMPERSONATING_COOKIE, { path: "/" });
