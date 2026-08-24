import type { GlossaryEntry } from "../messages/en.js";
import type { Messages } from "../messages/index.js";
import { PageHeader, TaxonName } from "./components/index.js";

/**
 * The glossary. Volunteer-facing, so every word on it comes from the message
 * catalog — this is the one page whose entire content is copy.
 *
 * The key of each entry is its anchor, so `Term` can link straight to a
 * definition (/glossary#geoprivacy). A test pins the two together, and
 * another keeps the entries alphabetical.
 *
 * Nomenclature entries carry a worked example as data, not as text: the page
 * renders it through TaxonName, which derives italics, brackets, and
 * qualifier placement from the rank. An entry that says "genus names are
 * italic" beside a roman Bombus teaches the opposite of what it says
 * (beeline-0i2.6).
 */
export function Glossary({ m }: { m: Messages }) {
  return (
    <>
      <PageHeader title={m.glossary.heading} lede={m.glossary.intro} />
      <dl class="glossary">
        {/* The cast is the one place the catalog's per-entry literal types are
            traded for the shape they all satisfy — `in` narrowing over that
            union leaves the optional example's fields unknown. */}
        {(Object.entries(m.glossary.entries) as Array<[string, GlossaryEntry]>).map(([slug, entry]) => {
          const example = entry.example;
          return (
            <>
              <dt id={slug}>{entry.term}</dt>
              <dd>
                {entry.definition}
                {example !== undefined && (
                  <p class="glossary-example">
                    <TaxonName
                      rank={example.rank}
                      scientificName={example.scientificName}
                      subgenus={example.subgenus}
                      qualifier={example.qualifier}
                      authorship={example.authorship}
                    />
                  </p>
                )}
              </dd>
            </>
          );
        })}
      </dl>
    </>
  );
}
