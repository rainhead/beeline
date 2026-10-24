import type { Messages } from "../messages/index.js";
import {
  DECIDED_FILTERS,
  STANDING_FILTERS,
  ecdysisTaxonHref,
  taxonHref,
  taxonomyHref,
  taxonSpecimensHref,
  type AcceptedName,
  type TaxonDecision,
  type TaxonList,
  type TaxonNode,
  type TaxonRef,
  type TaxonRow,
  type TaxonomyQuery,
  type TaxonomySummary,
} from "../taxonomy.js";
import {
  Absent,
  Breadcrumbs,
  Button,
  Callout,
  Chip,
  DataTable,
  EmptyState,
  FilterBar,
  Meta,
  PageHeader,
  Pager,
  SelectField,
  TaxonName,
  Term,
  TextField,
} from "./components/index.js";

/**
 * The taxonomy (beeline-45v.5): an index that is both a way into the tree and
 * a list of names by standing, and one page per name.
 *
 * Read by everyone, like the glossary, so every word comes from the catalog.
 * A row says something about Ecdysis only when the name is not simply
 * accepted there: a chip reading "accepted" down 3,476 rows is a column about the
 * checking rather than about the names — the roster's reasoning, for the same
 * reason.
 */

/**
 * A node's name, set by TaxonName. A subgenus is stored as `Genus (Subgenus)`
 * (schema/025), which TaxonName brackets correctly only when handed the parts.
 */
function Name({ taxon, authorship }: { taxon: TaxonRef; authorship?: string | null }) {
  const parts = taxon.rank === "subgenus" ? /^(\S+) \((\S+)\)$/.exec(taxon.scientific_name) : null;
  return parts !== null ? (
    <TaxonName rank={taxon.rank} scientificName={parts[1]!} subgenus={parts[2]!} authorship={authorship} />
  ) : (
    <TaxonName rank={taxon.rank} scientificName={taxon.scientific_name} authorship={authorship} />
  );
}

function LinkedName({ taxon }: { taxon: TaxonRef }) {
  return (
    <a href={taxonHref(taxon)}>
      <Name taxon={taxon} />
    </a>
  );
}

/** The name Ecdysis files an outdated one under, linked where the tree holds that name too. */
function AcceptedNameOf({ name }: { name: AcceptedName }) {
  return name.held ? <LinkedName taxon={name} /> : <Name taxon={name} />;
}

/**
 * A row's Ecdysis cell: nothing, unless there is something to say. A name a
 * taxonomist has decided about says that first, in the decision's words, and
 * keeps the Ecdysis fact beneath it — the warning tone is for a disagreement
 * nobody has ruled on.
 */
function StandingCell({ m, row }: { m: Messages; row: TaxonRow }) {
  const t = m.taxonomy;
  if (row.decision !== null) {
    return (
      <>
        <Chip>{t.chip.decided[row.decision.kind]}</Chip>
        {row.standing === "synonym" && row.accepted !== null && (
          <Meta block>
            {t.nowCalled} <AcceptedNameOf name={row.accepted} />
          </Meta>
        )}
      </>
    );
  }
  switch (row.standing) {
    case "synonym":
      return (
        <>
          <Chip tone="warning">{t.chip.synonym}</Chip>
          {row.accepted !== null && (
            <Meta block>
              {t.nowCalled} <AcceptedNameOf name={row.accepted} />
            </Meta>
          )}
        </>
      );
    case "homonym":
      return <Chip tone="warning">{t.chip.homonym}</Chip>;
    case "absent":
      return <Chip>{t.chip.absent}</Chip>;
    case "accepted":
      // A row speaks about Ecdysis only when the name is not simply
      // accepted there — which is most rows, so a dash rather than a column
      // of "Accepted". Quiet to the eye is not blank: the dash still says
      // what it means, where an empty cell could as well have failed to load.
      return <Absent label={t.standingOptions.accepted} />;
    default:
      // A store without the thesaurus says so once, above the table; the cell says
      // only that there is nothing here.
      return <Absent label={m.absence.none} />;
  }
}

function TaxonTable({
  m,
  rows,
  admin,
  filedUnder = false,
}: {
  m: Messages;
  rows: readonly TaxonRow[];
  admin: boolean;
  filedUnder?: boolean;
}) {
  const t = m.taxonomy;
  const columns = filedUnder
    ? [t.colName, t.colRank, t.colFiledUnder, t.colEcdysis, t.colSpecimens]
    : [t.colName, t.colRank, t.colEcdysis, t.colSpecimens];
  return (
    <DataTable columns={columns}>
      {rows.map((row) => (
        <tr>
          <td>
            <LinkedName taxon={row} />
          </td>
          <td>{row.rank}</td>
          {filedUnder && (
            <td>{row.parent === null ? <Absent label={m.absence.none} /> : <LinkedName taxon={row.parent} />}</td>
          )}
          <td>
            <StandingCell m={m} row={row} />
          </td>
          <td>
            {/* Everyone's specimens, counted, and a link to exactly those. */}
            {row.specimens > 0 ? (
              <a href={taxonSpecimensHref(row)}>{m.format.number(row.specimens)}</a>
            ) : (
              m.format.number(row.specimens)
            )}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

const trailTo = (taxa: readonly TaxonRef[]) => taxa.map((taxon) => ({ href: taxonHref(taxon), label: <Name taxon={taxon} /> }));

export function TaxonomyIndex({
  m,
  query,
  summary,
  list,
  start,
  admin,
}: {
  m: Messages;
  query: TaxonomyQuery;
  summary: TaxonomySummary;
  /** The matching names, when a name or a standing was asked for. */
  list: TaxonList | null;
  /** Where browsing starts, when nothing was. */
  start: { node: TaxonNode | null; roots: TaxonRow[] } | null;
  /** Staff, whose specimen counts link to every record they count. */
  admin: boolean;
}) {
  const t = m.taxonomy;
  const loaded = summary.ecdysisFetchedOn !== null;
  return (
    <>
      <PageHeader
        title={t.title}
        lede={
          <>
            {t.intro}{" "}
            <Term m={m} slug="ecdysis">
              {t.aboutEcdysis}
            </Term>
          </>
        }
        meta={summary.ecdysisFetchedOn !== null ? t.fetched(summary.ecdysisFetchedOn) : undefined}
      />
      {!loaded && <Callout>{t.notLoaded}</Callout>}
      {loaded && (
        <Meta block>
          {(["accepted", "synonym", "homonym", "absent"] as const).map((standing, i) => (
            <>
              {i > 0 && " · "}
              <a href={taxonomyHref({ search: "", standing, decided: "any", page: 1 })}>{t.summary[standing](summary.standings[standing])}</a>
            </>
          ))}
          {/* Said only once somebody has decided something: a program with no
              decisions yet is not one with zero to worry about. */}
          {summary.decided > 0 && (
            <>
              {" · "}
              <a href={taxonomyHref({ search: "", standing: "any", decided: "decided", page: 1 })}>{t.summary.decided(summary.decided)}</a>
              {", "}
              <a href={taxonomyHref({ search: "", standing: "any", decided: "moved", page: 1 })}>{t.summary.moved(summary.moved)}</a>
            </>
          )}
        </Meta>
      )}

      <FilterBar
        action="/taxonomy"
        actions={
          <>
            <Button>{t.apply}</Button>
            <a class="button outlined" href="/taxonomy">
              {t.clear}
            </a>
          </>
        }
      >
        <TextField id="q" name="q" label={t.search} value={query.search} hint={t.searchHint} />
        {/* Standing means nothing until the thesaurus is loaded, so there is nothing to filter by. */}
        {loaded && (
          <SelectField
            id="standing"
            name="standing"
            label={t.standingLabel}
            value={query.standing}
            options={STANDING_FILTERS.map((standing) => [standing, t.standingOptions[standing]] as const)}
          />
        )}
        {loaded && (
          <SelectField
            id="decided"
            name="decided"
            label={t.decidedLabel}
            value={query.decided}
            options={DECIDED_FILTERS.map((decided) => [decided, t.decidedOptions[decided]] as const)}
          />
        )}
      </FilterBar>

      {list !== null ? (
        <>
          <Meta block>{t.found(list.total)}</Meta>
          {list.rows.length === 0 ? <EmptyState>{t.nothingFound}</EmptyState> : <TaxonTable m={m} rows={list.rows} admin={admin} filedUnder />}
          <Pager
            summary={t.pageOf(list.page, list.pages)}
            previousHref={list.page > 1 ? taxonomyHref(query, { page: list.page - 1 }) : null}
            nextHref={list.page < list.pages ? taxonomyHref(query, { page: list.page + 1 }) : null}
            previousLabel={t.previous}
            nextLabel={t.next}
          />
        </>
      ) : start?.node ? (
        <>
          <h2>{t.browse}</h2>
          <Breadcrumbs label={t.filedUnder} trail={trailTo([...start.node.lineage, start.node])} />
          <TaxonTable m={m} rows={start.node.children} admin={admin} />
        </>
      ) : start !== null && start.roots.length > 0 ? (
        <>
          <h2>{t.browse}</h2>
          <TaxonTable m={m} rows={start.roots} admin={admin} />
        </>
      ) : (
        <EmptyState>{t.empty}</EmptyState>
      )}
    </>
  );
}

/** What Ecdysis says about this one name, said once and in full. */
function EcdysisStanding({ m, node }: { m: Messages; node: TaxonNode }) {
  const s = m.taxonomy.standing;
  const report = (tid: bigint) => <a href={ecdysisTaxonHref(tid)}>{s.report(String(tid))}</a>;
  switch (node.standing) {
    case "not loaded":
      return <Callout>{m.taxonomy.notLoaded}</Callout>;
    case "accepted":
      return (
        <Meta block>
          {s.accepted} {node.ecdysis_tid !== null && report(node.ecdysis_tid)}
        </Meta>
      );
    case "synonym":
      return (
        <Callout tone="warning">
          <p>
            {s.synonym} {node.accepted !== null && <AcceptedNameOf name={node.accepted} />}
          </p>
          {node.ecdysis_tid !== null && <p>{report(node.ecdysis_tid)}</p>}
        </Callout>
      );
    case "homonym":
      return (
        <Callout tone="warning">
          <p>{s.homonym}</p>
          <ul>
            {node.homonyms.map((h) => (
              <li>
                <Name taxon={node} authorship={h.author} /> · {report(h.tid)}
              </li>
            ))}
          </ul>
        </Callout>
      );
    case "absent":
      return <Callout>{s.absent(node.rank)}</Callout>;
  }
}

/**
 * What the program has decided about this name against Ecdysis, and on whose
 * word (beeline-45v.1): the kind of decision in words, who and when, the
 * reason, the paper where there is one, and — when the thesaurus now loaded
 * has moved since — what moved, so the page is also where a taxonomist
 * sees that a decision wants another look.
 */
function Decision({ m, node, decision }: { m: Messages; node: TaxonNode; decision: TaxonDecision }) {
  const d = m.taxonomy.decision;
  return (
    <Callout>
      <p>
        {decision.kind === "addition" && d.addition}
        {decision.kind === "departure" && (
          <>
            {d.departure} {node.accepted !== null && <AcceptedNameOf name={node.accepted} />}
          </>
        )}
        {decision.kind === "homonym" && d.homonym(decision.author)}
      </p>
      <p>{d.by(decision.taxonomist, decision.decided_on, decision.ecdysis_fetched_on)}</p>
      <p>{decision.reason}</p>
      {decision.reference !== null && (
        <p>
          {d.reference} <Reference value={decision.reference} />
        </p>
      )}
      {node.moved !== null && (
        <p>
          <strong>{d.moved}</strong> {node.moved}
        </p>
      )}
    </Callout>
  );
}

/**
 * The paper behind a decision, as a link where it can safely be one: an
 * http(s) URL as written, a bare DOI through doi.org, and anything else as
 * text — the value arrives from a taxonomist's sheet, and escaping does not
 * stop a `javascript:` scheme from being a scheme (CodeRabbit, #124).
 */
function Reference({ value }: { value: string }) {
  if (/^https?:\/\//i.test(value)) return <a href={value}>{value}</a>;
  if (/^10\.\d{4,}\/\S+$/.test(value)) return <a href={`https://doi.org/${value}`}>{value}</a>;
  return <>{value}</>;
}

export function TaxonPage({ m, node, admin }: { m: Messages; node: TaxonNode; admin: boolean }) {
  const t = m.taxonomy;
  return (
    <>
      <Breadcrumbs label={t.filedUnder} trail={[{ href: "/taxonomy", label: t.title }, ...trailTo(node.lineage)]} />
      <PageHeader
        title={<Name taxon={node} authorship={node.authorship} />}
        meta={
          <>
            {node.rank} · {t.specimens(node.specimens)}
          </>
        }
      />
      <EcdysisStanding m={m} node={node} />
      {node.decision !== null && <Decision m={m} node={node} decision={node.decision} />}
      {node.specimens > 0 && (
        <p>
          {/* Said only when something below was counted: on a name with nothing
              below it, both halves are the same number. */}
          {node.determinedHere < node.specimens ? t.determinedHere(node.determinedHere, node.rank) : t.counted}{" "}
          <a href={taxonSpecimensHref(node)}>{t.seeSpecimens}</a>
        </p>
      )}
      <h2>{t.below}</h2>
      {node.children.length === 0 ? <EmptyState>{t.nothingBelow}</EmptyState> : <TaxonTable m={m} rows={node.children} admin={admin} />}
    </>
  );
}
