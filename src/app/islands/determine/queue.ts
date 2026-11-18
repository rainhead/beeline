/**
 * The requests Identify your specimens sends that change or reread its rows,
 * run one at a time in the order they were asked for (beeline-rt6h).
 *
 * One at a time, so the store's answer to each request already holds every
 * change asked for before it: an answer that replaces the rows on screen can
 * then never be older than a save that has already landed. And the page can
 * ask when everything has been sent, which is what leaving it must wait for.
 * Kept apart from the grid so it can be tested without a DOM.
 */
export class RequestQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;

  /** Run `work` after everything asked for before it. A failure is the caller's to handle and does not stop later work. */
  run<T>(work: () => Promise<T>): Promise<T> {
    this.#waiting++;
    const out = this.#tail.then(work);
    this.#tail = out.then(
      () => void this.#waiting--,
      () => void this.#waiting--,
    );
    return out;
  }

  /** Whether anything asked for has yet to be answered. */
  get busy(): boolean {
    return this.#waiting > 0;
  }

  /** Resolves once nothing is waiting, including work asked for while this waited. */
  async idle(): Promise<void> {
    let tail: Promise<unknown>;
    do {
      tail = this.#tail;
      await tail;
    } while (tail !== this.#tail);
  }
}

/** What a row says: the screen's copy of it, or what a change would make it. */
export interface RowValue {
  animalId: number | null;
  ecdysisTid?: number | null;
  sex: string | null;
  caste: string | null;
}

/**
 * The parts of a row to send: the name, the sex, both or neither, whichever
 * differ from the copy of the row the store last gave this page. The store
 * keeps the parts not sent as it has them (saveDrafts, src/app/determine.ts).
 *
 * Until beeline-rt6h a save sent the whole row as the screen showed it and
 * the store replaced the draft with that. A screen with an old copy of the
 * row (a second tab, a page the browser brought back) showed it without the
 * name given elsewhere, and a sex chosen there erased the name.
 *
 * A name is the tree's id or Ecdysis's, never both, and a caste belongs to a
 * sex, so each pair goes together.
 */
export function changedParts<V extends RowValue>(base: RowValue | null, value: V): Partial<Pick<V, "animalId" | "ecdysisTid" | "sex" | "caste">> {
  const out: Partial<RowValue> = {};
  if ((base?.animalId ?? null) !== value.animalId || (base?.ecdysisTid ?? null) !== (value.ecdysisTid ?? null)) {
    out.animalId = value.animalId;
    out.ecdysisTid = value.ecdysisTid ?? null;
  }
  if ((base?.sex ?? null) !== value.sex || (base?.caste ?? null) !== value.caste) {
    out.sex = value.sex;
    out.caste = value.caste;
  }
  return out as Partial<Pick<V, "animalId" | "ecdysisTid" | "sex" | "caste">>;
}

/** The parts of a click that say whether it will take this tab to another page. */
export interface LinkClick {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Whether a click on a link will load another page in this tab, and so end
 * this one. A click with a modifier key or another button opens a tab or
 * downloads; a link with a target or `download` leaves this page standing.
 */
export function leavesPage(e: LinkClick, link: { target: string; download: boolean }): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return !link.download && (link.target === "" || link.target === "_self");
}
