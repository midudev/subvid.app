// Renders the config preview's dithered scan overlay off the main thread, on
// an OffscreenCanvas transferred from the page.
//
// Protocol (main -> worker):
//   -> { type: "init", canvas }                                 // OffscreenCanvas, transferred
//   -> { type: "resize", width, height }
//   -> { type: "render", bitmap, dx, dy, dw, dh, grain }        // ImageBitmap, transferred
//   <- { type: "rendered" }
import { ditherInto } from "@/scripts/dither.ts"

let ctx: OffscreenCanvasRenderingContext2D | null = null
let sampler: OffscreenCanvas | null = null
let samplerCtx: OffscreenCanvasRenderingContext2D | null = null
let width = 0
let height = 0
let output: ImageData | null = null
let pixels: Uint32Array | null = null

self.onmessage = (event: MessageEvent) => {
  const message = event.data
  if (message.type === "init") {
    ctx = message.canvas.getContext("2d")
    sampler = new OffscreenCanvas(1, 1)
    samplerCtx = sampler.getContext("2d", { willReadFrequently: true })
  } else if (message.type === "resize") {
    if (!ctx || !sampler || (message.width === width && message.height === height)) return
    width = message.width
    height = message.height
    ctx.canvas.width = sampler.width = width
    ctx.canvas.height = sampler.height = height
    output = ctx.createImageData(width, height)
    pixels = new Uint32Array(output.data.buffer)
  } else if (message.type === "render") {
    const bitmap: ImageBitmap = message.bitmap
    try {
      if (ctx && samplerCtx && output && pixels) {
        samplerCtx.clearRect(0, 0, width, height)
        samplerCtx.drawImage(bitmap, message.dx, message.dy, message.dw, message.dh)
        ditherInto(
          samplerCtx.getImageData(0, 0, width, height).data,
          pixels,
          width,
          height,
          { grain: message.grain },
        )
        ctx.putImageData(output, 0, 0)
      }
    } finally {
      bitmap.close()
      self.postMessage({ type: "rendered" })
    }
  }
}
