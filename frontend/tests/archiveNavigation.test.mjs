import test from "node:test";
import assert from "node:assert/strict";
import {
  groupArchives,
  archivePosition,
  moveArchive,
  moveAllArchives,
} from "../src/archiveNavigation.ts";
const record = (id, date) => ({
  id,
  name: id,
  created_at: date,
  status: "ready",
  notes: "",
  summary: null,
});
const records = [
  record("a", "2026-10-24T01:00:00"),
  record("b", "2026-10-24T02:00:00"),
  record("c", "2026-10-23T01:00:00"),
];
test("groups real records by descending date, preserving source order within date", () => {
  const groups = groupArchives([records[2], records[0], records[1]]);
  assert.deepEqual(
    groups.map((g) => [g.date, g.records.map((r) => r.id)]),
    [
      ["2026-10-24", ["a", "b"]],
      ["2026-10-23", ["c"]],
    ],
  );
  assert.deepEqual(archivePosition(groups, "b"), { column: 0, row: 1 });
});
test("record stepping wraps in both directions", () => {
  const g = groupArchives(records);
  assert.equal(moveArchive(g, "a", "row", -1), "b");
  assert.equal(moveArchive(g, "b", "row", 1), "a");
});
test("date stepping clamps a row when switching to a shorter column", () => {
  const g = groupArchives(records);
  assert.equal(moveArchive(g, "b", "column", 1), "c");
  assert.equal(moveArchive(g, "c", "column", 1), "a");
  assert.equal(moveArchive(g, "a", "column", -1), "c");
});
test("empty archives have no navigation target", () => {
  assert.deepEqual(groupArchives([]), []);
  assert.equal(moveArchive([], "", "row", 1), null);
  assert.deepEqual(archivePosition([], ""), { column: 0, row: 0 });
});

test("all-archive navigation crosses columns and wraps at both ends", () => {
  const groups = groupArchives(records);
  assert.equal(moveAllArchives(groups, "b", 1), "c");
  assert.equal(moveAllArchives(groups, "c", -1), "b");
  assert.equal(moveAllArchives(groups, "c", 1), "a");
  assert.equal(moveAllArchives(groups, "a", -1), "c");
  assert.equal(moveAllArchives([], "", 1), null);
  assert.equal(moveAllArchives(groupArchives([records[0]]), "a", 1), "a");
  assert.equal(moveAllArchives(groups, "missing", 1), "a");
});
