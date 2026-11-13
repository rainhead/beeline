// A stand-in for src/query-copy-worker.ts that answers with the names of the
// environment variables it was started with, so a test can see what a child gets.
process.once("message", () => {
  process.send({ ok: true, columns: [{ name: "env", type: "VARCHAR" }], rows: [Object.keys(process.env)], truncatedBy: null, copiedAt: "2026-01-01T00:00:00.000Z" }, () => process.exit(0));
});
