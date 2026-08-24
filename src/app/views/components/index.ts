/**
 * The component library. Every visual treatment the app uses lives here or
 * in a stylesheet rule these components own — a screen that needs something
 * new gets a component, not an inline style.
 *
 * All of these are plain hono/jsx functions: none needs client-side
 * behavior, so none is an island. Proofed at /design/components.
 */
export { Button, LinkButton, BUTTON_VARIANTS, type ButtonVariant } from "./button.js";
export { Card } from "./card.js";
export { Chip, TONES, type Tone } from "./chip.js";
export { Callout, EmptyState } from "./feedback.js";
export { CheckboxField, Field, SelectField, TextField } from "./field.js";
export { FilterBar, Pager } from "./listing.js";
export { DataTable } from "./table.js";
export {
  TaxonName,
  isItalicRank,
  PREFIX_QUALIFIERS,
  SUFFIX_QUALIFIERS,
  type TaxonNameProps,
  type TaxonQualifier,
} from "./taxon.js";
export { Term, type GlossarySlug } from "./term.js";
export { Meta, PageHeader } from "./text.js";
