import type { Messages } from "../messages/index.js";
import { PageHeader } from "./components/index.js";

/**
 * The process for volunteers (beeline-kgwd): what happens at each step from
 * the field to the taxonomist, and what each step needs from them. Like the
 * glossary, every word is catalog copy; a body is text with links in it, so
 * a technical term is glossed where it first appears.
 */
type Segment = string | { href: string; label: string };

function Text({ segments }: { segments: readonly Segment[] }) {
  return <>{segments.map((s) => (typeof s === "string" ? s : <a href={s.href}>{s.label}</a>))}</>;
}

export function HowItWorks({ m }: { m: Messages }) {
  const h = m.howItWorks;
  return (
    <>
      <PageHeader title={h.heading} lede={h.lede} />
      <ol class="steps">
        {h.steps.map((step) => (
          <li>
            <h2>{step.heading}</h2>
            <p>
              <Text segments={step.body} />
            </p>
          </li>
        ))}
      </ol>
      <h2>{h.whenHeading}</h2>
      <ul>
        {h.when.map((line) => (
          <li>
            <Text segments={line} />
          </li>
        ))}
      </ul>
    </>
  );
}
