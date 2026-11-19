import type { Messages } from "../messages/index.js";
import type {
  RegistrantSuggestion,
  RegistrationReason,
  RegistrationsListing,
  UndecidedCollector,
  UnplacedRegistrant,
} from "../registrations.js";
import { Absent, Button, Callout, Chip, DataTable, EmptyState, Meta, PageHeader, TextField } from "./components/index.js";

/**
 * Registrations in Ideal Logic (beeline-w8ab.2): the collectors nobody has
 * said a registration for, with the registrants that might be theirs, and the
 * registrants nobody is linked to. Nothing here is an address or an email
 * address; Beeline holds neither.
 */

const reasonText = (m: Messages, r: RegistrationReason) =>
  r === "full_name"
    ? m.registrations.reasonFullName
    : r === "family_name"
      ? m.registrations.reasonFamilyName
      : m.registrations.reasonHandle;

function Atlases({ m, atlases }: { m: Messages; atlases: readonly string[] }) {
  return atlases.length === 0 ? <Absent label={m.registrations.noAtlas} /> : <>{atlases.join(", ")}</>;
}

function Handle({ m, handle }: { m: Messages; handle: string | null }) {
  return handle === null ? <Absent label={m.registrations.noHandle} /> : <code>{handle}</code>;
}

function Program({ m, c }: { m: Messages; c: UndecidedCollector }) {
  if (c.membership === null) return <Absent label={m.registrations.notRecorded} />;
  if (c.membership === "program") return <>{m.registrations.programShort}</>;
  return <>{c.atlas_abbreviation}</>;
}

function Suggestion({ m, c, s }: { m: Messages; c: UndecidedCollector; s: RegistrantSuggestion }) {
  const r = m.registrations;
  const registrant = `${s.given_name} ${s.family_name}`;
  return (
    <div class="suggestion">
      <form method="post" action={`/registrations/${c.person_id}/link`} class="row">
        <input type="hidden" name="ideal_logic_id" value={s.ideal_logic_id} />
        <strong>{registrant}</strong>
        <Button variant="tonal">
          {r.link}
          <span class="visually-hidden"> {r.linkTo(c.display_name, registrant)}</span>
        </Button>
      </form>
      <Meta block>
        {r.colAtlases}: <Atlases m={m} atlases={s.atlases} /> · {r.colHandle}: <Handle m={m} handle={s.inat_handle} /> ·{" "}
        <small>
          {r.idealLogicId} <code>{s.ideal_logic_id}</code>
        </small>
      </Meta>
      {s.reasons.map((x) => (
        <Meta block>{reasonText(m, x)}</Meta>
      ))}
      {s.linked_to.length > 0 && <Chip tone="warning">{r.alsoLinkedTo(m.format.list(s.linked_to))}</Chip>}
    </div>
  );
}

function CollectorRow({ m, c }: { m: Messages; c: UndecidedCollector }) {
  const r = m.registrations;
  return (
    <tr>
      <td>
        <a href={`/people/${c.person_id}`}>{c.display_name}</a>
        {c.waiting > 0 && (
          <>
            {" "}
            <Chip tone="warning">{r.labelsWaiting}</Chip>
          </>
        )}
        {c.waiting === 0 && c.in_unmailed_run > 0 && (
          <>
            {" "}
            <Chip>{r.labelsInRun}</Chip>
          </>
        )}
      </td>
      <td>{c.login === null ? <Absent label={r.noLogin} /> : <code>@{c.login}</code>}</td>
      <td>
        <Program m={m} c={c} />
      </td>
      <td>{m.format.number(c.samples)}</td>
      <td>
        {c.suggestions.length === 0 ? (
          <Absent label={r.noSuggestion} />
        ) : (
          c.suggestions.map((s) => <Suggestion m={m} c={c} s={s} />)
        )}
        <details>
          <summary>{r.byId}</summary>
          <form method="post" action={`/registrations/${c.person_id}/link`} class="form-column">
            <TextField
              id={`id-${c.person_id}`}
              name="ideal_logic_id"
              label={r.byIdLabel(c.display_name)}
              hint={r.byIdHint}
            />
            <p class="row">
              <Button variant="outlined">{r.link}</Button>
            </p>
          </form>
        </details>
      </td>
      <td class="actions">
        <form method="post" action={`/registrations/${c.person_id}/none`}>
          <Button variant="outlined">
            {r.none}
            <span class="visually-hidden"> {r.noneFor(c.display_name)}</span>
          </Button>
        </form>
      </td>
    </tr>
  );
}

function RegistrantRow({ m, x }: { m: Messages; x: UnplacedRegistrant }) {
  return (
    <tr>
      <td>
        {x.given_name} {x.family_name} <Meta>{m.registrations.idealLogicId} </Meta>
        <small>
          <code>{x.ideal_logic_id}</code>
        </small>
      </td>
      <td>
        <Atlases m={m} atlases={x.atlases} />
      </td>
      <td>
        {x.inat_handle === null ? (
          <Handle m={m} handle={null} />
        ) : x.unclaimed_user_id === null ? (
          <code>{x.inat_handle}</code>
        ) : (
          <a href={`/unclaimed/${x.unclaimed_user_id}`} title={m.registrations.openObserver(x.inat_handle)}>
            <code>{x.inat_handle}</code>
          </a>
        )}
      </td>
      <td>{m.format.date(x.first_seen_at)}</td>
    </tr>
  );
}

export function RegistrationsPage({
  m,
  listing,
  notice,
  problem,
}: {
  m: Messages;
  listing: RegistrationsListing;
  /** What the last decision did, as a sentence. */
  notice?: string;
  /** Why a decision was refused. */
  problem?: string;
}) {
  const r = m.registrations;
  return (
    <>
      <PageHeader title={r.heading} lede={r.intro} />
      {problem !== undefined && <Callout tone="blocking">{r.problem(problem)}</Callout>}
      {notice !== undefined && <Callout tone="success">{notice}</Callout>}

      <section id="collectors">
        <h2>{r.collectorsHeading(listing.collectors.length)}</h2>
        <Meta block>{r.collectorsHint}</Meta>
        {listing.collectors.length === 0 ? (
          <EmptyState heading={r.collectorsEmptyHeading}>{r.collectorsEmpty}</EmptyState>
        ) : (
          <DataTable columns={[r.colPerson, r.colLogin, r.colProgram, r.colSamples, r.colSuggested, ""]}>
            {listing.collectors.map((c) => (
              <CollectorRow m={m} c={c} />
            ))}
          </DataTable>
        )}
      </section>

      <section id="registrants">
        <h2>{r.registrantsHeading(listing.registrants.length)}</h2>
        <Meta block>{r.registrantsHint}</Meta>
        {listing.registrants.length === 0 ? (
          <EmptyState heading={r.registrantsEmptyHeading}>{r.registrantsEmpty}</EmptyState>
        ) : (
          <DataTable columns={[r.colName, r.colAtlases, r.colHandle, r.colFirstSeen]}>
            {listing.registrants.map((x) => (
              <RegistrantRow m={m} x={x} />
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
