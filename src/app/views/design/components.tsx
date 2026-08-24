import type { Messages } from "../../messages/index.js";
import {
  BUTTON_VARIANTS,
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  FilterBar,
  LinkButton,
  Pager,
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
