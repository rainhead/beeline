import type { Child } from "hono/jsx";
import { Meta } from "./text.js";

/**
 * A sequence of things a person does in order (beeline-q8di): How Beeline
 * works, and the steps for uploading to Ecdysis. A real `<ol>`, so the
 * numbers come from the list and a screen reader announces "1 of 7"; nothing
 * numbers a step in its own text. The look, with room between steps, is
 * `.steps` in components.css, in the spacing scale (/design/space).
 *
 * `note` is for what is good to know about the whole sequence, and sits under
 * the list, not in a step: a step says one thing to do.
 */
export function Steps({ children, note }: { children: Child; note?: Child }) {
  return (
    <>
      <ol class="steps">{children}</ol>
      {note !== undefined && (
        <p>
          <Meta>{note}</Meta>
        </p>
      )}
    </>
  );
}

/**
 * One step. `children` is the instruction, set as a paragraph. A step may
 * have a `title`, a short heading above it, where each step is a stage with
 * something to read (How Beeline works); the heading is an `h2`, a section
 * of the page. `below` is what the person uses to do the step, a button or a
 * form, and what that control says back, set under the instruction it
 * belongs to.
 */
export function Step({ title, children, below }: { title?: Child; children: Child; below?: Child }) {
  return (
    <li>
      {title !== undefined && <h2>{title}</h2>}
      <p>{children}</p>
      {below !== undefined && <div class="step-below">{below}</div>}
    </li>
  );
}
