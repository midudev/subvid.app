// The home demo's dithered "interview". Frames are rendered in a worker on an
// OffscreenCanvas, so sampling and dithering every frame doesn't cost the main
// thread anything. Browsers without OffscreenCanvas (or a worker that fails to
// start) get the same renderer on the main thread.
import { createDitherRenderer, type SceneState } from "@/scripts/demo/ditherRenderer.ts"

export type { SceneState }
export const FRAME = { rest: 0, talk: 1, blink: 2 } as const

type Renderer = ReturnType<typeof createDitherRenderer>

export function createDitherScene(
  canvas: HTMLCanvasElement,
  spriteUrl: string,
  onLoad: () => void,
) {
  let size: [number, number] | null = null
  let state: SceneState | null = null
  let sprite: HTMLImageElement | null = null
  let worker: Worker | null = null
  let renderer: Renderer | null = null

  // Main-thread fallback: replays whatever the scene has been told so far.
  function renderOnMainThread(target: HTMLCanvasElement) {
    renderer = createDitherRenderer(target, document.createElement("canvas"))
    if (size) renderer.resize(...size)
    if (sprite) renderer.setSprite(sprite, sprite.naturalWidth, sprite.naturalHeight)
    if (state) renderer.render(state)
  }

  // A transferred canvas can't be drawn from this thread anymore: swap in a
  // fresh one if the worker dies.
  function abandonWorker() {
    if (!worker) return
    worker.terminate()
    worker = null
    const fresh = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(fresh)
    canvas = fresh
    renderOnMainThread(fresh)
  }

  const canUseWorker =
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    "transferControlToOffscreen" in canvas

  if (canUseWorker) {
    try {
      worker = new Worker(new URL("./ditherScene.worker.ts", import.meta.url), {
        type: "module",
      })
      worker.onerror = abandonWorker
      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage({ type: "init", canvas: offscreen }, [offscreen])
    } catch {
      if (worker) abandonWorker()
      else renderOnMainThread(canvas)
    }
  } else {
    renderOnMainThread(canvas)
  }

  const source = new Image()
  source.decoding = "async"
  source.src = spriteUrl
  source
    .decode()
    .then(async () => {
      sprite = source
      if (worker) {
        try {
          const bitmap = await createImageBitmap(source)
          worker?.postMessage(
            { type: "sprite", bitmap, width: bitmap.width, height: bitmap.height },
            [bitmap],
          )
        } catch {
          abandonWorker()
        }
      }
      renderer?.setSprite(source, source.naturalWidth, source.naturalHeight)
      onLoad()
    })
    .catch(() => {})

  // Picks a resolution so each dithered cell is about `cell` CSS pixels wide.
  function resize(cssWidth: number, cell: number) {
    const width = Math.max(96, Math.round(cssWidth / cell))
    const height = Math.round((width * 9) / 16)
    if (size && size[0] === width && size[1] === height) return
    size = [width, height]
    worker?.postMessage({ type: "resize", width, height })
    renderer?.resize(width, height)
  }

  function render(next: SceneState) {
    state = next
    worker?.postMessage({ type: "render", state: next })
    renderer?.render(next)
  }

  return { resize, render }
}
