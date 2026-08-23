import { DesignPage, DoDont, Reference, Specimen } from "./shell.js";

const SPACE_STEPS = ["1", "1-5", "2", "2-5", "3", "4", "5", "6", "8", "12"] as const;

export function DesignSpace() {
  return (
    <DesignPage
      current="/design/space"
      title="Space &amp; form"
      lede="A 0.25rem base, three radii, and almost no shadow. Surfaces are outlined rather than lifted."
    >
      <h2>Devices</h2>
      <p>
        Most use will be a laptop browser — this is a tool people sit down to, usually with a season's records in front
        of them. But it has to work on a phone, and the dashboard especially: a volunteer checking what needs fixing is
        often doing it away from a desk, and the fix itself happens on iNaturalist, which most people reach on their
        phone. A dashboard that is unusable on mobile pushes the whole loop back to "later", and later is where
        findings go to die.
      </p>
      <p>
        So: the layout is single-column and fluid from the start rather than a desktop grid that collapses. The header
        nav folds into a hamburger below 640px. Tables scroll inside their own wrapper instead of making the page
        scroll sideways, with a min-width that keeps columns readable rather than crushed. Interactive chrome carries a{" "}
        <code>--touch-target</code> minimum of 2.75rem, which is a thumb, not a cursor. The staff surfaces — jobs, this
        design system — are allowed to assume a wide screen; the volunteer surfaces are not.
      </p>

      <h2>Space</h2>
      <p>
        A 0.25rem base, which is finer than the 8px grid a marketing site would use. That is deliberate: this is a
        dense data tool, and table cells, chip padding, and the gap between a title and its annotation all need the
        half-steps. The scale is small enough to hold in your head and every value in the product comes from it.
      </p>
      <Specimen>
        {SPACE_STEPS.map((s) => (
          <div class="row">
            <code style="min-width: 8rem">--space-{s}</code>
            <div class="space-bar" style={`width: calc(var(--space-${s}) * 8)`}></div>
            <span class="meta">var(--space-{s})</span>
          </div>
        ))}
      </Specimen>

      <h2>Shape</h2>
      <Reference
        rows={[
          ["--radius-sm", "Inputs, code spans, callouts — anything that reads as a field or an aside."],
          ["--radius-md", "Cards, chips, menu panels. The default."],
          ["--radius-full", "Buttons only. A pill is how you tell an action from a container."],
        ]}
      />

      <h2>Depth</h2>
      <p>
        Cards are outlined with a hairline in <code>outline-variant</code> and carry no shadow. The only real shadow in
        the product is on the header dropdown panels, which genuinely float above content they cover; everything else
        earns separation from an outline, a left rule, or the order of the page. If something is not standing out
        enough, the answer is hierarchy, not elevation.
      </p>

      <h2>Layers</h2>
      <p>
        The application barely stacks. Two values exist, both named, and a third should be added here rather than
        written inline the moment it is needed.
      </p>
      <Reference
        rows={[
          ["--layer-raised", "Anything that must sit above its siblings within a normal flow."],
          ["--layer-menu", "The header dropdowns. Chrome always wins over content."],
        ]}
      />

      <h2>Density</h2>
      <p>
        One density. Tables here run three-by-four spacing per cell, which is roomier than a spreadsheet and tighter
        than a marketing table — legible on a phone, scannable on a laptop. A compact mode is the kind of thing that
        sounds free and then doubles every table's states, so it waits until a screen genuinely cannot work without it.
      </p>

      <DoDont
        dos={[
          <>
            Use a step from the scale — <code>var(--space-4)</code>, not <code>1rem</code>.
          </>,
          "Check a new screen at phone width before calling it done, and check the dashboard first.",
          "Give a new stacking context a named layer token.",
          "Let tables scroll inside their wrapper rather than widening the page.",
        ]}
        donts={[
          "Don't add a shadow to make something prominent.",
          "Don't invent a radius. Three is the whole vocabulary.",
          <>
            Don't write a bare <code>z-index</code>.
          </>,
          "Don't assume a hover state is available — the dashboard is used on phones.",
        ]}
      />
    </DesignPage>
  );
}
