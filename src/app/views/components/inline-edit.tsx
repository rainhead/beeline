import type { Child } from "hono/jsx";
import { PencilIcon } from "../icons.js";

/**
 * A value changed where it is shown (beeline-7ywr, beeline-8w8n): a pencil
 * beside the value that opens, in its place, a small form with Save and
 * Cancel. A <details>, so it opens without scripting. The value goes in an
 * `inline-edit-text` element just before it, in the same table cell or
 * definition, and gives way to the form while it is open (components.css).
 *
 * Cancel is a link back to `back`, which closes the editor without
 * scripting and is intercepted to close it in place (islands/menus.ts).
 * `after` is drawn inside the editor under the form: a second form, such as
 * one that takes away what staff set, since forms cannot nest.
 */
export function InlineEdit({
  label,
  action,
  back,
  save,
  cancel,
  children,
  after,
}: {
  /** What the pencil does, for a screen reader and as its hover text: it has no visible words. */
  label: string;
  action: string;
  back: string;
  save: string;
  cancel: string;
  children: Child;
  after?: Child;
}) {
  return (
    <details class="inline-edit">
      <summary class="icon-button" aria-label={label} title={label}>
        <PencilIcon />
      </summary>
      <form method="post" action={action} class="inline-edit-form">
        <input type="hidden" name="back" value={back} />
        {children}
        <div class="row">
          <button type="submit" class="outlined compact-button">
            {save}
          </button>
          <a href={back} data-close-details="">
            {cancel}
          </a>
        </div>
      </form>
      {after}
    </details>
  );
}
