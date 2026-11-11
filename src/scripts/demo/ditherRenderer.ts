// Draws the home demo's "interview": a 3-frame sprite (rest, talking, blink)
// sampled at a low resolution every frame, dithered into the subvid palette
// and scaled up with `image-rendering: pixelated`. It has no DOM dependencies,
// so it runs in a worker on an OffscreenCanvas (see ditherScene.worker.ts) or,
// as a fallback, on the main thread.
import { ditherInto, INK } from "@/scripts/dither.ts"

// The footage is dark: lift it a little so the dithering has room to work.
const GAIN = 1.35
const LIFT = 0.02

export const SPRITE_FRAMES = 3

export type SceneState = {
  // Which sprite frame to show.
  frame: number
  // ≥ 1: slow push-in on the speaker.
  zoom: number
  // −0.5 → 0.5: where the zoomed crop sits inside the frame.
  panX: number
  panY: number
  // 0 → 1: the frame dissolves in block by block, like a file being read.
  reveal: number
  // Amount of per-frame noise, so playback "breathes" like real footage.
  grain: number
}

type Surface = HTMLCanvasElement | OffscreenCanvas
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function createDitherRenderer(canvas: Surface, sampler: Surface) {
  const ctx = canvas.getContext("2d", { alpha: false }) as Context | null
  const samplerCtx = sampler.getContext("2d", { willReadFrequently: true }) as Context | null
  let width = 0
  let height = 0
  let image: ImageData | null = null
  let pixels: Uint32Array | null = null
  let sprite: CanvasImageSource | null = null
  let spriteWidth = 0
  let spriteHeight = 0

  function setSprite(source: CanvasImageSource, sourceWidth: number, sourceHeight: number) {
    sprite = source
    spriteWidth = sourceWidth
    spriteHeight = sourceHeight
  }

  function resize(nextWidth: number, nextHeight: number) {
    if (!ctx || (nextWidth === width && nextHeight === height)) return
    width = canvas.width = sampler.width = nextWidth
    height = canvas.height = sampler.height = nextHeight
    image = ctx.createImageData(width, height)
    pixels = new Uint32Array(image.data.buffer)
  }

  function render({ frame, zoom, panX, panY, reveal, grain }: SceneState) {
    if (!ctx || !samplerCtx || !image || !pixels) return
    if (!sprite) {
      pixels.fill(INK)
      ctx.putImageData(image, 0, 0)
      return
    }

    const frameWidth = spriteWidth
    const frameHeight = spriteHeight / SPRITE_FRAMES
    const cropWidth = frameWidth / zoom
    const cropHeight = frameHeight / zoom
    samplerCtx.drawImage(
      sprite,
      (frameWidth - cropWidth) * (0.5 + panX),
      frame * frameHeight + (frameHeight - cropHeight) * (0.5 + panY),
      cropWidth,
      cropHeight,
      0,
      0,
      width,
      height,
    )
    ditherInto(samplerCtx.getImageData(0, 0, width, height).data, pixels, width, height, {
      gain: GAIN,
      lift: LIFT,
      grain,
      reveal,
    })
    ctx.putImageData(image, 0, 0)
  }

  return { setSprite, resize, render }
}
