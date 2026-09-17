import type { Messages } from "../../messages/index.js";
import {
  Absent,
  BUTTON_VARIANTS,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  DetailList,
  EmptyState,
  FilterBar,
  LinkButton,
  Pager,
  CheckboxField,
  SelectField,
  Meta,
  TONES,
  TaxonName,
  Term,
  TextField,
} from "../components/index.js";
import { DesignPage, DoDont, Specimen } from "./shell.js";

export function DesignComponents({ m }: { m: Messages }) {
  return (
    <DesignPage
      current="/design/components"
      title="Components"
      lede="Every treatment the product uses, in every state it can be in. If a screen needs something that is not here, it gets added here first."
    >
      <h2>What is and isn't a component</h2>
      <p>
        Everything on this page is a plain server-rendered function — none of them needs client-side behaviour, so none
        of them is an island. An island is for behaviour a page genuinely cannot have without scripting, and the
        product currently has exactly one: dismissal for the header dropdowns, which work without it. Reach for a
        component first, semantic HTML second, and an island only when neither will do.
      </p>

      <h2>Page header</h2>
      <p>
        Every page opens the same way — title, an optional sentence saying what the screen is for, optional meta
        beneath. The title is the only <code>h1</code> on the page.
      </p>

      <h2>Meta</h2>
      <p>
        Secondary text that qualifies its neighbour: a place and specimen count under a sample title, a job's
        description under its name. This was the most-repeated treatment in the application before it had a name — the
        same two declarations retyped inline in five places.
      </p>
      <Specimen>
        <h3 class="row baseline">
          Sample 4 · Jul 15, 2026 <Meta>Alsea Falls, BentonCo, OR · 12 specimens</Meta>
        </h3>
        <Meta block>Data last synced from iNaturalist Aug 21, 2026, 2:50 AM.</Meta>
      </Specimen>

      <h2>Absence</h2>
      <p>
        A value that is not there is drawn by <code>Absent</code>, never left to the screen. The app used to do it three
        ways — words in one place, a bare em dash in another, an empty cell in a third — and the empty cell is the
        worst, because nobody can tell “there is none” from “it failed to load”.
      </p>
      <ul>
        <li>
          <strong>Never blank.</strong> Every absence is drawn.
        </li>
        <li>
          <strong>Every absence means something.</strong> The <code>label</code> is that meaning, in the catalog’s
          words, and a screen reader always hears it.
        </li>
        <li>
          <strong>Spelled out where it is the exception, or tells the reader something</strong>: “not determined”,
          “obscured”, “No account”, “outside”. A record page has the room, so it always spells.
        </li>
        <li>
          <strong>An em dash where the same absence repeats down a dense column</strong> and the words would be
          noise: a job that breached nothing, a person with no membership recorded.
        </li>
        <li>
          <strong>Secondary text either way</strong>, so an absence never reads as a value. A count of 0 is a number,
          not an absence.
        </li>
      </ul>
      <Specimen>
        <DataTable columns={["Specimen", "Determination", "Determined by", "Host plant", "Atlas"]}>
          <tr>
            <td>26100121</td>
            <td>
              <TaxonName rank="species" scientificName="Bombus vosnesenskii" />
            </td>
            <td>F. Fisher</td>
            <td>
              <TaxonName rank="genus" scientificName="Phacelia" />
            </td>
            <td>OBA</td>
          </tr>
          <tr>
            <td>26100122</td>
            <td>
              <Absent label="not determined" spelled />
            </td>
            <td>
              <Absent label="none" />
            </td>
            <td>
              <Absent label="none" />
            </td>
            <td>
              <Absent label="outside" spelled />
            </td>
          </tr>
        </DataTable>
      </Specimen>
      <DoDont
        dos={[
          <>
            <Absent label="never" /> for someone who has never signed in: a dash the eye skips, and “never” for a
            screen reader.
          </>,
          <>
            <Absent label="not determined" spelled /> on a specimen still waiting for a name, because that one tells
            the reader something.
          </>,
        ]}
        donts={[
          <>An empty cell. Nobody can tell it from a value that failed to load.</>,
          <>A bare “—” typed into a view. It says nothing about what is missing, and a screen reader says “dash”.</>,
        ]}
      />

      <h2>Chips</h2>
      <p>Status in one word. Tone names the meaning, not the colour.</p>
      <Specimen>
        <p class="row">
          {TONES.map((tone) => (
            <Chip tone={tone}>{tone}</Chip>
          ))}
        </p>
        <p class="row">
          <Chip tone="blocking">blocks printing</Chip>
          <Chip tone="warning">heads-up</Chip>
          <Chip tone="success">succeeded</Chip>
          <Chip>running…</Chip>
        </p>
      </Specimen>

      <h2>Buttons</h2>
      <p>
        Variant is about weight on the page, not about what the action does. A screen has at most one filled button.
        Navigations stay real links so they can be middle-clicked and copied.
      </p>
      <Specimen>
        <p class="row">
          {BUTTON_VARIANTS.map((variant) => (
            <Button variant={variant} type="button">
              {variant}
            </Button>
          ))}
        </p>
        <p class="row">
          {BUTTON_VARIANTS.map((variant) => (
            <LinkButton variant={variant} href="/design/components">
              link · {variant}
            </LinkButton>
          ))}
        </p>
      </Specimen>

      <h2>Cards</h2>
      <p>Cards frame anything that is not a table row. Consecutive cards space themselves.</p>
      <Specimen>
        <Card>
          <h3>Sample 4 — Alsea Falls</h3>
          <p>Outlined, never elevated.</p>
        </Card>
        <Card>
          <h3>Sample 7 — Corvallis</h3>
          <p>The second card sets its own top margin, so no caller ever passes one.</p>
        </Card>
      </Specimen>

      <h2>Detail lists</h2>
      <p>
        The facts about one thing, labelled. A listing puts a heading above many values; a record page puts a label
        beside one, and that is a different treatment rather than a one-column table. Real <code>&lt;dl&gt;</code>
        markup, so the label is announced with its value, and two columns that stack on a narrow screen. A null entry
        is dropped, so the caller decides row by row whether an absence is worth saying — "Elevation — not yet worked
        out" is a gap made visible, while a floral-host row on a sample taken off no flower would invent one.
      </p>
      <Specimen>
        <DetailList
          items={[
            { term: "Collected by", value: "Gretchen Pederson and Robert Pederson" },
            { term: "Collected", value: "Jul 12 – Jul 19, 2026" },
            { term: "Method", value: "Trap" },
            { term: "Coordinates", value: <span class="mono">44.5646, -123.262</span> },
            { term: "Elevation", value: <Meta>Not worked out yet.</Meta> },
            null,
          ]}
        />
      </Specimen>

      <h2>Callouts</h2>
      <p>An aside: why this screen behaves as it does, when the data was last refreshed. Never an interruption.</p>
      <Specimen>
        {TONES.map((tone) => (
          <Callout tone={tone}>
            <Meta block>A {tone} callout — the left rule carries the tone.</Meta>
          </Callout>
        ))}
      </Specimen>

      <h2>Empty states</h2>
      <p>
        Says what would be here and why it is not. "All clear" is a result, so it reads like one rather than like a
        failure to load.
      </p>
      <Specimen>
        <EmptyState heading="All clear">
          Nothing needs your attention — every one of your samples is clean. Thank you!
        </EmptyState>
      </Specimen>

      <h2>Fields</h2>
      <p>
        A real <code>&lt;label for&gt;</code> every time. Placeholder-as-label is not a pattern here: it disappears
        exactly when someone needs it.
      </p>
      <Specimen>
        <div class="form-column">
          <TextField id="demo-locality" name="locality" label="Locality" value="Corvallis" />
          <TextField
            id="demo-note"
            name="note"
            label="Note (optional)"
            placeholder="Why the change, if it isn't obvious"
            hint="Hints sit under the control, not inside it."
          />
          <CheckboxField
            id="demo-settled"
            name="settled"
            label="Include settled seasons"
            hint="A checkbox takes its label after the control: it reads as a sentence, not as a slot."
          />
        </div>
      </Specimen>

      <h2>Filters and paging</h2>
      <p>
        A listing's furniture. The filter bar is a plain GET form, so applying filters writes them into the query
        string and the result is a URL a staff member can send someone — which is the point of a staff view at all.
        The pager deliberately has no page numbers: with tens of thousands of rows, "page 27" means nothing, while
        "of 1,340" tells you to go back and filter.
      </p>
      <Specimen>
        <FilterBar
          action="/design/components"
          actions={
            <>
              <Button>Apply</Button>
              <a href="/design/components">Clear</a>
            </>
          }
        >
          <SelectField
            id="demo-scope"
            name="scope"
            label="Show"
            value="OBA"
            options={[
              ["mine", "My records"],
              ["OBA", "Oregon Bee Atlas"],
              ["all", "All atlases"],
            ]}
          />
          <TextField id="demo-search" name="q" label="Search" value="" hint="Sample number, collector, or field number" />
          <SelectField
            id="demo-qc"
            name="qc"
            label="Flags"
            value="any"
            options={[
              ["any", "Any"],
              ["blocking", "Blocks printing"],
              ["clean", "Clean"],
            ]}
          />
        </FilterBar>
        <Pager
          summary="Page 3 of 1,340"
          previousHref="/design/components"
          nextHref="/design/components"
          previousLabel="← Previous"
          nextLabel="Next →"
        />
      </Specimen>

      <h2>Breadcrumbs</h2>
      <p>
        Where a page sits in a hierarchy — today, where a name is filed in the taxonomy. The trail is the ancestors
        only, because the page title already says where you are; the separators are drawn by the stylesheet, so a
        screen reader reads the path rather than the punctuation.
      </p>
      <Specimen>
        <Breadcrumbs
          label="Filed under"
          trail={[
            { href: "/taxonomy", label: "Taxonomy" },
            { href: "/taxonomy/class/Insecta", label: <TaxonName rank="class" scientificName="Insecta" /> },
            { href: "/taxonomy/family/Halictidae", label: <TaxonName rank="family" scientificName="Halictidae" /> },
            { href: "/taxonomy/genus/Lasioglossum", label: <TaxonName rank="genus" scientificName="Lasioglossum" /> },
          ]}
        />
      </Specimen>

      <h2>Tables</h2>
      <p>
        Every table goes through <code>DataTable</code>, so scrolling inside the wrapper — rather than making the page
        scroll sideways on a phone — is not something a screen can forget.
      </p>
      <Specimen>
        <DataTable columns={["Sample", "Date", "Locality", "Specimens", "Findings"]}>
          <tr>
            <td>3</td>
            <td>Jul 14, 2026</td>
            <td>Corvallis</td>
            <td>3</td>
            <td>—</td>
          </tr>
          <tr>
            <td>4</td>
            <td>Jul 15, 2026</td>
            <td>Alsea Falls</td>
            <td>12</td>
            <td>
              <Chip tone="blocking">missing host</Chip>
            </td>
          </tr>
        </DataTable>
      </Specimen>

      <h3>Columns that sort and filter</h3>
      <p>
        A listing describes its columns and the table draws them: a column with a <code>menu</code> gets a heading
        that opens one, holding that column's two orders and its own filter. Every such heading wears the same
        chevron, at a size that reads; the order in force is a separate arrow beside the label, and the heading cell
        carries <code>aria-sort</code>. The filter's Apply is a real button — it submits a form, where everything
        else in a menu is a row. A heading that is read aloud and never drawn, for a column of links out, is{" "}
        <code>hidden</code>.
      </p>
      <Specimen>
        <DataTable
          columns={[
            {
              label: "Sample",
              menu: {
                menuLabel: "Sample: sort",
                sort: { current: null, ascHref: "#", descHref: "#", ascLabel: "Lowest first", descLabel: "Highest first" },
              },
            },
            {
              label: "Date",
              menu: {
                menuLabel: "Date: sort and filter",
                sort: { current: "desc", ascHref: "#", descHref: "#", ascLabel: "Oldest first", descLabel: "Newest first" },
                filter: {
                  action: "#",
                  params: new URLSearchParams(),
                  fields: ["from"],
                  applyLabel: "Apply",
                  controls: <TextField id="proof-from" name="from" label="Collected from" value="" />,
                },
              },
            },
            {
              label: "Admin",
              menu: {
                menuLabel: "Admin: filter",
                filter: {
                  action: "#",
                  params: new URLSearchParams(),
                  fields: ["admin"],
                  applyLabel: "Apply",
                  controls: <CheckboxField id="proof-admin" name="admin" label="Only admins" checked={false} />,
                },
              },
            },
            "Locality",
            { label: "Links", hidden: true },
          ]}
        >
          <tr>
            <td>3</td>
            <td>Jul 14, 2026</td>
            <td>—</td>
            <td>Corvallis</td>
            <td>
              <a href="#">Edit</a>
            </td>
          </tr>
        </DataTable>
      </Specimen>

      <h2>Taxon names</h2>
      <p>
        Set by construction from rank and ancestry. The rules and the full worked set are at{" "}
        <a href="/design/names">Names</a>.
      </p>
      <Specimen>
        <p>
          <TaxonName rank="species" scientificName="Bombus insularis" subgenus="Psithyrus" />
          {" · "}
          <TaxonName rank="genus" scientificName="Andrena" qualifier="sp." />
          {" · "}
          <TaxonName rank="family" scientificName="Halictidae" />
        </p>
      </Specimen>

      <h2>Terms</h2>
      <p>
        Links a technical word to its definition, so copy can gloss on first use by linking rather than by
        re-explaining.
      </p>
      <Specimen>
        <p>
          Your <Term m={m} slug="sample" /> has a flag because its{" "}
          <Term m={m} slug="floral-host">
            floral host
          </Term>{" "}
          is not a vascular plant, and the <Term m={m} slug="obscured-coordinates">coordinates are obscured</Term>.
        </p>
      </Specimen>

      <h2>Islands</h2>
      <p>
        A Lit component hydrated client-side, rendered in light DOM so this same stylesheet reaches in. If the counter
        counts, the Vite island build and the hydration chain both work.
      </p>
      <Specimen>
        <demo-counter></demo-counter>
      </Specimen>

      <DoDont
        dos={[
          "Add a component when a treatment appears twice.",
          "Proof a new component here, in every state, before a screen uses it.",
          "Keep components pure functions of their props, so every state is reachable without data gymnastics.",
          "Let the CSS own the spacing between siblings rather than passing margins in.",
        ]}
        donts={[
          <>
            Don't write an inline <code>style</code> in a product view. If you need one, you need a component.
          </>,
          "Don't build an island for something that renders fine on the server.",
          "Don't pass a class name into a component to vary it — add a named variant instead.",
        ]}
      />
    </DesignPage>
  );
}
