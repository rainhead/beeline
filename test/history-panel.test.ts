import { describe, expect, it } from "vitest";
import { historyForPanel } from "../src/app/views/record.js";
import type { SampleChange } from "../src/sample-change.js";

/** What a sample's History panel shows of the lines one act writes (beeline-ni5m.15): one line for the act, the log keeping all. */
const line = (at: string, field: SampleChange["field"], old_value: string, new_value: string, author = "samstaff", source: SampleChange["source"] = "app"): SampleChange => ({
  at, collector: "name:Ada", sample_number: "7", date_start: "2026-06-02", field, old_value, new_value, author, source, reason: "", store: "s", sample_id: "9",
});
const fields = (h: SampleChange[]) => historyForPanel(h).map((e) => e.field);

describe("the lines of a sample's history the panel shows", () => {
  it("shows Method alone for a method change, which also writes Method as written and the old effort column", () => {
    const act = [line("2026-11-23T20:15:00Z", "protocol", "vane trap", "pan trap"), line("2026-11-23T20:15:00Z", "sampling_effort", "6 vane traps", "6 pan traps"), line("2026-11-23T20:15:00Z", "method", "vane trap", "pan trap")];
    expect(fields(act)).toEqual(["method"]);
  });

  it("shows Number of traps alone for a count change, which also writes the old effort column", () => {
    const act = [line("2026-11-23T20:16:00Z", "sampling_effort", "6 pan traps", "8 pan traps"), line("2026-11-23T20:16:00Z", "trap_count", "6", "8")];
    expect(fields(act)).toEqual(["trap_count"]);
  });

  it("shows Method as written when the act did not change Method to the same value: a wording corrected to another wording for the same method, or to one that is not its code", () => {
    expect(fields([line("t1", "protocol", "pantrap", "pan traps")])).toEqual(["protocol"]);
    expect(fields([line("t2", "protocol", "pan", "pantrap"), line("t2", "method", "vane trap", "pan trap")])).toEqual(["protocol", "method"]);
  });

  it("keeps an effort line that no count or method change of the same act explains, and does not join acts", () => {
    expect(fields([line("t1", "sampling_effort", "", "6 vane traps")])).toEqual(["sampling_effort"]);
    // Two acts a moment apart, or by two people, are two.
    const two = [line("t1", "method", "vane trap", "pan trap"), line("t2", "sampling_effort", "6 vane traps", "6 pan traps"), line("t2", "protocol", "a", "b", "someone")];
    expect(fields(two)).toEqual(["method", "sampling_effort", "protocol"]);
    expect(fields([line("t1", "method", "a", "b", "x"), line("t1", "sampling_effort", "1", "2", "y")])).toEqual(["method", "sampling_effort"]);
  });

  it("leaves the order, and every line, as it was for the other fields", () => {
    const h = [line("t1", "locality", "a", "b"), line("t1", "method", "a", "b"), line("t1", "sampling_effort", "1", "2")];
    expect(fields(h)).toEqual(["locality", "method"]);
    expect(h).toHaveLength(3);
  });
});
