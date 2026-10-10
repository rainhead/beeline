import type { Messages } from "../messages/index.js";
import type { Lead, ObserverDetail, Suggestion, UnclaimedListing, UnclaimedObserver } from "../unclaimed.js";
import {
  Absent,
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Meta,
  PageHeader,
  TextField,
} from "./components/index.js";

/**
 * Collectors Beeline does not know (beeline-e85): observers grouped by the
 * program their records fell in, each program naming its leads, since
 * whose work this is matters more here than who may do it — any admin may.
 */

const observerHref = (o: { user_id: number }) => `/unclaimed/${o.user_id}`;

function Leads({ m, leads }: { m: Messages; leads: readonly Lead[] }) {
  const u = m.unclaimed;
  if (leads.length === 0) return <Absent label={u.noLead} spelled />;
  return (
    <>
      {u.ledBy}{" "}
      {leads.map((l, i) => (
        <>
          {i > 0 && ", "}
          <a href={`/people/${encodeURIComponent(l.handle)}`}>{l.display_name}</a>
        </>
      ))}
    </>
  );
}

function Account({ o }: { o: Pick<UnclaimedObserver, "login" | "inat_name"> }) {
  return (
    <>
      <code>@{o.login}</code>
      {o.inat_name !== null && (
        <>
          {" "}
          <Meta>{o.inat_name}</Meta>
        </>
      )}
    </>
  );
}

export function UnclaimedPage({
  m,
  listing,
  notice,
}: {
  m: Messages;
  listing: UnclaimedListing;
  /** What the last connection did, with a link to the person it made. */
  notice?: { text: string; personHref: string; personName: string };
}) {
  const u = m.unclaimed;
  return (
    <>
      <PageHeader
        title={u.heading}
        lede={u.intro}
        meta={listing.observers > 0 ? u.summary(listing.records, listing.observers, listing.open_records) : undefined}
      />
      {notice !== undefined && (
        <Callout tone="success">
          {notice.text} <a href={notice.personHref}>{u.openPerson(notice.personName)}</a>
        </Callout>
      )}
      {listing.programs.length === 0 && <EmptyState heading={u.emptyHeading}>{u.empty}</EmptyState>}
      {listing.programs.map((p) => (
        <section>
          <h2>{p.name}</h2>
          <Meta block>
            <Leads m={m} leads={p.leads} />
          </Meta>
          <DataTable columns={[u.colAccount, u.colRecords, u.colThisSeason, u.colCollected, u.colMightBe]}>
            {p.observers.map((o) => (
              <tr>
                <td>
                  <a href={observerHref(o)}>
                    <Account o={o} />
                  </a>
                </td>
                <td>{m.format.number(o.records)}</td>
                <td>{m.format.number(o.open_records)}</td>
                <td>{m.format.dateRange(o.first_observed, o.last_observed)}</td>
                <td>
                  {o.suggestions.length === 0 ? (
                    <Absent label={u.noSuggestion} />
                  ) : (
                    m.format.list(o.suggestions.map((s) => s.display_name))
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      ))}
    </>
  );
}

function SuggestionRow({ m, s, login, action }: { m: Messages; s: Suggestion; login: string; action: string }) {
  const u = m.unclaimed;
  return (
    <tr>
      <td>
        <a href={`/people/${encodeURIComponent(s.handle)}`}>{s.display_name}</a>
      </td>
      <td>
        {s.evidence.map((e) => (
          <Meta block>{e === "register" ? u.evidenceRegister(login) : u.evidenceInatName}</Meta>
        ))}
      </td>
      <td class="actions">
        {s.bound_login !== null ? (
          <Chip tone="warning">{u.alreadyConnected(s.bound_login)}</Chip>
        ) : (
          <form method="post" action={`${action}/connect`}>
            <input type="hidden" name="person" value={s.display_name} />
            <Button variant="tonal">{u.thisIs(s.display_name)}</Button>
          </form>
        )}
      </td>
    </tr>
  );
}

export function ObserverPage({
  m,
  detail,
  people,
  problem,
}: {
  m: Messages;
  detail: ObserverDetail;
  /** Every display name, offered as the person types. */
  people: readonly string[];
  problem?: string;
}) {
  const u = m.unclaimed;
  const { observer: o } = detail;
  const action = observerHref(o);
  const [given, ...rest] = (o.inat_name ?? "").split(/\s+/).filter((x) => x !== "");
  return (
    <>
      <p>
        <a href="/unclaimed">{u.backToList}</a>
      </p>
      <PageHeader
        title={`@${o.login}`}
        lede={u.lede(o.records, o.first_observed, o.last_observed)}
        meta={
          <>
            {o.inat_name !== null && <>{u.profileName(o.inat_name)} · </>}
            <a href={`https://www.inaturalist.org/people/${encodeURIComponent(o.login)}`}>{u.profile}</a>
          </>
        }
      />
      {detail.programs.map((p) => (
        <Meta block>
          {u.collectedIn(p.name)} · <Leads m={m} leads={p.leads} />
        </Meta>
      ))}
      {problem !== undefined && <Callout tone="blocking">{u.problem(problem)}</Callout>}

      <Card>
        <h2>{u.existing}</h2>
        <Meta block>{u.existingHint}</Meta>
        {o.suggestions.length > 0 && (
          <DataTable columns={[u.colMightBe, "", ""]}>
            {o.suggestions.map((s) => (
              <SuggestionRow m={m} s={s} login={o.login} action={action} />
            ))}
          </DataTable>
        )}
        <form method="post" action={`${action}/connect`} class="form-column">
          <TextField id="person" name="person" label={u.someoneElse} hint={u.someoneElseHint} list="people" />
          <datalist id="people">
            {people.map((name) => (
              <option value={name} />
            ))}
          </datalist>
          <TextField id="connect_reason" name="reason" label={u.reason} />
          <p class="row">
            <Button>{u.connect}</Button>
          </p>
        </form>
      </Card>

      <Card>
        <h2>{u.newcomer}</h2>
        <Meta block>{u.newcomerHint}</Meta>
        {o.suggestions.length > 0 && <Callout tone="warning">{u.checkFirst}</Callout>}
        <form method="post" action={`${action}/add`} class="form-column">
          <TextField
            id="display_name"
            name="display_name"
            label={u.displayName}
            hint={u.displayNameHint}
            value={o.inat_name ?? ""}
          />
          <TextField id="given_name" name="given_name" label={u.givenName} value={given ?? ""} />
          <TextField
            id="family_name"
            name="family_name"
            label={u.familyName}
            hint={u.namesHint}
            value={rest.join(" ")}
          />
          <TextField id="add_reason" name="reason" label={u.reason} />
          <p class="row">
            <Button>{u.add}</Button>
          </p>
        </form>
      </Card>

      <h2>{u.records}</h2>
      <DataTable columns={[u.colSample, u.colCollected, u.colSpecimens, u.colPlace, u.colProgram, ""]}>
        {detail.records.map((r) => (
          <tr>
            <td>{r.sample_number}</td>
            <td>{m.format.date(r.observed_on)}</td>
            <td>{m.format.number(r.specimen_count)}</td>
            <td>
              {r.state_province === null ? (
                <Absent label={u.placeUnknown} spelled />
              ) : (
                m.format.place([r.county_name, r.state_province])
              )}
            </td>
            <td>{r.program_code}</td>
            <td class="actions">
              <a
                class="inat-link"
                href={`https://www.inaturalist.org/observations/${r.inat_id}`}
                title={u.viewOnInat}
              >
                <img src="/static/inat-logo.png" alt={u.viewOnInat} width="66" height="12" />
              </a>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}
