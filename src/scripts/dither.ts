// Ordered (Bayer) dithering into the small subvid palette. Shared by the home
// demo and the "reading" effect over the video while subtitles are generated.

// 8×8 Bayer matrix, normalized to thresholds in (0, 1).
export const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14,
  46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19,
  59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
].map((value) => (value + 0.5) / 64)

// Night blues for shadows, warm tones for skin and lamps, a cool highlight.
const PALETTE = [
  "#0d0e12",
  "#1f2a44",
  "#4a5a78",
  "#8a5a3c",
  "#d79a68",
  "#f3dcb8",
  "#c9d3dc",
]
// How far each Bayer threshold nudges a color before it snaps to the palette.
const SPREAD = 0.22

const LUT_BITS = 5
const LUT_SIZE = 1 << LUT_BITS

function parseHex(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as const
}

const COLORS = PALETTE.map(parseHex)
// ImageData pixels as little-endian ABGR words.
const WORDS = COLORS.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0)
export const INK = WORDS[0]

// Nearest palette color for every 5-bit RGB cell, weighted towards green like
// the eye. Built once: 32 768 entries.
const NEAREST = (() => {
  const table = new Uint8Array(LUT_SIZE ** 3)
  const step = 255 / (LUT_SIZE - 1)
  for (let r = 0; r < LUT_SIZE; r++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let b = 0; b < LUT_SIZE; b++) {
        let best = 0
        let bestDistance = Infinity
        COLORS.forEach(([pr, pg, pb], index) => {
          const distance =
            2 * (r * step - pr) ** 2 + 4 * (g * step - pg) ** 2 + 3 * (b * step - pb) ** 2
          if (distance < bestDistance) {
            bestDistance = distance
            best = index
          }
        })
        table[(r << (LUT_BITS * 2)) | (g << LUT_BITS) | b] = best
      }
    }
  }
  return table
})()

const toCell = (value: number) =>
  Math.min(LUT_SIZE - 1, Math.max(0, Math.round(value * (LUT_SIZE - 1))))

export type DitherOptions = {
  // Linear exposure applied before dithering, so dark footage has room to work.
  gain?: number
  lift?: number
  // Amount of per-frame noise, so moving footage "breathes".
  grain?: number
  // 0 → 1: cells appear in 4×4 blocks, in Bayer order, like a file being read.
  reveal?: number
}

// Dithers RGBA `source` into `target` (ImageData words). Transparent source
// pixels stay transparent.
export function ditherInto(
  source: Uint8ClampedArray,
  target: Uint32Array,
  width: number,
  height: number,
  { gain = 1, lift = 0, grain = 0, reveal = 1 }: DitherOptions = {},
) {
  // xorshift32, seeded per call: the grain runs for every pixel of every
  // frame and only has to look random, at about half the cost of Math.random.
  let noise = (Math.random() * 4294967296) | 1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const i = row + x
      if (source[i * 4 + 3] < 128) {
        target[i] = 0
        continue
      }
      if (BAYER[((y >> 2) & 7) * 8 + ((x >> 2) & 7)] > reveal) {
        target[i] = INK
        continue
      }
      let offset = (BAYER[(y & 7) * 8 + (x & 7)] - 0.5) * SPREAD
      if (grain > 0) {
        noise ^= noise << 13
        noise ^= noise >>> 17
        noise ^= noise << 5
        offset += ((noise >>> 0) / 4294967296 - 0.5) * grain
      }
      const r = (source[i * 4] / 255) * gain + lift + offset
      const g = (source[i * 4 + 1] / 255) * gain + lift + offset
      const b = (source[i * 4 + 2] / 255) * gain + lift + offset
      target[i] =
        WORDS[NEAREST[(toCell(r) << (LUT_BITS * 2)) | (toCell(g) << LUT_BITS) | toCell(b)]]
    }
  }
}
