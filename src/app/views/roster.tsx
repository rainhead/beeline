import type { Messages } from "../messages/index.js";
import type { AtlasOption } from "../listings.js";
import {
  type BindingVerdict,
  type PersonDetail,
  type RosterPage,
  type RosterQuery,
  rosterHref,
} from "../roster.js";
import {
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  Meta,
  PageHeader,
  Pager,
  SelectField,
  TextField,
  type Tone,
} from "./components/index.js";

/**
 * The roster. Two screens: everyone, and one person.
 *
 * The evidence column is the point of the listing. A binding that reads
 * "backed · 3,042 records" and one that reads "check this · 1 record, but
 * 3,042 use amelathopoulos" are indistinguishable in any view that prints
 * only the login, which is why the wrong one survived review for as long as
 * it did (beeline-eft).
 */

const VERDICT_TONE: Record<BindingVerdict, Tone | undefined> = {
  supported: "success",
  outweighed: "blocking",
  unattested: "warning",
  unbound: undefined,
  "no-evidence": undefined,
};

function verdictLabel(m: Messages, v: BindingVerdict): string {
  const p = m.people;
  return v === "supported"
    ? p.verdictSupported
    : v === "outweighed"
      ? p.verdictOutweighed
      : v === "unattested"
        ? p.verdictUnattested
        : v === "unbound"
          ? p.verdictUnbound
          : p.verdictNoEvidence;
}

function verdictWhy(m: Messages, row: { verdict: BindingVerdict; bound_records: number | null; top_login: string | null; top_records: number | null }): string {
  const w = m.people.verdictWhy;
  switch (row.verdict) {
    case "supported":
      return w.supported(row.bound_records ?? 0);
    case "outweighed":
      return w.outweighed(row.bound_records ?? 0, row.top_login ?? "", row.top_records ?? 0);
    case "unattested":
      return w.unattested;
    case "unbound":
      return w.unbound;
    default:
      return w.noEvidence;
  }
}

function Verdict({ m, row }: { m: Messages; row: Parameters<typeof verdictWhy>[1] }) {
  const tone = VERDICT_TONE[row.verdict];
  return (
    <>
      <Chip tone={tone}>{verdictLabel(m, row.verdict)}</Chip>
      <Meta block>{verdictWhy(m, row)}</Meta>
    </>
  );
}

export function Roster({ m, page, query }: { m: Messages; page: RosterPage; query: RosterQuery }) {
  const p = m.people;
  return (
    <>
      <PageHeader title={p.heading} lede={p.intro} />
      {!page.evidence && <Callout tone="warning">{p.noEvidenceBanner}</Callout>}

      <FilterBar
        action="/people"
        actions={
          <>
            <Button>{p.apply}</Button>
            <a class="button outlined" href="/people">
              {p.clear}
            </a>
          </>
        }
      >
        <TextField id="q" name="q" label={p.search} value={query.search} hint={p.searchHint} />
        <Field id="suspect" label={p.onlySuspect}>
          <input id="suspect" name="suspect" type="checkbox" value="1" checked={query.suspect} />
        </Field>
      </FilterBar>

      <Meta block>{p.found(page.total)}</Meta>

      {page.rows.length === 0 ? (
        <EmptyState>{p.noPeople}</EmptyState>
      ) : (
        <DataTable
          columns={[p.colPerson, p.colAccount, p.colEvidence, p.colSamples, p.colAtlas, p.colAdmin]}
        >
          {page.rows.map((row) => (
            <tr>
              <td>
                <a href={`/people/${row.person_id}`}>{row.display_name}</a>
              </td>
              <td>
                {row.login === null ? (
                  "—"
                ) : (
                  <>
                    <code>{row.login}</code>
                    <Meta block>{row.inat_user_id}</Meta>
                  </>
                )}
              </td>
              <td>
                <Verdict m={m} row={row} />
              </td>
              <td>{m.format.number(row.samples)}</td>
              <td>{row.atlas_code ?? "—"}</td>
              <td>{row.is_admin ? <Chip tone="success">{p.colAdmin}</Chip> : "—"}</td>
            </tr>
          ))}
        </DataTable>
      )}

      <Pager
        summary={p.pageOf(page.page, page.pages)}
        previousHref={page.page > 1 ? rosterHref(query, { page: page.page - 1 }) : null}
        nextHref={page.page < page.pages ? rosterHref(query, { page: page.page + 1 }) : null}
        previousLabel={p.previous}
        nextLabel={p.next}
      />
    </>
  );
}

/** A hidden reason field, on every form that writes to the overlay. */
function Reason({ m, id }: { m: Messages; id: string }) {
  return <TextField id={id} name="reason" label={m.people.reason} hint={m.people.reasonHint} />;
}

export function PersonPage({
  m,
  person,
  atlases,
  notice,
  problem,
}: {
  m: Messages;
  person: PersonDetail;
  atlases: readonly AtlasOption[];
  notice?: string;
  problem?: string;
}) {
  const p = m.people;
  const action = `/people/${person.person_id}`;
  return (
    <>
      <p>
        <a href="/people">{p.backToRoster}</a>
      </p>
      <PageHeader title={person.display_name} lede={p.samplesCollected(person.samples, person.primary_samples)} />
      {problem !== undefined && <Callout tone="blocking">{p.problem(problem)}</Callout>}
      {notice !== undefined && <Callout tone="success">{notice}</Callout>}

      <Card>
        <h2>{p.account}</h2>
        <p>
          <Verdict m={m} row={person} />
        </p>
        <form method="post" action={`${action}/account`}>
          <TextField
            id="inat_user_id"
            name="inat_user_id"
            label={p.inatUserId}
            value={person.inat_user_id === null ? "" : String(person.inat_user_id)}
            hint={p.accountHint}
          />
          <TextField id="login" name="login" label={p.inatLogin} value={person.login} />
          <Reason m={m} id="account_reason" />
          <div class="filter-actions">
            <Button>{p.bindAccount}</Button>
          </div>
        </form>
        {/* Its own form: forms do not nest, and unbinding is not a variant of
            saving — it is the one action here that takes sign-in away. */}
        {person.inat_user_id !== null && (
          <form method="post" action={`${action}/account`}>
            <input type="hidden" name="inat_user_id" value="" />
            <input type="hidden" name="reason" value={p.unbind} />
            <Button variant="outlined">{p.unbind}</Button>
          </form>
        )}

        {person.logins.length > 0 && (
          <>
            <h3>{p.loginsSeen}</h3>
            <Meta block>{p.loginsSeenHint}</Meta>
            <DataTable columns={[p.inatLogin, p.inatUserId, p.colEvidence, ""]}>
              {person.logins.map((l) => (
                <tr>
                  <td>
                    <code>{l.login}</code>
                  </td>
                  <td>{l.uid ?? "—"}</td>
                  <td>
                    {p.records(l.records)}
                    {l.bound && (
                      <>
                        {" "}
                        <Chip tone="success">{p.boundMark}</Chip>
                      </>
                    )}
                  </td>
                  <td>
                    {!l.bound && l.uid !== null && (
                      <form method="post" action={`${action}/account`}>
                        <input type="hidden" name="inat_user_id" value={String(l.uid)} />
                        <input type="hidden" name="login" value={l.login} />
                        <input type="hidden" name="reason" value={p.records(l.records)} />
                        <Button variant="tonal">{p.useThis}</Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </Card>

      <Card>
        <h2>{p.identity}</h2>
        <form method="post" action={`${action}/names`}>
          <TextField id="display_name" name="display_name" label={p.displayName} value={person.display_name} />
          <TextField id="given_name" name="given_name" label={p.givenName} value={person.given_name} />
          <TextField id="family_name" name="family_name" label={p.familyName} value={person.family_name} />
          <TextField
            id="label_name"
            name="label_name"
            label={p.labelName}
            value={person.label_name}
            hint={p.labelNameHint}
          />
          <Reason m={m} id="names_reason" />
          <div class="filter-actions">
            <Button>{p.saveNames}</Button>
          </div>
        </form>
      </Card>

      <Card>
        <h2>{p.membership}</h2>
        <form method="post" action={`${action}/membership`}>
          <SelectField
            id="home_atlas"
            name="home_atlas"
            label={p.homeAtlas}
            hint={p.homeAtlasHint}
            value={person.atlas_code ?? ""}
            options={[["", p.noAtlas] as const, ...atlases.map((a) => [a.code, a.name] as const)]}
          />
          <Reason m={m} id="membership_reason" />
          <div class="filter-actions">
            <Button>{p.saveMembership}</Button>
          </div>
        </form>

        <h3>{p.adminRights}</h3>
        <Meta block>{p.adminHint}</Meta>
        <p>{person.is_admin ? <Chip tone="success">{p.isAdmin}</Chip> : <Chip>{p.notAdmin}</Chip>}</p>
        <form method="post" action={`${action}/admin`}>
          <input type="hidden" name="admin" value={person.is_admin ? "no" : "yes"} />
          <Reason m={m} id="admin_reason" />
          <Button variant={person.is_admin ? "outlined" : "tonal"}>
            {person.is_admin ? p.revokeAdmin : p.grantAdmin}
          </Button>
        </form>
      </Card>

    </>
  );
}
