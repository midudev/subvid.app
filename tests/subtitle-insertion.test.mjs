import assert from "node:assert/strict"
import test from "node:test"
import { subtitleSlotAt } from "../src/scripts/subtitles.ts"

const track = [
  { start: 2, end: 4, text: "" },
  { start: 10, end: 14, text: "Keep every word" },
]

test("Enter reuses the row at a clicked start, even after its text was deleted", () => {
  for (const time of [2, 2.001])
    assert.deepEqual(subtitleSlotAt(track, time, 18), { kind: "existing", index: 0 })
  assert.deepEqual(subtitleSlotAt(track, 12, 18), { kind: "insert", index: 2, covering: 1, end: 14 })
})

test("gaps stop at two seconds, the next row or the end of the media", () => {
  for (const [time, index, end] of [[4, 1, 6], [9, 1, 10], [17, 2, 18]])
    assert.deepEqual(subtitleSlotAt(track, time, 18), { kind: "insert", index, covering: -1, end })
  assert.deepEqual(subtitleSlotAt([], 0, 1), { kind: "insert", index: 0, covering: -1, end: 1 })
})

test("both sides of a split must fit, including exactly 0.3 seconds", () => {
  for (const time of [9.8, 10.2, 13.8, 17.8, 18])
    assert.equal(subtitleSlotAt(track, time, 18), null)
  for (const time of [9.7, 10.3, 13.7, 17.7])
    assert.equal(subtitleSlotAt(track, time, 18)?.kind, "insert")
})

test("a dragged overlap is split on the active row and respects the next start", () => {
  const overlap = [
    { start: 0, end: 9, text: "underneath" },
    { start: 1, end: 6, text: "in front" },
    { start: 4, end: 5, text: "next" },
  ]
  assert.deepEqual(subtitleSlotAt(overlap, 2, 10), { kind: "insert", index: 2, covering: 1, end: 4 })
  assert.deepEqual(subtitleSlotAt(overlap, 7, 10), { kind: "insert", index: 3, covering: 0, end: 9 })
})
