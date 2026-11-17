import type { Messages } from "../messages/index.js";
import type { AreaGroup } from "../areas.js";
import { ALL, EMPTY_QUERY, listingHref } from "../listings.js";
import { DataTable, EmptyState, PageHeader } from "./components/index.js";

/**
 * The areas, by kind (beeline-9jd4): each kind a section, each area a row
 * with the samples inside it from the active seasons and from settled ones.
 * Staff only (src/app/areas.ts says why), so an area's name links to the
 * Samples listing filtered to exactly that area, across every program.
 */
export function AreaIndex({ m, groups }: { m: Messages; groups: AreaGroup[] }) {
  const a = m.areas;
  return (
    <>
      <PageHeader title={a.title} lede={a.intro} />
      {groups.length === 0 ? (
        <EmptyState>{a.none}</EmptyState>
      ) : (
        <>
          <nav class="jump-links" aria-label={a.kindsLabel}>
            {groups.map((group) => (
              <a href={`#${group.kind}`}>{a.kindCount(a.kind[group.kind], group.areas.length)}</a>
            ))}
          </nav>
          {groups.map((group) => (
            <section>
              <h2 id={group.kind}>{a.kind[group.kind]}</h2>
              {a.kindNote[group.kind] !== undefined && <p>{a.kindNote[group.kind]}</p>}
              <DataTable columns={[a.colArea, a.colActive, a.colSettled]}>
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
