import type { SubtitleSegment } from "@/scripts/subtitles.ts"

// Words explicitly cut in the transcript editor are removed from the video. Cuts are
// time ranges on the source media, derived from the transcription track words.
export type TimeRange = { start: number; end: number }

export function cutRangesFromSegments(
  segments: SubtitleSegment[] | undefined,
): TimeRange[] {
  const words = (segments || [])
    .flatMap((segment) => segment.words || [])
    .sort((a, b) => a.start - b.start)
  const ranges: TimeRange[] = []
  let run: TimeRange | null = null

  // Consecutive cut words make a single range, so the silence between them
  // goes away too.
  for (const word of words) {
    if (!word.cut) {
      run = null
      continue
    }
    if (run) run.end = Math.max(run.end, word.end)
    else {
      run = { start: word.start, end: word.end }
      ranges.push(run)
    }
  }

  return ranges.reduce<TimeRange[]>((merged, range) => {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else if (range.end > range.start) {
      merged.push({ ...range })
    }
    return merged
  }, [])
}

export function cutAt(ranges: TimeRange[], time: number) {
  return ranges.find((range) => time >= range.start && time < range.end)
}

export function cutDuration(ranges: TimeRange[]) {
  return ranges.reduce((total, range) => total + range.end - range.start, 0)
}

/** Maps a source time to the time it lands on once the cuts are removed. */
export function mapTimeThroughCuts(ranges: TimeRange[], time: number) {
  let removed = 0
  for (const range of ranges) {
    if (time <= range.start) break
    removed += Math.min(time, range.end) - range.start
  }
  return time - removed
}

/** Kept parts of [start, end), already mapped to the output timeline. */
export function keptParts(ranges: TimeRange[], start: number, end: number) {
  const parts: Array<TimeRange & { outputStart: number }> = []
  let cursor = start
  for (const range of ranges) {
    if (range.end <= cursor) continue
    if (range.start >= end) break
    if (range.start > cursor)
      parts.push({
        start: cursor,
        end: range.start,
        outputStart: mapTimeThroughCuts(ranges, cursor),
      })
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < end)
    parts.push({
      start: cursor,
      end,
      outputStart: mapTimeThroughCuts(ranges, cursor),
    })
  return parts
}

/** Subtitle timings for the cut video (segments fully inside a cut are dropped). */
export function segmentsThroughCuts<T extends SubtitleSegment>(
  segments: T[],
  ranges: TimeRange[],
): T[] {
  if (!ranges.length) return segments
  return segments
    .filter((segment) => keptParts(ranges, segment.start, segment.end).length)
    .map((segment) => ({
      ...segment,
      start: mapTimeThroughCuts(ranges, segment.start),
      end: mapTimeThroughCuts(ranges, segment.end),
      words: segment.words?.map((word) => ({
        ...word,
        start: mapTimeThroughCuts(ranges, word.start),
        end: mapTimeThroughCuts(ranges, word.end),
      })),
    }))
}
