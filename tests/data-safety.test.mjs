import assert from "node:assert/strict";
import test from "node:test";
import { collectCompletePages, currentIstMonthRange, escapeCsvCell, requireSingleRpcRow, usablePhoneSearch } from "../src/lib/data-safety.ts";

test("table RPCs require exactly one valid numeric row", () => {
  assert.deepEqual(requireSingleRpcRow([{ value: "12.50" }], "summary", ["value"]), { value: 12.5 });
  assert.throws(() => requireSingleRpcRow({ value: 0 }, "summary", ["value"]), /unexpected response/);
  assert.throws(() => requireSingleRpcRow([], "summary", ["value"]), /unexpected response/);
  assert.throws(() => requireSingleRpcRow([{ value: "not money" }], "summary", ["value"]), /unexpected response/);
});

test("phone search only activates for usable digits", () => {
  assert.equal(usablePhoneSearch("Alice Smith"), null);
  assert.equal(usablePhoneSearch("+91 (987) 65"), "9198765");
  assert.equal(usablePhoneSearch("--12--"), null);
});

test("IST month boundaries remain correct at UTC year rollover", () => {
  assert.deepEqual(currentIstMonthRange(new Date("2025-12-31T20:00:00Z")), { from: "2026-01-01", toExclusive: "2026-02-01" });
  assert.deepEqual(currentIstMonthRange(new Date("2026-01-31T18:29:59Z")), { from: "2026-01-01", toExclusive: "2026-02-01" });
  assert.deepEqual(currentIstMonthRange(new Date("2026-01-31T18:30:00Z")), { from: "2026-02-01", toExclusive: "2026-03-01" });
});

test("CSV quoting preserves text and blocks spreadsheet formulas", () => {
  assert.equal(escapeCsvCell('a,"b"\nline'), '"a,""b""\nline"');
  assert.equal(escapeCsvCell("=HYPERLINK(\"bad\")"), '"\'=HYPERLINK(""bad"")"');
  assert.equal(escapeCsvCell("+919876543210"), '"\'+919876543210"');
});

test("complete export retrieves more than two pages without gaps", async () => {
  const source = Array.from({ length: 1201 }, (_, id) => ({ id: String(id) }));
  const calls = [];
  const result = await collectCompletePages(500, async (offset, withCount) => {
    calls.push([offset, withCount]);
    return { rows: source.slice(offset, offset + 500), total: withCount ? source.length : 0 };
  }, (row) => row.id);
  assert.equal(result.rows.length, 1201);
  assert.deepEqual(calls, [[0, true], [500, false], [1000, false]]);
});

test("complete export rejects duplicate or partial results", async () => {
  await assert.rejects(() => collectCompletePages(2, async (offset) => ({ rows: offset ? [{ id: "2" }] : [{ id: "1" }, { id: "1" }], total: 3 }), (row) => row.id), /duplicate/);
  await assert.rejects(() => collectCompletePages(2, async () => ({ rows: [{ id: "1" }], total: 2 }), (row) => row.id), /1 of 2/);
});
