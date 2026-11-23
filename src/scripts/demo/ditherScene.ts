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
  let suspended = false
  let workerFailed = false

  // Main-thread fallback: replays whatever the scene has been told so far.
  function renderOnMainThread(target: HTMLCanvasElement) {
    renderer = createDitherRenderer(target, document.createElement("canvas"))
    if (size) renderer.resize(...size)
    if (sprite) renderer.setSprite(sprite, sprite.naturalWidth, sprite.naturalHeight)
    if (state) renderer.render(state)
  }

  function replaceCanvas() {
    const fresh = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(fresh)
    canvas = fresh
    return fresh
  }

  // A transferred canvas can't be drawn from this thread anymore: swap in a
  // fresh one if the worker dies.
  function abandonWorker() {
    if (!worker) return
    workerFailed = true
    worker.terminate()
    worker = null
    renderOnMainThread(replaceCanvas())
  }

  const canUseWorker =
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    "transferControlToOffscreen" in canvas

  function sendSpriteToWorker(targetWorker: Worker, source: HTMLImageElement) {
    createImageBitmap(source)
      .then((bitmap) => {
        if (worker !== targetWorker) {
          bitmap.close()
          return
        }
        targetWorker.postMessage(
          { type: "sprite", bitmap, width: bitmap.width, height: bitmap.height },
          [bitmap],
        )
        if (state) targetWorker.postMessage({ type: "render", state })
      })
      .catch(() => {
        if (worker === targetWorker) abandonWorker()
      })
  }

  function startWorker() {
    try {
      const next = new Worker(new URL("./ditherScene.worker.ts", import.meta.url), {
        type: "module",
      })
      worker = next
      next.onerror = abandonWorker
      const offscreen = canvas.transferControlToOffscreen()
      next.postMessage({ type: "init", canvas: offscreen }, [offscreen])
      if (size) next.postMessage({ type: "resize", width: size[0], height: size[1] })
      if (sprite) sendSpriteToWorker(next, sprite)
      else if (state) next.postMessage({ type: "render", state })
    } catch {
      if (worker) abandonWorker()
      else {
        workerFailed = true
        renderOnMainThread(canvas)
      }
    }
  }

  if (canUseWorker) startWorker()
  else renderOnMainThread(canvas)

  const source = new Image()
  source.decoding = "async"
  source.src = spriteUrl
  source
    .decode()
    .then(() => {
      sprite = source
      if (worker) sendSpriteToWorker(worker, source)
      renderer?.setSprite(source, source.naturalWidth, source.naturalHeight)
      onLoad()
    })
    .catch(() => {})

  // Releases the worker thread and OffscreenCanvas buffers while the landing
  // is hidden (e.g. while the user is in the config or editor stage).
  function suspend() {
    if (suspended || !worker) return
    suspended = true
    worker.terminate()
    worker = null
  }

  function resume() {
    if (!suspended) return
    suspended = false
    if (canUseWorker && !workerFailed) {
      replaceCanvas()
      startWorker()
    } else if (!renderer) {
      renderOnMainThread(canvas)
    }
  }

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

  return { resize, render, suspend, resume }
}
