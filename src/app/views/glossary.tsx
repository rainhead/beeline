import type { Messages } from "../messages/index.js";
import { PageHeader } from "./components/index.js";

/**
 * The glossary. Volunteer-facing, so every word on it comes from the message
 * catalog — this is the one page whose entire content is copy.
 *
 * The key of each entry is its anchor, so `Term` can link straight to a
 * definition (/glossary#geoprivacy). A test pins the two together.
 */
export function Glossary({ m }: { m: Messages }) {
  return (
    <>
      <PageHeader title={m.glossary.heading} lede={m.glossary.intro} />
      <dl class="glossary">
        {Object.entries(m.glossary.entries).map(([slug, entry]) => (
          <>
            <dt id={slug}>{entry.term}</dt>
            <dd>{entry.definition}</dd>
          </>
        ))}
      </dl>
    </>
  );
}
