import assert from "node:assert/strict"
import test from "node:test"
import { cutRangesFromSegments } from "../src/scripts/cuts.ts"
import { estimatedWordsForSegment, wordsForDraggedBlock } from "../src/scripts/subtitles.ts"

test("dragging after deleting repeated words starts the highlight at the drop time", () => {
  const text = "recompensar en público porque no la"
  const line = {
    start: 40, end: 42.5, text,
    words: [
      { text: "", start: 40, end: 41 },
      { text: "", start: 41, end: 41.9 },
      ...text.split(" ").map((text, i) => ({
        text, start: (419 + i) / 10, end: (420 + i) / 10,
      })),
    ],
  }
  const moved = { ...line, start: 28.5, end: 31, words: wordsForDraggedBlock(line, 28.5, 31) }
  const display = estimatedWordsForSegment(moved)
  assert.equal(display[0].start, 28.5)
  assert.deepEqual(display.filter(w => w.start <= 30.25).map(w => w.text),
    ["recompensar", "en", "público", "porque", "no"])
  assert.equal(display.at(-1).end, 31)
  for (const [i, word] of moved.words.entries()) {
    assert.deepEqual(word.media, { start: line.words[i].start, end: line.words[i].end })
  }
  const again = wordsForDraggedBlock(moved, 20, 22.5)
  assert.equal(again[2].start, 20)
  assert.deepEqual(again.at(-1).media, { start: 42.4, end: 42.5 })
})

test("a manual move removes outer pauses and scales internal pauses without moving media cuts", () => {
  const line = { start: 40, end: 46, text: "a b", words: [
    { text: "a", start: 41, end: 42 },
    { text: "cut", start: 42, end: 42.5, cut: true },
    { text: "b", start: 43, end: 45 },
  ] }
  const moved = { ...line, start: 10, end: 12, words: wordsForDraggedBlock(line, 10, 12) }
  assert.deepEqual(estimatedWordsForSegment(moved).map(w => [w.start, w.end]),
    [[10, 10.5], [11, 12]])
  assert.deepEqual(cutRangesFromSegments([moved]), [{ start: 42, end: 42.5 }])
  assert.equal(line.words[0].start, 41)
})

test("unusable word times are distributed by the length of the visible text", () => {
  const line = { start: 40, end: 44, text: "uno a", words: [
    { text: "uno", start: 42, end: 42 }, { text: "a", start: 43, end: 43 },
  ] }
  assert.deepEqual(wordsForDraggedBlock(line, 5, 7).map(w => [w.start, w.end]),
    [[5, 6.5], [6.5, 7]])
  const translated = { start: 5, end: 7, text: "uno a" }
  assert.deepEqual(estimatedWordsForSegment(translated).map(w => [w.start, w.end]),
    [[5, 6.5], [6.5, 7]])
})
