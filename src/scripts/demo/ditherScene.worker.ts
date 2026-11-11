// Renders the home demo's dithered frames off the main thread, on the
// OffscreenCanvas transferred from the page.
//
// Protocol (main -> worker):
//   -> { type: "init", canvas }                  // OffscreenCanvas, transferred
//   -> { type: "resize", width, height }
//   -> { type: "sprite", bitmap, width, height } // ImageBitmap, transferred
//   -> { type: "render", state }                 // SceneState
import { createDitherRenderer } from "@/scripts/demo/ditherRenderer.ts"

let renderer: ReturnType<typeof createDitherRenderer> | null = null

self.onmessage = (event: MessageEvent) => {
  const message = event.data
  if (message.type === "init") {
    renderer = createDitherRenderer(message.canvas, new OffscreenCanvas(1, 1))
  } else if (message.type === "resize") {
    renderer?.resize(message.width, message.height)
  } else if (message.type === "sprite") {
    renderer?.setSprite(message.bitmap, message.width, message.height)
  } else if (message.type === "render") {
    renderer?.render(message.state)
  }
}
