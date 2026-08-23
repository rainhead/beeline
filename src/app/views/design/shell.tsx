import type { Child } from "hono/jsx";
import { PageHeader } from "../components/index.js";

/**
 * Shared furniture for the design system.
 *
 * /design is staff tooling, admin-gated, and English-only by policy — so
 * unlike every volunteer-facing screen, these views carry literal prose
 * rather than reading from the message catalog. The catalog is for what
 * volunteers read; a test would otherwise be proofing a document nobody
 * translates.
 */

/** Every section, in reading order. The nav and the route table share it. */
export const DESIGN_SECTIONS = [
  { path: "/design", label: "Overview" },
  { path: "/design/color", label: "Color" },
  { path: "/design/type", label: "Typography" },
  { path: "/design/names", label: "Scientific names" },
  { path: "/design/identity", label: "Identity" },
  { path: "/design/icons", label: "Iconography" },
  { path: "/design/space", label: "Space & form" },
  { path: "/design/components", label: "Components" },
  { path: "/design/voice", label: "Voice" },
  { path: "/design/imagery", label: "Imagery" },
  { path: "/design/messages", label: "Message catalog" },
  { path: "/design/qc", label: "QC states" },
] as const;

export type DesignPath = (typeof DESIGN_SECTIONS)[number]["path"];

/** The extra stylesheet the design pages ask Layout for. */
export const DESIGN_STYLESHEETS = ["/static/design.css"] as const;

function SectionNav({ current }: { current: DesignPath }) {
  return (
    <nav class="section-nav">
      {DESIGN_SECTIONS.map((s) => (
        <a href={s.path} aria-current={s.path === current ? "page" : undefined}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}

export function DesignPage({
  current,
  title,
  lede,
  children,
}: {
  current: DesignPath;
  title: string;
  lede?: Child;
  children: Child;
}) {
  return (
    <>
      <SectionNav current={current} />
      <PageHeader title={title} lede={lede} />
      {children}
    </>
  );
}

/** A framed exhibit: the thing being proofed, not part of the page around it. */
export function Specimen({ children }: { children: Child }) {
  return <div class="specimen">{children}</div>;
}

/** What this section does not answer yet. Sections say so rather than implying completeness. */
export function OpenQuestion({ children, bead }: { children: Child; bead?: string }) {
  return (
    <div class="open-question">
      <h4>Open question{bead === undefined ? "" : ` · ${bead}`}</h4>
      {children}
    </div>
  );
}

/** The two-column rule list every section closes with. */
export function DoDont({ dos, donts }: { dos: readonly Child[]; donts: readonly Child[] }) {
  return (
    <div class="rules">
      <div class="do">
        <h3>Do</h3>
        <ul>
          {dos.map((d) => (
            <li>{d}</li>
          ))}
        </ul>
      </div>
      <div class="dont">
        <h3>Don't</h3>
        <ul>
          {donts.map((d) => (
            <li>{d}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A token-and-its-purpose list. */
export function Reference({ rows }: { rows: ReadonlyArray<readonly [Child, Child]> }) {
  return (
    <dl class="reference">
      {rows.map(([name, use]) => (
        <>
          <dt>{name}</dt>
          <dd>{use}</dd>
        </>
      ))}
    </dl>
  );
}
