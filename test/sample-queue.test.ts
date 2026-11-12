import { describe, expect, it } from "vitest";
import { onSample } from "../src/app/sample-queue.js";

/** One save at a time for a sample (beeline-p8y1), whatever the other samples are doing. */
describe("the per-sample queue", () => {
  it("starts a second save of a sample only when the first has finished, even if it failed", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = onSample(1, async () => {
      order.push("first starts");
      await gate;
      order.push("first ends");
      throw new Error("the first save failed");
    });
    const second = onSample(1, async () => {
      order.push("second starts");
      return "second";
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first starts"]);
    release();
    await expect(first).rejects.toThrow("the first save failed");
    expect(await second).toBe("second");
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
  });

  it("does not hold one sample's save behind another's", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = onSample(2, () => gate);
    expect(await onSample(3, async () => "other sample")).toBe("other sample");
    release();
    await slow;
  });
});
