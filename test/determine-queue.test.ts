import { describe, expect, it } from "vitest";
import { changedParts, leavesPage, RequestQueue } from "../src/app/islands/determine/queue.js";

/** A promise and the function that settles it, so a test decides when a request is answered. */
const held = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the requests Identify your specimens sends (beeline-rt6h)", () => {
  it("starts each request only when the one before it has been answered", async () => {
    const queue = new RequestQueue();
    const first = held<string>();
    const order: string[] = [];
    const a = queue.run(() => {
      order.push("save sent");
      return first.promise;
    });
    const b = queue.run(async () => {
      order.push("list sent");
      return "list";
    });
    await tick();
    expect(order).toEqual(["save sent"]);
    first.resolve("save");
    expect(await a).toBe("save");
    expect(await b).toBe("list");
    expect(order).toEqual(["save sent", "list sent"]);
  });

  it("is busy until everything asked for has been answered, and idle waits for work added meanwhile", async () => {
    const queue = new RequestQueue();
    expect(queue.busy).toBe(false);
    const first = held<void>();
    const second = held<void>();
    void queue.run(() => first.promise);
    let idle = false;
    void queue.idle().then(() => (idle = true));
    // A change made while the page waits to leave.
    void queue.run(() => second.promise);
    first.resolve();
    await tick();
    expect(queue.busy).toBe(true);
    expect(idle).toBe(false);
    second.resolve();
    await tick();
    expect(queue.busy).toBe(false);
    expect(idle).toBe(true);
  });

  it("gives a failure to whoever asked and still runs what was asked for after it", async () => {
    const queue = new RequestQueue();
    const failing = queue.run(async () => {
      throw new Error("503");
    });
    const after = queue.run(async () => "sent");
    await expect(failing).rejects.toThrow("503");
    expect(await after).toBe("sent");
    await queue.idle();
    expect(queue.busy).toBe(false);
  });
});

describe("the parts of a row a save sends (beeline-rt6h)", () => {
  const unnamed = { animalId: null, ecdysisTid: null, sex: null, caste: null };

  it("sends only the sex when only the sex differs from the store's last word, so the name there is left alone", () => {
    expect(changedParts(unnamed, { ...unnamed, sex: "female" })).toEqual({ sex: "female", caste: null });
    expect(changedParts(null, { ...unnamed, sex: "female" })).toEqual({ sex: "female", caste: null });
  });

  it("sends only the name when only the name differs, as the tree's id and Ecdysis's together", () => {
    const sexed = { ...unnamed, sex: "male" };
    expect(changedParts(sexed, { ...sexed, animalId: 7 })).toEqual({ animalId: 7, ecdysisTid: null });
    expect(changedParts({ ...sexed, animalId: 7 }, { ...sexed, animalId: null, ecdysisTid: 90 })).toEqual({ animalId: null, ecdysisTid: 90 });
  });

  it("sends a caste with its sex, and both parts when both differ", () => {
    const worker = { animalId: 7, ecdysisTid: null, sex: "female", caste: "worker" };
    expect(changedParts(worker, { ...worker, caste: "gyne" })).toEqual({ sex: "female", caste: "gyne" });
    expect(changedParts(worker, unnamed)).toEqual(unnamed);
  });

  it("sends nothing when the row already says it", () => {
    const worker = { animalId: 7, ecdysisTid: null, sex: "female", caste: "worker" };
    expect(changedParts(worker, { ...worker })).toEqual({});
    // A determination already made carries no Ecdysis id at all.
    expect(changedParts({ animalId: 7, sex: null, caste: null }, { animalId: 7, ecdysisTid: null, sex: null, caste: null })).toEqual({});
  });
});

describe("a click on a link on Identify your specimens (beeline-rt6h)", () => {
  const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const link = { target: "", download: false };

  it("leaves the page when it is a plain click on a plain link", () => {
    expect(leavesPage(plain, link)).toBe(true);
    expect(leavesPage(plain, { ...link, target: "_self" })).toBe(true);
  });

  it("does not when it opens another tab, downloads, or was already handled", () => {
    expect(leavesPage({ ...plain, metaKey: true }, link)).toBe(false);
    expect(leavesPage({ ...plain, ctrlKey: true }, link)).toBe(false);
    expect(leavesPage({ ...plain, shiftKey: true }, link)).toBe(false);
    expect(leavesPage({ ...plain, button: 1 }, link)).toBe(false);
    expect(leavesPage({ ...plain, defaultPrevented: true }, link)).toBe(false);
    expect(leavesPage(plain, { ...link, target: "_blank" })).toBe(false);
    expect(leavesPage(plain, { ...link, download: true })).toBe(false);
  });
});
