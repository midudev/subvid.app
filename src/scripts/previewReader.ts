// While subtitles are generated, the config preview is "read": the video frame
// starts dithered and a scan line that follows the real progress clears it.
// Rendering runs in a worker on an OffscreenCanvas (with main-thread fallback)
// so it doesn't compete with audio extraction or Whisper on the main thread.
import { ditherInto } from "@/scripts/dither.ts"

// CSS pixels per dithered cell.
const CELL = 2
// The dithered frame shimmers at a low rate, like a scanner.
const FRAME_MS = 1000 / 12

type PreviewReaderOptions = {
  stage: HTMLElement
  preview: HTMLElement
  video: HTMLVideoElement
  progress: HTMLElement
  track: HTMLElement
  fill: HTMLElement
}

export function createPreviewReader({
  stage,
  preview,
  video,
  progress,
  track,
  fill,
}: PreviewReaderOptions) {
  let canvas = document.createElement("canvas")
  canvas.className = "config-reader"
  canvas.setAttribute("aria-hidden", "true")
  preview.append(canvas)

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
  const canUseWorker =
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    "transferControlToOffscreen" in canvas

  let worker: Worker | null = null
  let workerFailed = false
  let inFlight = false
  let ctx: CanvasRenderingContext2D | null = null
  let sampler: HTMLCanvasElement | null = null
  let samplerCtx: CanvasRenderingContext2D | null = null
  let output: ImageData | null = null
  let pixels: Uint32Array | null = null
  let width = 0
  let height = 0
  let reading = false
  let raf = 0
  let last = 0

  function ensureMainThread() {
    if (ctx) return
    ctx = canvas.getContext("2d")
    sampler = document.createElement("canvas")
    samplerCtx = sampler.getContext("2d", { willReadFrequently: true })
    if (width && height && ctx && sampler) {
      canvas.width = sampler.width = width
      canvas.height = sampler.height = height
      output = ctx.createImageData(width, height)
      pixels = new Uint32Array(output.data.buffer)
    }
  }

  function replaceCanvas() {
    const fresh = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(fresh)
    canvas = fresh
  }

  function abandonWorker() {
    if (!worker) return
    workerFailed = true
    inFlight = false
    worker.terminate()
    worker = null
    ctx = null
    replaceCanvas()
    ensureMainThread()
  }

  function ensureWorker() {
    if (worker || workerFailed || !canUseWorker) return
    try {
      const next = new Worker(
        new URL("./previewReader.worker.ts", import.meta.url),
        { type: "module" },
      )
      worker = next
      next.onmessage = () => {
        inFlight = false
      }
      next.onerror = abandonWorker
      const offscreen = canvas.transferControlToOffscreen()
      next.postMessage({ type: "init", canvas: offscreen }, [offscreen])
      if (width && height) next.postMessage({ type: "resize", width, height })
    } catch {
      if (worker) abandonWorker()
      else {
        workerFailed = true
        ensureMainThread()
      }
    }
  }

  function teardownWorker() {
    if (!worker) return
    worker.terminate()
    worker = null
    inFlight = false
    // A transferred canvas can't be transferred again if reading restarts later.
    replaceCanvas()
  }

  function resize() {
    const nextWidth = Math.max(64, Math.round(preview.clientWidth / CELL))
    const nextHeight = Math.max(36, Math.round(preview.clientHeight / CELL))
    if (nextWidth === width && nextHeight === height) return
    width = nextWidth
    height = nextHeight
    if (worker) {
      worker.postMessage({ type: "resize", width, height })
    } else if (ctx && sampler) {
      canvas.width = sampler.width = width
      canvas.height = sampler.height = height
      output = ctx.createImageData(width, height)
      pixels = new Uint32Array(output.data.buffer)
    }
  }

  function render(grain = 0) {
    if (!width || !height) return
    if (video.readyState < 2 || !video.videoWidth) return
    // Same box as the video's `object-fit: contain`.
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
    const dw = video.videoWidth * scale
    const dh = video.videoHeight * scale
    const dx = (width - dw) / 2
    const dy = (height - dh) / 2

    if (canUseWorker && !workerFailed) {
      ensureWorker()
      const activeWorker = worker
      if (activeWorker) {
        if (inFlight) return
        inFlight = true
        createImageBitmap(video)
          .then((bitmap) => {
            if (worker !== activeWorker) {
              bitmap.close()
              return
            }
            activeWorker.postMessage(
              { type: "render", bitmap, dx, dy, dw, dh, grain },
              [bitmap],
            )
          })
          .catch(() => {
            inFlight = false
          })
        return
      }
    }

    ensureMainThread()
    if (!ctx || !samplerCtx || !output || !pixels) return
    samplerCtx.clearRect(0, 0, width, height)
    samplerCtx.drawImage(video, dx, dy, dw, dh)
    ditherInto(samplerCtx.getImageData(0, 0, width, height).data, pixels, width, height, {
      grain,
    })
    ctx.putImageData(output, 0, 0)
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    last = now
    render(0.06)
  }

  function sync() {
    const nextReading = !progress.hidden && stage.offsetParent !== null
    const percent = nextReading ? Number(track.getAttribute("aria-valuenow") ?? 0) : 0
    stage.style.setProperty("--read", String(Math.min(100, Math.max(0, percent)) / 100))
    preview.classList.toggle("is-scanning", fill.classList.contains("is-indeterminate"))
    if (stage.hidden && worker) teardownWorker()
    if (nextReading === reading) return

    reading = nextReading
    preview.classList.toggle("is-reading", reading)
    if (reading) {
      resize()
      render()
      if (!reduceMotion.matches && !raf) {
        last = performance.now()
        raf = requestAnimationFrame(tick)
      }
    } else if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  new MutationObserver(sync).observe(progress, { attributes: true, attributeFilter: ["hidden"] })
  new MutationObserver(sync).observe(track, { attributes: true, attributeFilter: ["aria-valuenow"] })
  new MutationObserver(sync).observe(fill, { attributes: true, attributeFilter: ["class"] })
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ["hidden"] })
  new ResizeObserver(() => {
    resize()
    if (reading) render()
  }).observe(preview)
  video.addEventListener("loadeddata", () => reading && render())
  sync()
}
