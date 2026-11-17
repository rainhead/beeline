import type { Messages } from "../messages/index.js";
import { AREA_TABS, type AreaGroup, type AreaGrouping, type AreaTab } from "../areas.js";
import { ALL, EMPTY_QUERY, listingHref } from "../listings.js";
import { DataTable, EmptyState, PageHeader, Tabs } from "./components/index.js";

/**
 * The areas (beeline-9jd4), as three pages a row of tabs moves between:
 * administrative districts, properties and ecoregions (Peter, 2026-11-17).
 * Each area is a row with the samples inside it from the active seasons and
 * from settled ones. Staff only (src/app/areas.ts says why), so an area's
 * name links to the Samples listing filtered to exactly that area, across
 * every program.
 */

export const areasHref = (tab: AreaTab) => `/areas/${tab}`;

/** A section's heading: a kind of property, or a district's state or province. */
function heading(m: Messages, grouping: AreaGrouping): string {
  if (grouping.by === "kind") return m.areas.kind[grouping.kind];
  return grouping.state === null ? m.areas.stateUnknown : m.format.place([grouping.state, grouping.country]);
}

/** A section's address within the page. */
const anchor = (grouping: AreaGrouping) =>
  grouping.by === "kind" ? grouping.kind : `${grouping.country ?? "none"}-${grouping.state ?? "none"}`;

export function AreaIndex({ m, tab, groups: unordered }: { m: Messages; tab: AreaTab; groups: AreaGroup[] }) {
  const a = m.areas;
  // Sections in alphabetical order of their headings (Peter, 2026-11-17),
  // the districts no state could be read for last.
  const collator = new Intl.Collator(m.locale, { sensitivity: "base" });
  const unknown = (g: AreaGroup) => (g.grouping.by === "state" && g.grouping.state === null ? 1 : 0);
  const groups = [...unordered].sort(
    (x, y) => unknown(x) - unknown(y) || collator.compare(heading(m, x.grouping), heading(m, y.grouping)),
  );
  return (
    <>
      <PageHeader title={a.title} lede={a.intro[tab]} />
      <Tabs label={a.tabsLabel} tabs={AREA_TABS.map((t) => ({ href: areasHref(t), label: a.tab[t], current: t === tab }))} />
      {groups.length === 0 ? (
        <EmptyState>{a.none}</EmptyState>
      ) : (
        <>
          {groups.length > 1 && (
            <nav class="jump-links" aria-label={a.sectionsLabel}>
              {groups.map((group) => (
                <a href={`#${anchor(group.grouping)}`}>{a.sectionCount(heading(m, group.grouping), group.areas.length)}</a>
              ))}
            </nav>
          )}
          {groups.map((group) => (
            <section>
              {/* A district always says its state: Benton County is in two. */}
              {(groups.length > 1 || group.grouping.by === "state") && (
                <h2 id={anchor(group.grouping)}>{heading(m, group.grouping)}</h2>
              )}
              {group.grouping.by === "kind" && a.kindNote[group.grouping.kind] !== undefined && (
                <p>{a.kindNote[group.grouping.kind]}</p>
              )}
              <DataTable columns={[a.colArea[tab], a.colActive, a.colSettled]}>
                {group.areas.map((area) => (
                  <tr>
                    <td>
                      <a href={listingHref("/samples", EMPTY_QUERY, { scope: ALL, area: area.key })}>{area.name}</a>
                    </td>
                    <td>{m.format.number(area.active)}</td>
                    <td>{m.format.number(area.settled)}</td>
                  </tr>
                ))}
              </DataTable>
            </section>
          ))}
        </>
      )}
    </>
  );
}
