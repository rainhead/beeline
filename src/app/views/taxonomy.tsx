import type { Messages } from "../messages/index.js";
import {
  STANDING_FILTERS,
  itisReportHref,
  taxonHref,
  taxonomyHref,
  taxonSpecimensHref,
  type CurrentName,
  type TaxonList,
  type TaxonNode,
  type TaxonRef,
  type TaxonRow,
  type TaxonomyQuery,
  type TaxonomySummary,
} from "../taxonomy.js";
import {
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
 * A row says something about ITIS only when the name is not simply current
 * there: a chip reading "current" down 3,357 rows is a column about the
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

/** What ITIS calls an outdated name now, linked where the tree holds that name too. */
function CurrentNames({ names }: { names: readonly CurrentName[] }) {
  return (
    <>
      {names.map((name, i) => (
        <>
          {i > 0 && ", "}
          {name.held ? <LinkedName taxon={name} /> : <Name taxon={name} />}
        </>
      ))}
    </>
  );
}

/** A row's ITIS cell: nothing, unless there is something to say. */
function StandingCell({ m, row }: { m: Messages; row: TaxonRow }) {
  const t = m.taxonomy;
  switch (row.standing) {
    case "synonym":
      return (
        <>
          <Chip tone="warning">{t.chip.synonym}</Chip>
          {row.current.length > 0 && (
            <Meta block>
              {t.nowCalled} <CurrentNames names={row.current} />
            </Meta>
          )}
        </>
      );
    case "homonym":
      return <Chip tone="warning">{t.chip.homonym}</Chip>;
    case "absent":
      return <Chip>{t.chip.absent}</Chip>;
    default:
      return null;
  }
}

function TaxonTable({ m, rows, filedUnder = false }: { m: Messages; rows: readonly TaxonRow[]; filedUnder?: boolean }) {
  const t = m.taxonomy;
  const columns = filedUnder
    ? [t.colName, t.colRank, t.colFiledUnder, t.colItis, t.colSpecimens]
    : [t.colName, t.colRank, t.colItis, t.colSpecimens];
  return (
    <DataTable columns={columns}>
      {rows.map((row) => (
        <tr>
          <td>
            <LinkedName taxon={row} />
          </td>
          <td>{row.rank}</td>
          {filedUnder && <td>{row.parent === null ? "—" : <LinkedName taxon={row.parent} />}</td>}
          <td>
            <StandingCell m={m} row={row} />
          </td>
          <td>{m.format.number(row.specimens)}</td>
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
}: {
  m: Messages;
  query: TaxonomyQuery;
  summary: TaxonomySummary;
  /** The matching names, when a name or a standing was asked for. */
  list: TaxonList | null;
  /** Where browsing starts, when nothing was. */
  start: { node: TaxonNode | null; roots: TaxonRow[] } | null;
}) {
  const t = m.taxonomy;
  const loaded = summary.itisAsOf !== null;
  return (
    <>
      <PageHeader
        title={t.title}
        lede={
          <>
            {t.intro}{" "}
            <Term m={m} slug="itis">
              {t.aboutItis}
            </Term>
          </>
        }
        meta={summary.itisAsOf !== null ? t.release(summary.itisAsOf) : undefined}
      />
      {!loaded && <Callout>{t.notLoaded}</Callout>}
      {loaded && (
        <Meta block>
          {(["valid", "synonym", "homonym", "absent"] as const).map((standing, i) => (
            <>
              {i > 0 && " · "}
              <a href={taxonomyHref({ search: "", standing, page: 1 })}>{t.summary[standing](summary.standings[standing])}</a>
            </>
          ))}
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
        {/* Standing means nothing until ITIS is loaded, so there is nothing to filter by. */}
        {loaded && (
          <SelectField
            id="standing"
            name="standing"
            label={t.standingLabel}
            value={query.standing}
            options={STANDING_FILTERS.map((standing) => [standing, t.standingOptions[standing]] as const)}
          />
        )}
      </FilterBar>

      {list !== null ? (
        <>
          <Meta block>{t.found(list.total)}</Meta>
          {list.rows.length === 0 ? <EmptyState>{t.nothingFound}</EmptyState> : <TaxonTable m={m} rows={list.rows} filedUnder />}
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
          <TaxonTable m={m} rows={start.node.children} />
        </>
      ) : start !== null && start.roots.length > 0 ? (
        <>
          <h2>{t.browse}</h2>
          <TaxonTable m={m} rows={start.roots} />
        </>
      ) : (
        <EmptyState>{t.empty}</EmptyState>
      )}
    </>
  );
}

/** What ITIS says about this one name, said once and in full. */
function ItisStanding({ m, node }: { m: Messages; node: TaxonNode }) {
  const s = m.taxonomy.standing;
  const report = (tsn: bigint) => <a href={itisReportHref(tsn)}>{s.report(String(tsn))}</a>;
  switch (node.standing) {
    case "not loaded":
      return <Callout>{m.taxonomy.notLoaded}</Callout>;
    case "valid":
      return (
        <Meta block>
          {s.valid} {node.itis_tsn !== null && report(node.itis_tsn)}
        </Meta>
      );
    case "synonym":
      return (
        <Callout tone="warning">
          <p>
            {s.synonym} <CurrentNames names={node.current} />
          </p>
          {node.itis_tsn !== null && <p>{report(node.itis_tsn)}</p>}
        </Callout>
      );
    case "homonym":
      return (
        <Callout tone="warning">
          <p>{s.homonym}</p>
          <ul>
            {node.homonyms.map((h) => (
              <li>
                <Name taxon={node} authorship={h.author} /> · {report(h.tsn)}
              </li>
            ))}
          </ul>
        </Callout>
      );
    case "absent":
      return <Callout>{s.absent(node.rank)}</Callout>;
  }
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
      <ItisStanding m={m} node={node} />
      {node.specimens > 0 && (
        <p>
          {/* Said only when something below was counted: on a name with nothing
              below it, both halves are the same number. */}
          {node.determinedHere < node.specimens ? t.determinedHere(node.determinedHere, node.rank) : t.counted}{" "}
          {/* The listing applies its own scope, so a volunteer lands on their own. */}
          <a href={taxonSpecimensHref(node)}>{admin ? t.seeSpecimens : t.seeYourSpecimens}</a>
        </p>
      )}
      <h2>{t.below}</h2>
      {node.children.length === 0 ? <EmptyState>{t.nothingBelow}</EmptyState> : <TaxonTable m={m} rows={node.children} />}
    </>
  );
}
