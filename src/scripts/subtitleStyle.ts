import { $$ } from "@/scripts/dom.ts"
import { estimatedWordsForSegment, type SubtitleWord } from "@/scripts/subtitles.ts"

export const FONT_STACKS: Record<string, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Quicksand", "Trebuchet MS", system-ui, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
}

export const CAPTION_PRESETS = [
  {
    id: "default",
    name: "Default",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      italic: false,
      align: "center",
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: false,
    },
  },
  {
    id: "clean",
    name: "Clean",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      italic: false,
      align: "center",
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "bold",
    name: "Bold",
    s: {
      font: "sans",
      size: 1.12,
      color: "#ffffff",
      weight: 700,
      italic: false,
      align: "center",
      bgEnabled: true,
      bgColor: "#000000",
      bgOpacity: 1,
      outline: false,
    },
  },
  {
    id: "pop",
    name: "Pop",
    s: {
      font: "rounded",
      size: 1.06,
      color: "#fde047",
      weight: 700,
      italic: false,
      align: "center",
      bgEnabled: false,
      bgColor: "#000000",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "neon",
    name: "Neon",
    s: {
      font: "sans",
      size: 1,
      color: "#b8f060",
      weight: 700,
      italic: false,
      align: "center",
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.55,
      outline: false,
    },
  },
  {
    id: "classic",
    name: "Classic",
    s: {
      font: "serif",
      size: 1,
      color: "#ffffff",
      weight: 600,
      italic: false,
      align: "center",
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    s: {
      font: "mono",
      size: 0.92,
      color: "#ffffff",
      weight: 600,
      italic: false,
      align: "center",
      bgEnabled: true,
      bgColor: "#0a0d12",
      bgOpacity: 0.9,
      outline: false,
    },
  },
]

export const captionStyle: any = {
  font: "sans",
  size: 1,
  color: "#ffffff",
  weight: 600,
  italic: false,
  align: "center",
  bgEnabled: true,
  bgColor: "#06080b",
  bgOpacity: 0.84,
  outline: false,
  wordHighlight: false,
  position: "bottom",
  customX: 50,
  customY: 88,
  secondary: false,
}

export const transcriptionCaptionStyle: any = {
  font: "sans",
  size: 0.86,
  color: "#dbeafe",
  weight: 500,
  italic: true,
  align: "center",
  bgEnabled: true,
  bgColor: "#06080b",
  bgOpacity: 0.5,
  outline: false,
  wordHighlight: false,
  position: "top",
  customX: 50,
  customY: 12,
  secondary: false,
}

const captionStylesByTrack = new Map<string, any>()

function cloneStyle(style: any) {
  return { ...style }
}

function baseStyleForRole(role = "default") {
  return role === "transcription" ? transcriptionCaptionStyle : captionStyle
}

function trackStyleKey(role = "default", lang = "") {
  return `${role || "default"}:${lang || "__default"}`
}

export function captionStyleForTrack(role = "default", lang = "") {
  if (!lang) return baseStyleForRole(role)
  const key = trackStyleKey(role, lang)
  if (!captionStylesByTrack.has(key)) {
    captionStylesByTrack.set(key, cloneStyle(baseStyleForRole(role)))
  }
  return captionStylesByTrack.get(key)
}

export function captionStyleForRole(role = "default", lang = "") {
  return captionStyleForTrack(role, lang)
}

const POSITION_POINTS: Record<string, { x: number; y: number }> = {
  top: { x: 50, y: 8 },
  middle: { x: 50, y: 50 },
  bottom: { x: 50, y: 92 },
}

const CUSTOM_GUIDES = {
  x: 50,
  top: 12,
  middle: 50,
  bottom: 88,
}
// In screen pixels, so the pull feels the same at any preview size.
const SNAP_DISTANCE_PX = 6
const CAPTION_SIZE_MIN = 0.7
const CAPTION_SIZE_MAX = 1.6
const CAPTION_RESIZE_HIT_SIZE = 22
// A language added next to another one is drawn a bit smaller, under it.
const SECONDARY_SIZE_RATIO = 0.85
// Space between captions stacked on the same spot, as a share of the video height.
export const CAPTION_STACK_GAP = 0.012

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

type StackAnchor = "top" | "middle" | "bottom"

// Captions anchored at the same spot (a preset position or the same custom
// point) stack instead of overlapping, with secondary tracks under the main one.
export function captionStackGroups<T>(items: T[], styleOf: (item: T) => any) {
  const groups = new Map<string, { anchor: StackAnchor; items: T[] }>()
  items.forEach((item) => {
    const s = styleOf(item)
    const custom = s.position === "custom"
    const position = custom || POSITION_POINTS[s.position] ? s.position : "bottom"
    const key = custom ? `custom:${s.customX}:${s.customY}` : position
    const group = groups.get(key) || {
      anchor: custom ? "middle" : position,
      items: [] as T[],
    }
    group.items.push(item)
    groups.set(key, group)
  })
  return [...groups.values()].map((group) => ({
    anchor: group.anchor,
    items: group.items.sort(
      (a, b) => Number(!!styleOf(a).secondary) - Number(!!styleOf(b).secondary),
    ),
  }))
}

/** Top of each item from the top of its stack, plus the stack's full height. */
export function captionStackLayout(heights: number[], gaps: number[]) {
  const tops: number[] = []
  let top = 0
  heights.forEach((height, index) => {
    if (index) top += gaps[index - 1] || 0
    tops.push(top)
    top += height
  })
  return { tops, total: top }
}

export function hexToRgba(hex: string, alpha = 1) {
  let h = String(hex || "#000000").replace("#", "")
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("")
  }
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function applyVisualStyle(el: HTMLElement, s: any) {
  el.style.fontFamily = FONT_STACKS[s.font] || FONT_STACKS.sans
  el.style.fontWeight = String(s.weight || 600)
  el.style.fontStyle = s.italic ? "italic" : "normal"
  el.style.textAlign = s.align || "center"
  el.style.color = s.color || "#ffffff"
  el.style.background = s.bgEnabled
    ? hexToRgba(s.bgColor, s.bgOpacity)
    : "transparent"
  el.style.textShadow = s.outline
    ? "0 1px 2px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.9)"
    : s.bgEnabled
      ? "none"
      : "0 1px 3px rgba(0,0,0,.85)"
  el.style.setProperty("--caption-word-color", s.color || "#ffffff")
}

type TrackRef = { role: string; lang: string }

export function createSubtitleStyleController({
  ui,
  I18N,
  langName,
  onSelectTrack,
}: {
  ui: any
  I18N: any
  langName: (code: string) => string
  /** A caption on the video was picked: its language becomes the one edited. */
  onSelectTrack?: (lang: string) => void
}) {
  let activePresetId = "default"
  let activeCaptionRole = "default"
  let activeCaptionLang = ""
  const presetIdsByTrack = new Map<string, string>()
  // Tracks on screen, offered in the style bar when there's more than one.
  let styleTracks: TrackRef[] = []
  let trackSwitchKey = ""
  let dragState: {
    el: HTMLElement
    role: string
    pointerId: number
    offsetX: number
    offsetY: number
    startClientX: number
    startClientY: number
    started: boolean
  } | null = null
  let resizeState: {
    el: HTMLElement
    pointerId: number
    startClientX: number
    startClientY: number
    startSize: number
    started: boolean
  } | null = null

  function captionBoxes() {
    return $$<HTMLElement>(".caption-box", ui.caption)
  }

  function captionLayerElements() {
    return [ui.caption, ui.captionGuides].filter(Boolean) as HTMLElement[]
  }

  // Captions render on every animation frame during playback, so these caches
  // let each frame skip DOM writes and layout reads when nothing changed.
  let layerBoundsKey = ""
  let styleVersion = 1
  const captionBoxMap = new Map<string, HTMLElement>()
  const captionTextCache = new WeakMap<
    HTMLElement,
    { key: string; sourceWords?: SubtitleWord[]; words?: Array<{ start: number; text: string }> }
  >()
  const captionStyleVersion = new WeakMap<HTMLElement, number>()

  function syncCaptionLayerBounds() {
    const previewRect = ui.videoPreview.getBoundingClientRect()
    const videoWidth = Number(ui.video?.videoWidth) || 0
    const videoHeight = Number(ui.video?.videoHeight) || 0
    let left = 0
    let top = 0
    let width = previewRect.width
    let height = previewRect.height

    if (previewRect.width && previewRect.height && videoWidth && videoHeight) {
      const previewRatio = previewRect.width / previewRect.height
      const videoRatio = videoWidth / videoHeight

      if (previewRatio > videoRatio) {
        height = previewRect.height
        width = height * videoRatio
        left = (previewRect.width - width) / 2
      } else {
        width = previewRect.width
        height = width / videoRatio
        top = (previewRect.height - height) / 2
      }
    }

    const boundsKey = `${left}|${top}|${width}|${height}`
    if (boundsKey === layerBoundsKey) return
    layerBoundsKey = boundsKey

    captionLayerElements().forEach((layer) => {
      layer.style.left = `${left}px`
      layer.style.top = `${top}px`
      layer.style.right = "auto"
      layer.style.bottom = "auto"
      layer.style.width = `${width}px`
      layer.style.height = `${height}px`
    })
    // Font sizes follow the viewport, so stacked captions need new offsets.
    stackCaptionBoxes()
  }

  const stackOffsets = new WeakMap<HTMLElement, number>()

  function setStackOffset(box: HTMLElement, offset: number) {
    const rounded = Math.round(offset)
    if (stackOffsets.get(box) === rounded) return
    stackOffsets.set(box, rounded)
    box.style.setProperty("--caption-stack", `${rounded}px`)
  }

  // Each box keeps its own anchor in CSS; this only shifts boxes that share
  // one, so a lone caption never pays for a layout read.
  function stackCaptionBoxes() {
    const visible = captionBoxes().filter((box) => !box.hidden)
    const gap = (ui.caption.clientHeight || 0) * CAPTION_STACK_GAP
    captionStackGroups(visible, boxStyle).forEach(({ anchor, items }) => {
      if (items.length < 2) {
        items.forEach((box) => setStackOffset(box, 0))
        return
      }
      const heights = items.map((box) => box.offsetHeight)
      const { tops, total } = captionStackLayout(
        heights,
        heights.map(() => gap),
      )
      items.forEach((box, index) => {
        const height = heights[index]
        setStackOffset(
          box,
          anchor === "top"
            ? tops[index]
            : anchor === "bottom"
              ? tops[index] + height - total
              : tops[index] + height / 2 - total / 2,
        )
      })
    })
  }

  function captionLayerRect() {
    syncCaptionLayerBounds()
    const rect = ui.caption.getBoundingClientRect()
    if (rect.width && rect.height) return rect
    return ui.videoPreview.getBoundingClientRect()
  }

  function activeStyle() {
    return captionStyleForTrack(activeCaptionRole, activeCaptionLang)
  }

  function boxStyle(el: HTMLElement) {
    return captionStyleForTrack(el.dataset.role || "default", el.dataset.lang || "")
  }

  function setActiveCaptionTrack(role = "default", lang = "") {
    activeCaptionRole = role || "default"
    activeCaptionLang = lang || ""
    activePresetId = presetIdsByTrack.get(trackStyleKey(activeCaptionRole, activeCaptionLang)) ?? "default"
    renderTrackSwitch()
  }

  function renderTrackSwitch() {
    if (!ui.styleTrack) return
    const activeKey = trackStyleKey(activeCaptionRole, activeCaptionLang)
    const key = `${styleTracks.map((t) => trackStyleKey(t.role, t.lang)).join("|")}>${activeKey}`
    if (key === trackSwitchKey) return
    trackSwitchKey = key
    ui.styleTrack.hidden = styleTracks.length < 2
    ui.styleTrack.replaceChildren(
      ...styleTracks.map((track) => {
        const on = trackStyleKey(track.role, track.lang) === activeKey
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = on ? "is-on" : ""
        btn.setAttribute("aria-pressed", String(on))
        btn.textContent = langName(track.lang)
        btn.addEventListener("click", () => setActiveTrack(track.role, track.lang))
        return btn
      }),
    )
  }

  function inheritTrackStyle(from: TrackRef, to: TrackRef) {
    Object.assign(
      captionStyleForTrack(to.role, to.lang),
      cloneStyle(captionStyleForTrack(from.role, from.lang)),
    )
    const presetId = presetIdsByTrack.get(trackStyleKey(from.role, from.lang))
    if (presetId !== undefined) presetIdsByTrack.set(trackStyleKey(to.role, to.lang), presetId)
  }

  // A language added next to the one on screen: that one keeps its look and
  // the new one shares its spot, stacked under it and a bit smaller.
  function stackSecondaryTrack(from: TrackRef, main: TrackRef, secondary: TrackRef) {
    inheritTrackStyle(from, main)
    inheritTrackStyle(from, secondary)
    const style = captionStyleForTrack(secondary.role, secondary.lang)
    style.secondary = true
    style.size = clamp(
      Math.round((Number(style.size) || 1) * SECONDARY_SIZE_RATIO * 100) / 100,
      CAPTION_SIZE_MIN,
      CAPTION_SIZE_MAX,
    )
    presetIdsByTrack.set(trackStyleKey(secondary.role, secondary.lang), "")
    applyCaptionStyle()
  }

  function isSecondaryTrack(role = "default", lang = "") {
    return !!captionStyleForTrack(role, lang).secondary
  }

  function setActiveCaptionFromBox(box: HTMLElement) {
    setActiveCaptionTrack(box.dataset.role || "default", box.dataset.lang || "")
    if (box.dataset.lang) onSelectTrack?.(box.dataset.lang)
  }

  function setActivePresetId(id: string) {
    activePresetId = id
    presetIdsByTrack.set(trackStyleKey(activeCaptionRole, activeCaptionLang), id)
  }

  function applyCaptionStyle() {
    styleVersion += 1
    captionBoxes().forEach((box) => applyCaptionBoxStyle(box))
    stackCaptionBoxes()
  }

  function setWordHighlightForTracks(
    tracks: Array<{ role?: string; lang?: string }>,
    enabled: boolean,
  ) {
    tracks.forEach((track) => {
      captionStyleForTrack(track.role || "default", track.lang || "").wordHighlight =
        enabled
    })
    applyCaptionStyle()
  }

  function setWordHighlightForAll(enabled: boolean) {
    captionStyle.wordHighlight = enabled
    transcriptionCaptionStyle.wordHighlight = enabled
    captionStylesByTrack.forEach((style) => {
      style.wordHighlight = enabled
    })
    applyCaptionStyle()
  }

  function renderCaptionText(box: HTMLElement, track: any, time: number): boolean {
    const style = boxStyle(box)
    const cached = captionTextCache.get(box)
    box.classList.toggle("is-word-highlight", !!style.wordHighlight)
    if (!style.wordHighlight || !track.segment) {
      const key = `text:${track.text}`
      if (cached?.key !== key) {
        box.textContent = track.text
        captionTextCache.set(box, { key })
        return true
      }
      return false
    }

    const { start, end } = track.segment
    const key = `words:${start}:${end}:${track.text}`
    let words = cached?.key === key && cached.sourceWords === track.segment.words ? cached.words : undefined
    let layoutChanged = false
    if (!words) {
      layoutChanged = true
      words = estimatedWordsForSegment(track.segment)
      if (words.length) {
        box.replaceChildren()
        words.forEach((word, index) => {
          if (index > 0) box.append(document.createTextNode(" "))
          const span = document.createElement("span")
          span.className = "caption-word"
          span.textContent = word.text
          box.append(span)
        })
      } else {
        box.textContent = track.text
      }
      captionTextCache.set(box, { key, words, sourceWords: track.segment.words })
    }

    // Same line as last frame: only advance the spoken highlight.
    const spans = box.children
    words.forEach((word, index) => {
      spans[index]?.classList.toggle("is-spoken", time >= word.start)
    })
    return layoutChanged
  }

  function applyCaptionBoxStyle(box: HTMLElement) {
    const c = boxStyle(box)
    applyVisualStyle(box, c)
    box.style.fontSize = `clamp(${Math.round(13 * c.size)}px, ${(
      2.4 * c.size
    ).toFixed(2)}vw, ${Math.round(28 * c.size)}px)`
    box.style.padding = c.bgEnabled ? "0.22rem 0.6rem" : "0"
    box.style.left = "50%"
    box.style.top = "auto"
    box.style.bottom = "auto"
    // --caption-stack moves a caption off a spot it shares with another one.
    if (c.position === "custom") {
      box.style.left = `${clamp(Number(c.customX) || 50, 0, 100)}%`
      box.style.top = `${clamp(Number(c.customY) || 50, 0, 100)}%`
      box.style.transform = "translate(-50%, calc(-50% + var(--caption-stack, 0px)))"
    } else {
      const position = POSITION_POINTS[c.position] ? c.position : "bottom"
      const point = POSITION_POINTS[position]
      box.style.left = `${point.x}%`
      box.style.top = `${point.y}%`
      box.style.transform =
        position === "top"
          ? "translate(-50%, var(--caption-stack, 0px))"
          : position === "bottom"
            ? "translate(-50%, calc(-100% + var(--caption-stack, 0px)))"
            : "translate(-50%, calc(-50% + var(--caption-stack, 0px)))"
    }
    captionStyleVersion.set(box, styleVersion)
  }

  function captionCenterPercent(el: HTMLElement) {
    const previewRect = captionLayerRect()
    const captionRect = el.getBoundingClientRect()
    if (!previewRect.width || !previewRect.height) {
      const style = boxStyle(el)
      return { x: Number(style.customX) || 50, y: Number(style.customY) || 88 }
    }
    return {
      x:
        ((captionRect.left + captionRect.width / 2 - previewRect.left) /
          previewRect.width) *
        100,
      y:
        ((captionRect.top + captionRect.height / 2 - previewRect.top) /
          previewRect.height) *
        100,
    }
  }

  function clampCaptionPoint(el: HTMLElement, x: number, y: number) {
    const previewRect = captionLayerRect()
    const captionRect = el.getBoundingClientRect()
    const halfX = previewRect.width
      ? (captionRect.width / 2 / previewRect.width) * 100
      : 0
    const halfY = previewRect.height
      ? (captionRect.height / 2 / previewRect.height) * 100
      : 0
    return {
      x: clamp(x, halfX, 100 - halfX),
      y: clamp(y, halfY, 100 - halfY),
    }
  }

  function snapCaptionPoint(el: HTMLElement, point: { x: number; y: number }) {
    let x = point.x
    let y = point.y
    let snapX = false
    let snapY = ""
    const layer = captionLayerRect()
    const distanceX = layer.width ? (SNAP_DISTANCE_PX / layer.width) * 100 : 0
    const distanceY = layer.height ? (SNAP_DISTANCE_PX / layer.height) * 100 : 0

    if (Math.abs(x - CUSTOM_GUIDES.x) <= distanceX) {
      x = CUSTOM_GUIDES.x
      snapX = true
    }

    const yGuides = [
      ["top", CUSTOM_GUIDES.top],
      ["middle", CUSTOM_GUIDES.middle],
      ["bottom", CUSTOM_GUIDES.bottom],
    ] as const
    const nearestY = yGuides.find(([, value]) => Math.abs(y - value) <= distanceY)
    if (nearestY) {
      snapY = nearestY[0]
      y = nearestY[1]
    }

    return { point: clampCaptionPoint(el, x, y), snapX, snapY }
  }

  function updateGuides(snapX = false, snapY = "") {
    ui.captionGuides.hidden = !dragState
    ui.captionGuides.classList.toggle("show-x", snapX)
    ui.captionGuides.classList.toggle("show-top", snapY === "top")
    ui.captionGuides.classList.toggle("show-middle", snapY === "middle")
    ui.captionGuides.classList.toggle("show-bottom", snapY === "bottom")
  }

  function setCustomCaptionPosition(
    el: HTMLElement,
    x: number,
    y: number,
    syncControls = false,
  ) {
    const style = boxStyle(el)
    const point = clampCaptionPoint(el, x, y)
    style.position = "custom"
    style.customX = point.x
    style.customY = point.y
    setActivePresetId("")
    applyCaptionBoxStyle(el)
    stackCaptionBoxes()
    if (syncControls) {
      syncStyleControls()
      renderPresets()
    }
  }

  function pointerPoint(event: PointerEvent) {
    const previewRect = captionLayerRect()
    const x =
      ((event.clientX - dragState!.offsetX - previewRect.left) / previewRect.width) *
      100
    const y =
      ((event.clientY - dragState!.offsetY - previewRect.top) / previewRect.height) *
      100
    return clampCaptionPoint(dragState!.el, x, y)
  }

  function isCaptionResizeHit(event: PointerEvent, box: HTMLElement) {
    const rect = box.getBoundingClientRect()
    return (
      event.clientX >= rect.right - CAPTION_RESIZE_HIT_SIZE &&
      event.clientY >= rect.bottom - CAPTION_RESIZE_HIT_SIZE
    )
  }

  function startCaptionResize(event: PointerEvent, box: HTMLElement) {
    const previewRect = ui.videoPreview.getBoundingClientRect()
    if (!previewRect.width || !previewRect.height) return

    event.preventDefault()
    setActiveCaptionFromBox(box)
    syncStyleControls()
    resizeState = {
      el: box,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSize: Number(boxStyle(box).size) || 1,
      started: false,
    }
    ui.videoPreview.classList.add("is-caption-resizing")
    box.setPointerCapture?.(event.pointerId)
    box.focus({ preventScroll: true })
  }

  function moveCaptionResize(event: PointerEvent) {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return
    event.preventDefault()

    const moved =
      Math.abs(event.clientX - resizeState.startClientX) > 2 ||
      Math.abs(event.clientY - resizeState.startClientY) > 2
    if (!resizeState.started && !moved) return
    if (!resizeState.started) {
      resizeState.started = true
      setActivePresetId("")
      renderPresets()
    }

    const previewRect = ui.videoPreview.getBoundingClientRect()
    const base = Math.max(1, Math.min(previewRect.width, previewRect.height))
    const diagonalDelta =
      (event.clientX - resizeState.startClientX + event.clientY - resizeState.startClientY) /
      base
    const style = boxStyle(resizeState.el)
    style.size = clamp(
      resizeState.startSize + diagonalDelta * 2.25,
      CAPTION_SIZE_MIN,
      CAPTION_SIZE_MAX,
    )
    applyCaptionBoxStyle(resizeState.el)
    stackCaptionBoxes()
    syncStyleControls()
  }

  function endCaptionResize(event: PointerEvent) {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return
    resizeState.el.releasePointerCapture?.(event.pointerId)
    resizeState = null
    ui.videoPreview.classList.remove("is-caption-resizing")
    syncStyleControls()
  }

  function startCaptionDrag(event: PointerEvent) {
    const box = (event.target as Element).closest(".caption-box") as HTMLElement
    if (event.button !== 0 || !box?.textContent?.trim()) return
    if (isCaptionResizeHit(event, box)) {
      startCaptionResize(event, box)
      return
    }
    const previewRect = ui.videoPreview.getBoundingClientRect()
    const captionRect = box.getBoundingClientRect()
    if (!previewRect.width || !previewRect.height) return

    event.preventDefault()
    setActiveCaptionFromBox(box)
    syncStyleControls()
    const centerX = captionRect.left + captionRect.width / 2
    const centerY = captionRect.top + captionRect.height / 2
    dragState = {
      el: box,
      role: activeCaptionRole,
      pointerId: event.pointerId,
      offsetX: event.clientX - centerX,
      offsetY: event.clientY - centerY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      started: false,
    }
    box.setPointerCapture?.(event.pointerId)
    box.focus({ preventScroll: true })
  }

  function moveCaptionDrag(event: PointerEvent) {
    if (resizeState) {
      moveCaptionResize(event)
      return
    }
    if (!dragState || event.pointerId !== dragState.pointerId) return
    const moved =
      Math.abs(event.clientX - dragState.startClientX) > 3 ||
      Math.abs(event.clientY - dragState.startClientY) > 3
    if (!dragState.started && !moved) return
    if (!dragState.started) {
      dragState.started = true
      ui.videoPreview.classList.add("is-caption-dragging")
      const point = captionCenterPercent(dragState.el)
      setCustomCaptionPosition(dragState.el, point.x, point.y, true)
      updateGuides()
    }
    const snapped = snapCaptionPoint(dragState.el, pointerPoint(event))
    const style = boxStyle(dragState.el)
    style.customX = snapped.point.x
    style.customY = snapped.point.y
    applyCaptionBoxStyle(dragState.el)
    updateGuides(snapped.snapX, snapped.snapY)
  }

  function endCaptionDrag(event: PointerEvent) {
    if (resizeState) {
      endCaptionResize(event)
      return
    }
    if (!dragState || event.pointerId !== dragState.pointerId) return
    dragState.el.releasePointerCapture?.(event.pointerId)
    const dragged = dragState.started
    dragState = null
    if (dragged) {
      ui.videoPreview.classList.remove("is-caption-dragging")
      updateGuides()
      syncStyleControls()
    }
  }

  function moveCaptionWithKeyboard(event: KeyboardEvent) {
    const box = (event.target as Element).closest(".caption-box") as HTMLElement
    if (!box) return
    setActiveCaptionFromBox(box)
    const style = boxStyle(box)
    const delta = event.shiftKey ? 5 : 1
    const point =
      style.position === "custom"
        ? {
            x: Number(style.customX) || 50,
            y: Number(style.customY) || 88,
          }
        : captionCenterPercent(box)

    if (event.key === "ArrowLeft") point.x -= delta
    else if (event.key === "ArrowRight") point.x += delta
    else if (event.key === "ArrowUp") point.y -= delta
    else if (event.key === "ArrowDown") point.y += delta
    else return

    event.preventDefault()
    setCustomCaptionPosition(box, point.x, point.y, true)
  }

  function setPresetPosition(position: string) {
    const targetBox =
      captionBoxes().find(
        (box) =>
          (box.dataset.role || "default") === activeCaptionRole &&
          (box.dataset.lang || "") === activeCaptionLang,
      ) ||
      captionBoxes()[0]
    if (position === "custom") {
      if (!targetBox) return
      const point = captionCenterPercent(targetBox)
      setCustomCaptionPosition(targetBox, point.x, point.y, true)
      return
    }

    activeStyle().position = position
    syncStyleControls()
    applyCaptionStyle()
  }

  function setActiveTrack(role = "default", lang = "") {
    setActiveCaptionTrack(role, lang)
    syncStyleControls()
    renderPresets()
  }

  function renderCaptions(
    tracks: Array<{
      lang: string
      label: string
      role?: string
      text: string
      segment?: any
    }>,
    time = 0,
  ) {
    // Layer bounds are kept in sync by the resize/metadata listeners.
    const wanted = new Set<string>()
    let needsStack = false

    tracks.forEach((track) => {
      const role = track.role || "default"
      const key = `${role}:${track.lang}`
      wanted.add(key)

      let box = captionBoxMap.get(key) ?? null
      if (!box || !box.isConnected) {
        box = document.createElement("div")
        box.className = `caption-box caption-box--${role}`
        box.dataset.key = key
        box.dataset.role = role
        box.dataset.lang = track.lang
        box.role = "button"
        box.tabIndex = 0
        ui.caption.appendChild(box)
        captionBoxMap.set(key, box)
        needsStack = true
      }

      if (renderCaptionText(box, track, time)) needsStack = true
      const hidden = !track.text.trim()
      if (box.hidden !== hidden) {
        box.hidden = hidden
        needsStack = true
      }
      const label = `${track.label}. ${ui.caption.dataset.dragLabel || ""}`.trim()
      if (box.getAttribute("aria-label") !== label)
        box.setAttribute("aria-label", label)
      if (captionStyleVersion.get(box) !== styleVersion) {
        applyCaptionBoxStyle(box)
        needsStack = true
      }
    })

    for (const [key, box] of captionBoxMap) {
      if (!wanted.has(key)) {
        box.remove()
        captionBoxMap.delete(key)
        needsStack = true
      }
    }
    if (needsStack) stackCaptionBoxes()
    styleTracks = tracks.map((track) => ({ role: track.role || "default", lang: track.lang }))
    renderTrackSwitch()

    const activeTrackVisible = tracks.some(
      (track) =>
        (track.role || "default") === activeCaptionRole &&
        (track.lang || "") === activeCaptionLang,
    )
    if (tracks.length && !activeTrackVisible) {
      const nextTrack =
        tracks.find((track) => (track.role || "default") === "subtitles") ||
        tracks[0]
      setActiveCaptionTrack(nextTrack.role || "default", nextTrack.lang || "")
      syncStyleControls()
      renderPresets()
    }
  }

  function renderPresets() {
    ui.stylePresets.innerHTML = ""
    CAPTION_PRESETS.forEach((p) => {
      const on = p.id === activePresetId
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "preset" + (on ? " is-on" : "")
      btn.setAttribute("role", "tab")
      btn.setAttribute("aria-selected", on ? "true" : "false")
      const presetName = I18N.presets?.[p.id] || p.name
      btn.title = presetName

      const prev = document.createElement("span")
      prev.className = "preset-prev"
      const inner = document.createElement("span")
      inner.textContent = "Aa"
      applyVisualStyle(inner, p.s)
      inner.style.padding = p.s.bgEnabled ? "1px 6px" : "0"
      inner.style.borderRadius = "4px"
      inner.style.fontSize = "13px"
      prev.appendChild(inner)

      const name = document.createElement("span")
      name.className = "preset-name"
      name.textContent = presetName

      btn.append(prev, name)
      btn.addEventListener("click", () => applyPreset(p))
      ui.stylePresets.appendChild(btn)
    })
  }

  function applyPreset(p: any) {
    Object.assign(activeStyle(), p.s)
    setActivePresetId(p.id)
    applyCaptionStyle()
    syncStyleControls()
    renderPresets()
  }

  function syncStyleControls() {
    const c = activeStyle()
    ui.csFont.value = c.font
    ui.csSize.value = String(c.size)
    ui.csColor.value = c.color
    ui.csBold.checked = c.weight >= 700
    ui.csItalic.checked = !!c.italic
    ui.csOutline.checked = !!c.outline
    ui.csWordHighlight.checked = !!c.wordHighlight
    ui.csBg.checked = !!c.bgEnabled
    ui.csBgColor.value = c.bgColor
    ui.csBgOpacity.value = String(c.bgOpacity)
    ui.csBgColor.disabled = !c.bgEnabled
    ui.csBgOpacity.disabled = !c.bgEnabled
    $$("button", ui.csPosition).forEach((b) => {
      b.classList.toggle("is-on", b.dataset.pos === c.position)
    })
    $$("button", ui.csAlign).forEach((b) => {
      b.classList.toggle("is-on", b.dataset.align === (c.align || "center"))
    })
  }

  function onManualStyleChange() {
    setActivePresetId("")
    applyCaptionStyle()
    renderPresets()
  }

  function wireStyleControls() {
    syncCaptionLayerBounds()
    ui.video.addEventListener("loadedmetadata", syncCaptionLayerBounds)
    ui.video.addEventListener("loadeddata", syncCaptionLayerBounds)
    window.addEventListener("resize", syncCaptionLayerBounds)
    if ("ResizeObserver" in window) {
      new ResizeObserver(syncCaptionLayerBounds).observe(ui.videoPreview)
    }

    ui.styleToggle.addEventListener("click", () => {
      const open = ui.styleControls.hidden
      ui.styleControls.hidden = !open
      ui.styleToggle.setAttribute("aria-expanded", String(open))
      ui.styleToggle.classList.toggle("is-open", open)
    })
    ui.csFont.addEventListener("change", () => {
      activeStyle().font = ui.csFont.value
      onManualStyleChange()
    })
    ui.csSize.addEventListener("input", () => {
      activeStyle().size = Number(ui.csSize.value)
      onManualStyleChange()
    })
    ui.csColor.addEventListener("input", () => {
      activeStyle().color = ui.csColor.value
      onManualStyleChange()
    })
    ui.csBold.addEventListener("change", () => {
      activeStyle().weight = ui.csBold.checked ? 700 : 600
      onManualStyleChange()
    })
    ui.csItalic.addEventListener("change", () => {
      activeStyle().italic = ui.csItalic.checked
      onManualStyleChange()
    })
    ui.csOutline.addEventListener("change", () => {
      activeStyle().outline = ui.csOutline.checked
      onManualStyleChange()
    })
    ui.csWordHighlight.addEventListener("change", () => {
      setWordHighlightForAll(ui.csWordHighlight.checked)
      onManualStyleChange()
      ui.video.dispatchEvent(new Event("timeupdate"))
    })
    ui.csBg.addEventListener("change", () => {
      activeStyle().bgEnabled = ui.csBg.checked
      syncStyleControls()
      onManualStyleChange()
    })
    ui.csBgColor.addEventListener("input", () => {
      activeStyle().bgColor = ui.csBgColor.value
      onManualStyleChange()
    })
    ui.csBgOpacity.addEventListener("input", () => {
      activeStyle().bgOpacity = Number(ui.csBgOpacity.value)
      onManualStyleChange()
    })
    ui.csPosition.addEventListener("click", (e: Event) => {
      const b = (e.target as Element).closest("button[data-pos]") as HTMLElement
      if (!b) return
      setPresetPosition(b.dataset.pos || "bottom")
    })
    ui.csAlign.addEventListener("click", (e: Event) => {
      const b = (e.target as Element).closest("button[data-align]") as HTMLElement
      if (!b) return
      activeStyle().align = b.dataset.align || "center"
      onManualStyleChange()
      syncStyleControls()
    })
    ui.caption.addEventListener("pointerdown", startCaptionDrag)
    ui.caption.addEventListener("pointermove", moveCaptionDrag)
    ui.caption.addEventListener("pointerup", endCaptionDrag)
    ui.caption.addEventListener("pointercancel", endCaptionDrag)
    ui.caption.addEventListener("keydown", moveCaptionWithKeyboard)
    ui.caption.addEventListener("focusin", (event: FocusEvent) => {
      const box = (event.target as Element).closest(".caption-box") as HTMLElement
      if (!box) return
      setActiveCaptionFromBox(box)
      syncStyleControls()
      renderPresets()
    })
  }

  return {
    applyCaptionStyle,
    inheritTrackStyle,
    isSecondaryTrack,
    renderCaptions,
    renderPresets,
    setWordHighlightForAll,
    setWordHighlightForTracks,
    setActiveTrack,
    stackSecondaryTrack,
    syncStyleControls,
    wireStyleControls,
  }
}
