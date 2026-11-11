import spriteUrl from "@/assets/demo/interview.webp?url"
import { createDitherScene, FRAME } from "@/scripts/demo/ditherScene.ts"
import {
  DEMO_CUES,
  DEMO_DURATION,
  DEMO_LOOP,
  DEMO_PHASES,
  DEMO_STEPS,
} from "@/scripts/demo/timing.ts"

type Phase = keyof typeof DEMO_PHASES
type Range = readonly [number, number]

// CSS pixels per dithered cell.
const CELL = 2
// The scene runs at "film" rate: smooth enough and cheap on battery.
const FRAME_MS = 1000 / 24
// The frame dissolves out during the last part of the loop.
const OUTRO = 0.9
// Moments (in video seconds) when the speaker blinks.
const BLINKS = [1.7, 5.1, 8.2]
const BLINK_LENGTH = 0.15
// Frame shown, without motion, when the user prefers reduced motion.
const STILL_TIME =
  DEMO_PHASES.play[0] + (DEMO_CUES[1].start + DEMO_CUES[1].end) / 2

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const progress = ([start, end]: Range, t: number) =>
  clamp01((t - start) / (end - start))

function phaseAt(t: number): Phase {
  for (const [name, [start, end]] of Object.entries(DEMO_PHASES)) {
    if (t >= start && t < end) return name as Phase
  }
  return "export"
}

function formatTimecode(seconds: number) {
  const ms = Math.round(seconds * 1000)
  const s = String(Math.floor(ms / 1000)).padStart(2, "0")
  return `00:00:${s},${String(ms % 1000).padStart(3, "0")}`
}

export function initHomeDemo(root: HTMLElement) {
  const screen = root.querySelector<HTMLElement>(".demo-screen")
  const canvas = root.querySelector<HTMLCanvasElement>(".demo-canvas")
  const statusText = root.querySelector<HTMLElement>(".demo-status-value")
  const statusSizer = root.querySelector<HTMLElement>(".demo-status-sizer")
  const timecode = root.querySelector<HTMLElement>(".demo-time-value")
  const lane = root.querySelector<HTMLElement>(".demo-lane")
  const playheadEl = root.querySelector<HTMLElement>(".demo-playhead")
  const litBars = root.querySelector<HTMLElement>(".demo-bars--lit")
  if (!screen || !canvas || !statusText || !timecode) return
  // Narrowed copies: the per-frame callback below can't see the guard above.
  const statusEl: HTMLElement = statusText
  const timecodeEl: HTMLElement = timecode

  const blocks = {
    src: [...root.querySelectorAll<HTMLElement>(".demo-row--src .demo-block")],
    tr: [...root.querySelectorAll<HTMLElement>(".demo-row--tr .demo-block")],
  }
  const cues = [...root.querySelectorAll<HTMLElement>(".demo-cue")].map((el) => {
    const words = [...el.querySelectorAll<HTMLElement>(".demo-w")]
    // Each word gets a share of the cue proportional to its length.
    const lengths = words.map((word) => (word.textContent ?? "").length + 1)
    const total = lengths.reduce((sum, length) => sum + length, 0)
    let elapsed = 0
    const ends = lengths.map((length) => (elapsed += length / total))
    return { el, words, ends }
  })
  const steps = [...document.querySelectorAll<HTMLElement>("[data-demo-step]")]
  const copy = root.dataset
  const scene = createDitherScene(canvas, spriteUrl, () => {
    sceneKey = ""
    update(...current)
  })
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")

  // The loop starts on its first frame as soon as the page loads.
  let clock = 0
  let last = 0
  let raf = 0
  let visible = false
  let sceneKey = ""
  let status = ""
  let statusSize = ""
  // Last values written to the DOM: per-frame writes are skipped when nothing
  // changed, and go straight to the element that uses them (as `transform` or
  // `clip-path`) so a frame never triggers layout or restyles the whole demo.
  let laneWidth = 0
  let lastPhase = ""
  let lastScan = ""
  let lastPlayhead = ""
  const lastProgress = steps.map(() => "")
  // A text node updates in place instead of replacing the element's children.
  const timecodeText = document.createTextNode(timecodeEl.textContent ?? "")
  timecodeEl.replaceChildren(timecodeText)
  const statusValue = document.createTextNode(statusEl.textContent ?? "")
  statusEl.replaceChildren(statusValue)
  let current: [number, boolean] = [0, false]

  function update(t: number, still = false) {
    current = [t, still]
    const phase = phaseAt(t)
    const leaving = t > DEMO_LOOP - OUTRO
    const scanSrc = progress(DEMO_PHASES.transcribe, t)
    const scanTr = progress(DEMO_PHASES.translate, t)
    const videoTime = progress(DEMO_PHASES.play, t) * DEMO_DURATION
    const reveal = leaving
      ? 1 - progress([DEMO_LOOP - OUTRO, DEMO_LOOP], t)
      : progress([0, DEMO_PHASES.reveal[1] - 0.2], t)

    if (phase !== lastPhase) root.dataset.phase = lastPhase = phase
    root.classList.toggle("is-leaving", leaving)

    // Timeline: waveform lit behind the scan, cue blocks appear as it passes.
    const playhead = {
      reveal: 0,
      transcribe: scanSrc,
      translate: scanTr,
      play: videoTime / DEMO_DURATION,
      export: 1,
    }[phase]
    const scan = phase === "reveal" || leaving ? 0 : scanSrc
    const nextScan = `inset(0 ${((1 - scan) * 100).toFixed(2)}% 0 0)`
    if (litBars && nextScan !== lastScan) litBars.style.clipPath = lastScan = nextScan
    const nextPlayhead = `translateX(${(playhead * laneWidth).toFixed(2)}px)`
    if (playheadEl && nextPlayhead !== lastPlayhead)
      playheadEl.style.transform = lastPlayhead = nextPlayhead
    DEMO_CUES.forEach((cue, index) => {
      const end = cue.end / DEMO_DURATION
      blocks.src[index]?.classList.toggle("is-in", !leaving && scanSrc >= end)
      blocks.tr[index]?.classList.toggle("is-in", !leaving && scanTr >= end)
    })

    // Captions, word by word.
    const active =
      phase === "play"
        ? DEMO_CUES.findIndex((cue) => videoTime >= cue.start && videoTime < cue.end)
        : -1
    cues.forEach(({ el, words, ends }, index) => {
      const isActive = index === active
      el.classList.toggle("is-active", isActive)
      if (!isActive) return
      const cue = DEMO_CUES[index]
      // Words finish slightly before the cue ends, like real speech.
      const spoken = still ? 1 : ((videoTime - cue.start) / (cue.end - cue.start)) * 1.12
      const current = ends.findIndex((end) => end > spoken)
      words.forEach((word, i) => {
        word.classList.toggle("is-spoken", current === -1 || i < current)
        word.classList.toggle("is-current", i === current)
      })
    })

    // Status line.
    const nextStatus = {
      reveal: copy.reading,
      transcribe: copy.transcribing?.replace("{pct}", String(Math.round(scanSrc * 100))),
      translate: copy.translating,
      play: copy.playing,
      export: copy.exported,
    }[phase] ?? ""
    // The sizer only changes with the phase: it reserves room for "100 %".
    const nextSize =
      phase === "transcribe" ? (copy.transcribing?.replace("{pct}", "100") ?? "") : nextStatus
    if (statusSizer && nextSize !== statusSize) statusSizer.textContent = statusSize = nextSize
    if (nextStatus !== status) statusValue.data = status = nextStatus
    const nextTimecode = formatTimecode(phase === "export" ? DEMO_DURATION : videoTime)
    if (timecodeText.data !== nextTimecode) timecodeText.data = nextTimecode

    // The home steps double as chapters of the demo.
    const step = still ? -1 : DEMO_STEPS.findIndex((range) => t >= range[0] && t < range[1])
    steps.forEach((el, index) => {
      el.classList.toggle("is-active", index === step)
      el.classList.toggle("is-done", step > index)
      const nextProgress = index === step ? progress(DEMO_STEPS[index], t).toFixed(4) : ""
      if (nextProgress !== lastProgress[index])
        el.style.setProperty("--progress", (lastProgress[index] = nextProgress))
    })

    // Dithered frame: the mouth moves at syllable rate while a cue is spoken,
    // the camera slowly pushes in with a little handheld sway.
    const moving = phase === "play" && !still
    const talking =
      moving && active >= 0 && Math.sin(videoTime * 23) + Math.sin(videoTime * 14.5) > 0.3
    const blinking =
      moving && BLINKS.some((at) => videoTime >= at && videoTime < at + BLINK_LENGTH)
    const frame = blinking ? FRAME.blink : talking ? FRAME.talk : FRAME.rest
    const zoom = 1.03 + 0.05 * (videoTime / DEMO_DURATION)
    const panX = 0.3 + 0.12 * Math.sin(videoTime * 0.9)
    const panY = -0.3 + 0.1 * Math.sin(videoTime * 1.3)
    const grain = moving ? 0.05 : 0
    // Only re-render when something visible changed.
    const key = `${reveal}|${videoTime}|${frame}|${grain}`
    if (key !== sceneKey) {
      sceneKey = key
      scene.render({ frame, zoom, panX, panY, reveal, grain })
    }
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    clock += Math.min(now - last, 100) / 1000
    if (clock >= DEMO_LOOP) clock %= DEMO_LOOP
    last = now
    update(Math.max(0, clock))
  }

  function sync() {
    const shouldRun = visible && !document.hidden && !reduceMotion.matches
    if (shouldRun && !raf) {
      last = performance.now()
      raf = requestAnimationFrame(tick)
    } else if (!shouldRun && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (reduceMotion.matches) update(STILL_TIME, true)
  }

  const resizeObserver = new ResizeObserver(() => {
    scene.resize(screen.clientWidth, CELL)
    // The playhead moves in pixels (compositor-only), so it needs the lane width.
    laneWidth = lane?.clientWidth ?? 0
    sceneKey = ""
    if (reduceMotion.matches) update(STILL_TIME, true)
    else update(Math.max(0, clock))
  })
  resizeObserver.observe(screen)
  if (lane) resizeObserver.observe(lane)

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    sync()
  }).observe(root)

  document.addEventListener("visibilitychange", sync)
  reduceMotion.addEventListener("change", sync)
}
