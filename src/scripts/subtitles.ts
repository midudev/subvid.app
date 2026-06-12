import { LANGS } from "@/scripts/languages.ts"

export type SubtitleSegment = {
  start: number
  end: number
  text: string
  words?: SubtitleWord[]
}

export type SubtitleWord = {
  start: number
  end: number
  text: string
}

type NormalizeSegmentsOptions = {
  audio?: Float32Array
  sampleRate?: number
  aspectRatio?: number
}

type SpeechRun = {
  start: number
  end: number
}

const DEFAULT_SAMPLE_RATE = 16_000
const SILENCE_BREAK_SECONDS = 0.55

export function formatSrtTime(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(c / 3600)
  const m = Math.floor((c % 3600) / 60)
  const s = Math.floor(c % 60)
  const ms = Math.floor((c - Math.floor(c)) * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

export function formatClock(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(c / 60)
  const s = Math.floor(c % 60)
  const cs = Math.round((c - Math.floor(c)) * 100)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${m}:${p(s)}.${p(cs)}`
}

export function parseClock(value: string): number | null {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) return null
  const m = Number(match[1])
  const s = Number(match[2])
  const frac = match[3] ? Number(`0.${match[3]}`) : 0
  return m * 60 + s + frac
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.floor((values.length - 1) * ratio)),
  )
  return values[index]
}

function speechRunsForAudio(audio?: Float32Array, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!audio?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return []

  const frameSamples = Math.max(1, Math.round(sampleRate * 0.04))
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.02))
  const frameCount = Math.max(1, Math.floor((audio.length - frameSamples) / hopSamples) + 1)
  const energies = new Array<number>(frameCount)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSamples
    const end = Math.min(audio.length, start + frameSamples)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += audio[i] * audio[i]
    energies[frame] = Math.sqrt(sum / Math.max(1, end - start))
  }

  const sorted = [...energies].sort((a, b) => a - b)
  const noiseFloor = percentile(sorted, 0.2)
  const speechLevel = percentile(sorted, 0.85)
  const threshold = Math.max(0.003, noiseFloor * 4, speechLevel * 0.12)
  const runs: SpeechRun[] = []
  let activeStart = -1

  energies.forEach((energy, frame) => {
    if (energy >= threshold) {
      if (activeStart < 0) activeStart = frame
      return
    }
    if (activeStart < 0) return
    const start = (activeStart * hopSamples) / sampleRate
    const end = (frame * hopSamples + frameSamples) / sampleRate
    if (end - start >= 0.06) runs.push({ start, end })
    activeStart = -1
  })

  if (activeStart >= 0) {
    const start = (activeStart * hopSamples) / sampleRate
    const end = audio.length / sampleRate
    if (end - start >= 0.06) runs.push({ start, end })
  }

  return runs.reduce<SpeechRun[]>((merged, run) => {
    const previous = merged[merged.length - 1]
    if (previous && run.start - previous.end <= 0.16) {
      previous.end = Math.max(previous.end, run.end)
    } else {
      merged.push({ ...run })
    }
    return merged
  }, [])
}

function nearestRunEdge(
  runs: SpeechRun[],
  time: number,
  edge: "start" | "end",
  before: number,
  after: number,
) {
  let best: { value: number; distance: number } | null = null
  for (const run of runs) {
    if (run.end < time - before || run.start > time + after) continue
    const value = edge === "start" ? run.start : run.end
    const distance = Math.abs(value - time)
    if (!best || distance < best.distance) best = { value, distance }
  }
  return best?.value
}

function refineSegmentsWithSpeechRuns(
  segments: SubtitleSegment[],
  audio?: Float32Array,
  sampleRate = DEFAULT_SAMPLE_RATE,
) {
  const runs = speechRunsForAudio(audio, sampleRate)
  if (!runs.length) return segments
  const audioEnd = audio ? audio.length / sampleRate : Number.POSITIVE_INFINITY

  const refined = segments.map((segment) => {
    const startEdge = nearestRunEdge(runs, segment.start, "start", 0.35, 0.65)
    const endEdge = nearestRunEdge(runs, segment.end, "end", 0.65, 0.35)
    const start =
      startEdge == null ? segment.start : Math.max(0, startEdge - 0.04)
    const end =
      endEdge == null ? segment.end : Math.min(audioEnd, endEdge + 0.08)
    const next = {
      ...segment,
      start,
      end: Math.max(start + 0.35, end),
    }
    if (next.words?.length) {
      next.words = next.words.map((word) => ({ ...word }))
      next.words[0].start = next.start
      next.words[next.words.length - 1].end = next.end
    }
    return next
  })

  for (let i = 1; i < refined.length; i += 1) {
    const previous = refined[i - 1]
    const current = refined[i]
    if (current.start > previous.end) continue
    const boundary = (previous.end + current.start) / 2
    previous.end = Math.max(previous.start + 0.25, boundary - 0.01)
    current.start = Math.min(current.end - 0.25, previous.end + 0.02)
  }

  return refined
}

function normalizedRange(chunk: any, index: number) {
  const range = Array.isArray(chunk?.timestamp)
    ? chunk.timestamp
    : [index * 2, index * 2 + 2]
  const start = Number.isFinite(range[0]) ? range[0] : index * 2
  const end = Number.isFinite(range[1]) ? range[1] : start + 2
  return {
    start,
    end: Math.max(start + 0.08, end),
  }
}

function normalizeWordChunk(chunk: any, index: number): SubtitleWord | null {
  const text = String(chunk?.text || "").trim()
  if (!text) return null
  const { start, end } = normalizedRange(chunk, index)
  return { start, end, text }
}

function isWordLevelChunks(chunks: any[]) {
  const textChunks = chunks
    .map((chunk) => String(chunk?.text || "").trim())
    .filter(Boolean)
  if (textChunks.length < 2) return false
  const singleWordChunks = textChunks.filter((text) => !/\s/.test(text)).length
  return singleWordChunks / textChunks.length > 0.82
}

function wordsText(words: SubtitleWord[]) {
  return words.reduce((text, word) => appendWordText(text, word.text), "").trim()
}

function appendWordText(text: string, word: string) {
  if (!text) return word
  if (shouldJoinWithoutSpace(text, word)) return `${text}${word}`
  return `${text} ${word}`
}

function shouldJoinWithoutSpace(previous: string, next: string) {
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  return (
    /^[,.;:!?%\)\]\}\u2026]/.test(next) ||
    /[(\[\{]$/.test(previous) ||
    (cjk.test(previous.at(-1) || "") && cjk.test(next.charAt(0)))
  )
}

function tokenizeSubtitleText(text: string) {
  if (/\s/.test(text)) return text.split(/\s+/).filter(Boolean)
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text))
    return Array.from(text)
  return text ? [text] : []
}

function buildWordSegment(words: SubtitleWord[]): SubtitleSegment {
  const start = words[0]?.start || 0
  const end = words[words.length - 1]?.end || start + 2
  return {
    start,
    end: Math.max(start + 0.35, end),
    text: wordsText(words),
    words,
  }
}

function lineLimitsForAspectRatio(aspectRatio: number) {
  // For portrait videos (< 1.0) shorten lines proportionally so text fits the narrow frame.
  // For landscape (>= 1.0) keep the defaults.
  const ratio = Math.min(1, aspectRatio * 1.2)
  return {
    maxChars: Math.max(24, Math.round(46 * ratio)),
    maxWords: Math.max(4, Math.round(8 * ratio)),
  }
}

function normalizeWordLevelSegments(chunks: any[], aspectRatio = 16 / 9): SubtitleSegment[] {
  const { maxChars, maxWords } = lineLimitsForAspectRatio(aspectRatio)
  const words = chunks
    .map((chunk, index) => normalizeWordChunk(chunk, index))
    .filter((word): word is SubtitleWord => !!word)
    .sort((a, b) => a.start - b.start)

  const segments: SubtitleSegment[] = []
  let line: SubtitleWord[] = []
  const flush = () => {
    if (!line.length) return
    segments.push(buildWordSegment(line))
    line = []
  }

  words.forEach((word) => {
    if (line.length) {
      const previousWord = line[line.length - 1]
      const silenceBefore = word.start - previousWord.end
      const nextText = wordsText([...line, word])
      const nextDuration = word.end - line[0].start
      const shouldBreak =
        silenceBefore > SILENCE_BREAK_SECONDS ||
        line.length >= maxWords ||
        nextText.length > maxChars ||
        nextDuration > 5.2
      if (shouldBreak) flush()
    }

    line.push(word)

    const text = wordsText(line)
    const duration = line[line.length - 1].end - line[0].start
    if (
      /[.!?\u2026]$/.test(word.text) &&
      line.length >= 3 &&
      duration >= 1.1 &&
      text.length >= 18
    )
      flush()
  })

  flush()
  return segments
}

export function estimatedWordsForSegment(segment: SubtitleSegment): SubtitleWord[] {
  const text = String(segment.text || "").trim()
  if (!text) return []

  const textWords = tokenizeSubtitleText(text)
  const storedWords =
    Array.isArray(segment.words) && segment.words.length ? segment.words : []
  if (
    storedWords.length &&
    wordsText(storedWords).replace(/\s+/g, " ") === text.replace(/\s+/g, " ")
  ) {
    return storedWords
  }

  const start = Number.isFinite(segment.start) ? segment.start : 0
  const end = Math.max(
    start + 0.35,
    Number.isFinite(segment.end) ? segment.end : start + 2,
  )
  const duration = end - start
  const totalWeight = textWords.reduce(
    (sum, word) => sum + Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length),
    0,
  )
  let cursor = start

  return textWords.map((word, index) => {
    const weight = Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length)
    const isLast = index === textWords.length - 1
    const wordEnd = isLast ? end : cursor + (duration * weight) / totalWeight
    const result = {
      start: cursor,
      end: Math.max(cursor + 0.05, wordEnd),
      text: word,
    }
    cursor = result.end
    return result
  })
}

export function normalizeSegments(
  output: any,
  options: NormalizeSegmentsOptions = {},
): SubtitleSegment[] {
  if (!output || !Array.isArray(output.chunks)) {
    const text = output?.text?.trim()
    return text ? [{ start: 0, end: 6, text }] : []
  }
  if (isWordLevelChunks(output.chunks)) {
    return refineSegmentsWithSpeechRuns(
      normalizeWordLevelSegments(output.chunks, options.aspectRatio),
      options.audio,
      options.sampleRate,
    )
  }

  const segments = output.chunks
    .map((chunk: any, index: number) => {
      const { start, end } = normalizedRange(chunk, index)
      return {
        start,
        end: Math.max(start + 0.35, end),
        text: (chunk.text || "").trim(),
      }
    })
    .filter((s: SubtitleSegment) => s.text.length > 0)

  return refineSegmentsWithSpeechRuns(segments, options.audio, options.sampleRate)
}

export function buildSrt(segments: SubtitleSegment[]): string {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}`,
    )
    .join("\n\n")
}

export function normalizeLanguageCode(code: string): string {
  if (!code) return ""
  const short = String(code).toLowerCase().slice(0, 2)
  return short in LANGS ? short : ""
}
