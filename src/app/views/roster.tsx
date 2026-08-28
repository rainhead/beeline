import { PROGRAM_MEMBERSHIP } from "../../model.js";
import type { Messages } from "../messages/index.js";
import type { AtlasOption } from "../listings.js";
import {
  type BindingVerdict,
  type LinkedChange,
  type PersonDetail,
  type RosterPage,
  type RosterRow,
  type RosterQuery,
  personHandle,
  rosterHref,
} from "../roster.js";
import type { PersonChange } from "../../person-change.js";
import {
  Button,
  Callout,
  Card,
  CheckboxField,
  Chip,
  DataTable,
  EmptyState,
  FilterBar,
  Meta,
  PageHeader,
  Pager,
  SelectField,
  TextField,
} from "./components/index.js";

/**
 * The roster. Two screens: everyone, and one person.
 *
 * A listing of people, so it reads as one: name, account, how much they
 * collected, where they belong. The account promotion picked can still be
 * wrong — that is what went unnoticed in beeline-eft — so a row that is wrong
 * says so, in the account cell, where the doubt actually is. A row that is
 * fine says nothing, because a column of reassurances is a column about the
 * checking rather than about the people, and the checking ends at cutover.
 *
 * The one person screen is where that work is done, so it explains itself
 * there at length.
 */

/**
 * What the "Belongs to" cell says. Three answers, not two: an atlas code, the
 * program itself for someone who belongs to no member atlas, and a dash for
 * the people nobody has been asked about yet (beeline-lcl). The column is
 * narrow and already says what it is asking, so the program's answer is one
 * word here and spelled out on the person's own page.
 */
const membershipCell = (m: Messages, row: { membership: string | null; atlas_code: string | null }) =>
  row.membership === null
    ? "—"
    : row.membership === PROGRAM_MEMBERSHIP
      ? m.people.membershipProgramShort
      : (row.atlas_code ?? "—");

type Judged = {
  verdict: BindingVerdict;
  bound_records: number | null;
  top_login: string | null;
  top_records: number | null;
  top_holder: string | null;
};

/** A date, or the dash that means it never happened. */
const when = (m: Messages, d: Date | string | null) => (d === null ? m.people.never : m.format.date(d));

/**
 * Last seen, printed as the kind of evidence it is. A visit is a request they
 * made; a sign-in is only that, and since iNat tokens never expire it can be
 * months behind somebody who has been here every week. The two used to print
 * as one date, so a person whose sessions had been destroyed read exactly like
 * one who had really stopped coming (beeline-dji). Said only when it is the
 * weak one — the strong answer needs no qualifier.
 */
const lastSeen = (m: Messages, row: Pick<RosterRow, "last_visit" | "last_login">) =>
  row.last_visit !== null ? (
    <>{m.format.date(row.last_visit)}</>
  ) : row.last_login !== null ? (
    <>
      {m.format.date(row.last_login)} <Meta>{m.people.lastSeenSignInOnly}</Meta>
    </>
  ) : (
    <>{m.people.never}</>
  );

/**
 * The short form, for a row: the two verdicts that mean something is wrong,
 * and nothing at all for the three that do not. 'unbound' is silent here
 * because the account cell already reads "No account", which says it.
 */
function wrongChip(m: Messages, verdict: BindingVerdict) {
  const p = m.people;
  if (verdict === "outweighed") return <Chip tone="blocking">{p.accountLooksWrong}</Chip>;
  if (verdict === "unattested") return <Chip tone="warning">{p.accountNotInRecords}</Chip>;
  return null;
}

/** The long form, for the one screen where somebody acts on it. */
function accountWhy(m: Messages, row: Judged): string | null {
  const w = m.people.accountWhy;
  switch (row.verdict) {
    case "supported":
      return w.supported(row.bound_records ?? 0);
    case "outweighed":
      return w.outweighed(row.bound_records ?? 0, row.top_login ?? "", row.top_records ?? 0);
    case "unattested":
      return w.unattested;
    case "unbound":
      // "No account" is the fact; whose account their records point at is the
      // reason, and without it the row reads as an oversight rather than as a
      // household sharing a login.
      return row.top_login !== null && row.top_holder !== null
        ? w.unboundHeldBy(row.top_records ?? 0, row.top_login, row.top_holder)
        : w.unbound;
    default:
      // Nothing to weigh, so nothing to say. Saying "no legacy records" told
      // the reader about our bookkeeping, not about the person.
      return null;
  }
}

/**
 * A value as the change log holds it — a string, empty for absent — in the
 * words this screen uses everywhere else. Only the three fields whose stored
 * form is a code rather than a name need translating; the rest are already
 * what a person typed.
 */
function changeValue(m: Messages, field: PersonChange["field"], value: string) {
  const h = m.people.history;
  if (value === "") return <Meta>{field === "membership" ? h.membershipNone : h.blank}</Meta>;
  if (field === "admin") return <>{value === "yes" ? h.admin.yes : h.admin.no}</>;
  if (field === "membership" && value === PROGRAM_MEMBERSHIP) return <>{m.people.membershipProgram}</>;
  return <code>{value}</code>;
}

/** What happened, in one cell (see the catalog's `set` on why three forms). */
function changeCell(m: Messages, row: PersonChange) {
  const h = m.people.history;
  const from = changeValue(m, row.field, row.old_value);
  const to = changeValue(m, row.field, row.new_value);
  if (row.old_value === "") return <>{h.set} {to}</>;
  if (row.new_value === "") return <>{h.cleared} {from}</>;
  return (
    <>
      {from} → {to}
    </>
  );
}

/**
 * Who did it. A login is a person; anything else is a pass over the store
 * that found a difference, and says so rather than borrowing a name.
 */
function whoCell(m: Messages, row: PersonChange) {
  const h = m.people.history;
  return (
    <>
      {row.author === "" ? <Meta>{h.source[row.source]}</Meta> : <code>{row.author}</code>}
      {row.reason !== "" && <Meta block>{row.reason}</Meta>}
    </>
  );
}

/**
 * The newest entries across everybody, on the roster. The count is small
 * because this answers "has anything happened lately"; one person's whole
 * story is on their own page.
 */
function RecentChanges({ m, changes }: { m: Messages; changes: readonly LinkedChange[] }) {
  const h = m.people.history;
  if (changes.length === 0) return null;
  return (
    <Card>
      <h2>{h.recentHeading}</h2>
      <Meta block>{h.recentHint}</Meta>
      <DataTable columns={[h.colWhen, h.colPerson, h.colWhat, h.colChange, h.colWho]}>
        {changes.map((row) => (
          <tr>
            <td>{m.format.dateTime(new Date(row.at))}</td>
            <td>
              {row.handle === null ? (
                <>
                  {row.current_name ?? row.person_ref} <Meta block>{h.personGone}</Meta>
                </>
              ) : (
                <a href={`/people/${encodeURIComponent(row.handle)}`}>{row.current_name}</a>
              )}
            </td>
            <td>{h.field[row.field]}</td>
            <td>{changeCell(m, row)}</td>
            <td>{whoCell(m, row)}</td>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}

export function Roster({
  m,
  page,
  query,
  recent,
}: {
  m: Messages;
  page: RosterPage;
  query: RosterQuery;
  recent: readonly LinkedChange[];
}) {
  const p = m.people;
  // No staging to weigh an account against: the checking apparatus is not
  // dimmed or explained away, it is simply absent, and the page is a listing
  // of people. That is also what this screen becomes after cutover.
  const checking = page.evidence;
  return (
    <>
      <PageHeader title={p.heading} lede={p.intro} />

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
        {checking && (
          <CheckboxField id="suspect" name="suspect" label={p.onlySuspect} checked={query.suspect} />
        )}
      </FilterBar>

      <Meta block>{p.found(page.total)}</Meta>

      {/* The listing no longer sorts the doubtful ones to the front, so this
          is how anyone learns there are some. Said once, above the table,
          rather than repeated down a column. */}
      {checking && !query.suspect && page.lookWrong > 0 && (
        <Callout tone="warning">
          {p.lookWrong(page.lookWrong)} <a href={rosterHref(query, { suspect: true, page: 1 })}>{p.showThem}</a>
        </Callout>
      )}

      {page.rows.length === 0 ? (
        <EmptyState>{p.noPeople}</EmptyState>
      ) : (
        <DataTable
          columns={[
            p.colPerson,
            p.colAccount,
            p.colSamples,
            p.colLastSample,
            p.colLastSeen,
            p.colMembership,
            p.colAdmin,
          ]}
        >
          {page.rows.map((row) => (
            <tr>
              <td>
                <a href={`/people/${encodeURIComponent(personHandle(row))}`}>{row.display_name}</a>
              </td>
              <td>
                {row.login === null ? (
                  <>
                    <Meta>{p.noAccount}</Meta>
                    {checking && row.top_login !== null && row.top_holder !== null && (
                      <Meta block>{p.accountHeldBy(row.top_login, row.top_holder)}</Meta>
                    )}
                  </>
                ) : (
                  <>
                    <code>{row.login}</code>
                    <Meta block>{row.inat_user_id}</Meta>
                    {checking && wrongChip(m, row.verdict)}
                  </>
                )}
              </td>
              <td>{m.format.number(row.samples)}</td>
              <td>{when(m, row.last_sample)}</td>
              <td>{lastSeen(m, row)}</td>
              <td>{membershipCell(m, row)}</td>
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

      {/* Below the listing, not above it: this page is a roster, and what
          happened to somebody last week is not what anyone came here for. */}
      <RecentChanges m={m} changes={recent} />
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
  history,
  notice,
  problem,
}: {
  m: Messages;
  person: PersonDetail;
  atlases: readonly AtlasOption[];
  /** Everything the change log holds about them, newest first (beeline-o22). */
  history: readonly PersonChange[];
  notice?: string;
  problem?: string;
}) {
  const p = m.people;
  // Every form on this page posts back to the handle the URL was asked for,
  // so a login-addressed page stays login-addressed.
  const action = `/people/${encodeURIComponent(personHandle(person))}`;
  return (
    <>
      <p>
        <a href="/people">{p.backToRoster}</a>
      </p>
      <PageHeader
        title={person.display_name}
        lede={p.samplesCollected(person.samples, person.primary_samples)}
      />
      <Meta block>
        {p.colLastSample}: {when(m, person.last_sample)} · {p.colLastSeen}: {lastSeen(m, person)}
      </Meta>
      {problem !== undefined && <Callout tone="blocking">{p.problem(problem)}</Callout>}
      {notice !== undefined && <Callout tone="success">{notice}</Callout>}

      <Card>
        <h2>{p.account}</h2>
        {/* Here the doubt is the work, so it is stated in full — a chip when
            something is wrong, and the sentence either way. */}
        {wrongChip(m, person.verdict)}
        {accountWhy(m, person) !== null && <Meta block>{accountWhy(m, person)}</Meta>}
        <form id="account-form" method="post" action={`${action}/account`} class="form-column">
          <TextField
            id="inat_user_id"
            name="inat_user_id"
            label={p.inatUserId}
            value={person.inat_user_id === null ? "" : String(person.inat_user_id)}
            hint={p.accountHint}
          />
          <TextField id="login" name="login" label={p.inatLogin} value={person.login} />
          <Reason m={m} id="account_reason" />
        </form>
        {/* Unbinding needs its own form — it posts a blank id, not whatever is
            in the field — but it belongs beside Save rather than under it, so
            the buttons sit in one row and reach their forms by id. */}
        {person.inat_user_id !== null && (
          <form id="unbind-form" method="post" action={`${action}/account`}>
            <input type="hidden" name="inat_user_id" value="" />
            <input type="hidden" name="reason" value={p.unbind} />
          </form>
        )}
        <p class="row">
          <Button form="account-form">{p.bindAccount}</Button>
          {person.inat_user_id !== null && (
            <Button form="unbind-form" variant="outlined">
              {p.unbind}
            </Button>
          )}
        </p>

        {person.logins.length > 0 && (
          <>
            <h3>{p.loginsSeen}</h3>
            <Meta block>{p.loginsSeenHint}</Meta>
            {/* Status and action share the last column: 'bound' and 'Bind this
                one' answer the same question for a row, so they line up under
                one heading instead of straddling two. */}
            <DataTable columns={[p.inatLogin, p.inatUserId, p.colRecords, ""]}>
              {person.logins.map((l) => (
                <tr>
                  <td>
                    <code>{l.login}</code>
                  </td>
                  <td>{l.uid ?? "—"}</td>
                  <td>{p.records(l.records)}</td>
                  <td>
                    {l.bound ? (
                      <Chip tone="success">{p.boundMark}</Chip>
                    ) : l.uid === null ? null : (
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
        <form method="post" action={`${action}/names`} class="form-column">
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
          <p class="row">
            <Button>{p.saveNames}</Button>
          </p>
        </form>
      </Card>

      <Card>
        <h2>{p.membership}</h2>
        <form method="post" action={`${action}/membership`} class="form-column">
          <SelectField
            id="home_atlas"
            name="home_atlas"
            label={p.belongsTo}
            hint={p.belongsToHint}
            value={person.membership === PROGRAM_MEMBERSHIP ? PROGRAM_MEMBERSHIP : (person.atlas_code ?? "")}
            options={[
              ["", p.membershipUnrecorded] as const,
              ...atlases.map((a) => [a.code, a.name] as const),
              [PROGRAM_MEMBERSHIP, p.membershipProgram] as const,
            ]}
          />
          <Reason m={m} id="membership_reason" />
          <p class="row">
            <Button>{p.saveMembership}</Button>
          </p>
        </form>
      </Card>

      {/* Reach over somebody else's records (beeline-oyl). A text field of
          references rather than a picker, because the combobox that would
          make this pleasant does not exist yet (beeline-wn2) and the raw
          form is at least exactly what lands in the overlay file. */}
      <Card>
        <h2>{p.delegation}</h2>
        <Meta block>{p.delegationHint}</Meta>
        <form method="post" action={`${action}/delegate`} class="form-column">
          <TextField
            id="acts_for"
            name="acts_for"
            label={p.actsFor}
            hint={p.actsForHint}
            value={person.acts_for}
          />
          <Reason m={m} id="delegate_reason" />
          <p class="row">
            {person.acts_for === "" && <Chip>{p.actsForNobody}</Chip>}
            <Button>{p.saveDelegation}</Button>
          </p>
        </form>
      </Card>

      {/* Its own card, not a subsection of membership: which atlas someone
          belongs to and whether they may run ingestion are unrelated
          questions, and nesting the second under the first said otherwise. */}
      <Card>
        <h2>{p.adminRights}</h2>
        <Meta block>{p.adminHint}</Meta>
        <form method="post" action={`${action}/admin`} class="form-column">
          <input type="hidden" name="admin" value={person.is_admin ? "no" : "yes"} />
          <Reason m={m} id="admin_reason" />
          <p class="row">
            {person.is_admin ? <Chip tone="success">{p.isAdmin}</Chip> : <Chip>{p.notAdmin}</Chip>}
            <Button variant={person.is_admin ? "outlined" : "tonal"}>
              {person.is_admin ? p.revokeAdmin : p.grantAdmin}
            </Button>
          </p>
        </form>
      </Card>

      {/* Last, under the forms that write to it: history is what you read
          after asking "why is this like that", which is a question you have
          while looking at the field it is about. */}
      <Card>
        <h2>{p.history.heading}</h2>
        <Meta block>{p.history.hint}</Meta>
        {history.length === 0 ? (
          <EmptyState>{p.history.empty}</EmptyState>
        ) : (
          <DataTable columns={[p.history.colWhen, p.history.colWhat, p.history.colChange, p.history.colWho]}>
            {history.map((row) => (
              <tr>
                <td>{m.format.dateTime(new Date(row.at))}</td>
                <td>{p.history.field[row.field]}</td>
                <td>{changeCell(m, row)}</td>
                <td>{whoCell(m, row)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>
    </>
  );
}
