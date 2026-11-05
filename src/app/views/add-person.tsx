import type { Messages } from "../messages/index.js";
import type { AccountStanding, InatProfile, TurnedAway } from "../add-person.js";
import { Button, Callout, Card, CheckboxField, DataTable, EmptyState, Meta, PageHeader, TextField } from "./components/index.js";

/**
 * Adding somebody by their iNaturalist account (beeline-2c3.33): look the
 * account up, confirm it is the right one, name them. Below, the people
 * turned away at sign-in, each one a click from the same form.
 */

const profileHref = (login: string) => `https://www.inaturalist.org/people/${encodeURIComponent(login)}`;
const addHref = (login: string) => `/people/new?account=${encodeURIComponent(login)}`;

export function AddPersonPage({
  m,
  typed,
  found,
  turnedAway,
  problem,
}: {
  m: Messages;
  /** What was typed into the lookup, kept so a mistake can be corrected. */
  typed?: string;
  /** The account looked up, and what Beeline already knows about it. */
  found?: { profile: InatProfile; standing: AccountStanding };
  turnedAway: readonly TurnedAway[];
  problem?: string;
}) {
  const a = m.addPerson;
  return (
    <>
      <p>
        <a href="/people">{a.backToPeople}</a>
      </p>
      <PageHeader title={a.heading} lede={a.intro} />
      {problem !== undefined && <Callout tone="blocking">{problem}</Callout>}

      <Card>
        <form method="get" action="/people/new" class="form-column">
          <TextField id="account" name="account" label={a.lookUp} hint={a.lookUpHint} value={typed ?? ""} />
          <p class="row">
            <Button>{a.find}</Button>
          </p>
        </form>
      </Card>

      {found !== undefined && <Found m={m} profile={found.profile} standing={found.standing} />}

      <h2>{a.turnedAwayHeading}</h2>
      <Meta block>{a.turnedAwayHint}</Meta>
      {turnedAway.length === 0 ? (
        <EmptyState>{a.turnedAwayEmpty}</EmptyState>
      ) : (
        <DataTable columns={[a.colAccount, a.colTried, ""]}>
          {turnedAway.map((t) => (
            <tr>
              <td>
                <a href={profileHref(t.login)}>@{t.login}</a>
              </td>
              <td>{a.tried(t.first_tried, t.last_tried)}</td>
              <td class="actions">
                <a href={addHref(t.login)}>{a.addThem}</a>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}

function Found({ m, profile: p, standing }: { m: Messages; profile: InatProfile; standing: AccountStanding }) {
  const a = m.addPerson;
  const [given, ...rest] = (p.name ?? "").split(/\s+/).filter((x) => x !== "");
  return (
    <Card>
      <h2>
        {p.iconUrl !== null && <img src={p.iconUrl} alt="" width="32" height="32" class="avatar" />} @{p.login}
      </h2>
      <Meta block>
        {p.name === null ? a.noProfileName : a.profileName(p.name)} · {a.about(p.observations, p.joined)} ·{" "}
        <a href={profileHref(p.login)}>{a.profile}</a>
      </Meta>
      {standing.kind === "held" && (
        <Callout>
          {a.held(standing.name)} <a href={`/people/${encodeURIComponent(standing.handle)}`}>{a.openPerson(standing.name)}</a>
        </Callout>
      )}
      {standing.kind === "waiting" && (
        <Callout>
          {a.waiting(standing.records)} <a href={`/unclaimed/${p.id}`}>{a.openWaiting}</a>
        </Callout>
      )}
      {standing.kind === "free" && (
        <>
          {standing.triedToSignIn !== null && <Meta block>{a.triedToSignIn(standing.triedToSignIn)}</Meta>}
          <form method="post" action="/people/new" class="form-column">
            <input type="hidden" name="inat_user_id" value={String(p.id)} />
            <TextField id="display_name" name="display_name" label={a.displayName} hint={a.displayNameHint} value={p.name ?? ""} />
            <TextField id="given_name" name="given_name" label={a.givenName} value={given ?? ""} />
            <TextField id="family_name" name="family_name" label={a.familyName} hint={a.namesHint} value={rest.join(" ")} />
            <CheckboxField id="staff" name="staff" label={a.staff} hint={a.staffHint} />
            <TextField id="reason" name="reason" label={a.reason} />
            <p class="row">
              <Button>{a.add}</Button>
            </p>
          </form>
        </>
      )}
    </Card>
  );
}
