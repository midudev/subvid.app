import { cutAt, type TimeRange } from "@/scripts/cuts.ts"
import { $, $$ } from "@/scripts/dom.ts"
import {
  findSegmentIndexAt,
  formatClock,
  MIN_SUBTITLE_DURATION,
  wordsForDraggedBlock,
  type SubtitleWord,
} from "@/scripts/subtitles.ts"
import { peakBetween, type Waveform } from "@/scripts/waveform.ts"

type TimelineTrack = {
  lang: string
  label: string
  role?: string
  segments: any[]
  hidden?: boolean
  locked?: boolean
}

type CaptionTrack = {
  lang: string
  label: string
  role?: string
  text: string
  segment?: any
}

type TimelineOptions = {
  ui: any
  tt?: (path: string, vars?: Record<string, unknown>) => string
  currentSegments: () => any[]
  visibleTracks?: () => TimelineTrack[]
  activeLang?: () => string
  setActiveLang?: (lang: string) => void
  renderTabs?: () => void
  renderCaptions?: (tracks: CaptionTrack[], time: number) => void
  toggleTrackHidden?: (lang: string) => void
  toggleTrackLocked?: (lang: string) => void
  snapshotSegments: () => string
  pushHistory: (snapshotBefore: string) => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  /** Parts of the video cut in the transcript: dimmed here, skipped on playback. */
  cutRanges?: () => TimeRange[]
  onActiveSegment?: (index: number, lang: string, scroll: boolean) => void
  onPlaybackTime?: (time: number) => void
}

export function createTimelineController(options: TimelineOptions) {
  const {
    ui,
    tt,
    currentSegments,
    visibleTracks,
    activeLang,
    setActiveLang,
    renderTabs,
    renderCaptions,
    toggleTrackHidden,
    toggleTrackLocked,
    snapshotSegments,
    pushHistory,
    renderSegments,
    enableExports,
    cutRanges = () => [],
    onActiveSegment,
    onPlaybackTime,
  } = options
  const TL_HEADER_H = 40
  const TL_WAVE_TOP = 30
  const TL_WAVE_H = 44
  const TL_WAVE_BAR = 2
  const TL_WAVE_STEP = 3
  const TL_ROW_H = 72
  const TL_SCROLL_PAD = 22
  const TL_MIN_ZOOM = 12
  const TL_MAX_ZOOM = 400
  const PLAYBACK_RATES = [1, 1.5, 2]
  const SCRUB_SEEK_MIN_INTERVAL = 45
  const SCRUB_SEEK_EPSILON = 0.025
  let tlPxPerSec = 90
  let tlDrag: any = null
  let scrubbing = false
  let scrubRaf = 0
  let scrubSeekRaf = 0
  let scrubSeekTimer = 0
  let scrubTargetT = 0
  let scrubResumePlayback = false
  let lastScrubSeekAt = 0
  let playheadRaf = 0
  let phAnchorMedia = 0
  let phAnchorWall = 0
  let waveform: Waveform | null = null
  let waveRaf = 0
  let waveColor = ""
  let lastClockText = ""

  function escapeHtml(value: string) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  function t(path: string, fallback: string, vars?: Record<string, unknown>) {
    return tt?.(path, vars) || fallback
  }

  function getTracks() {
    const tracks = visibleTracks?.().filter((track) => track.segments.length) || []
    if (tracks.length) return tracks
    return [
      {
        lang: activeLang?.() || "",
        label: "",
        segments: currentSegments(),
      },
    ]
  }

  function segmentsForLang(lang: string) {
    return getTracks().find((track) => track.lang === lang)?.segments || currentSegments()
  }

  function trackForLang(lang: string) {
    return getTracks().find((track) => track.lang === lang)
  }

  function activeTrackLang() {
    return activeLang?.() || getTracks()[0]?.lang || ""
  }

  function activateTrack(lang: string) {
    if (!lang || activeTrackLang() === lang) return
    setActiveLang?.(lang)
    renderTabs?.()
  }

  function blurActiveEditable() {
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      (active.matches("input, textarea") || active.isContentEditable)
    ) {
      active.blur()
    }
  }

  function segmentSeekTime(seg: any) {
    const start = Math.max(0, Number(seg?.start) || 0)
    const end = Number.isFinite(seg?.end) ? Number(seg.end) : start + 0.5
    return Math.min(start + 0.001, Math.max(start, end - 0.001))
  }

  function mediaDuration(): number {
    const duration = ui.video.duration
    // Browser recordings can lack a duration header. The decoded audio is timed.
    return Number.isFinite(duration) && duration > 0 ? duration : waveform?.duration ?? 0
  }

  function tlTotalDuration() {
    const segEnd = getTracks().reduce((max, track) => {
      const last = track.segments[track.segments.length - 1]
      return Math.max(max, last?.end || 0)
    }, 0)
    return Math.max(mediaDuration(), segEnd, 1)
  }

  function renderRuler(dur: number) {
    let step = 1
    if (tlPxPerSec < 24) step = 15
    else if (tlPxPerSec < 45) step = 10
    else if (tlPxPerSec < 80) step = 5
    else if (tlPxPerSec < 140) step = 2
    else step = 1
    let ruler = ""
    for (let t = 0; t <= dur + 0.001; t += step) {
      const left = t * tlPxPerSec
      ruler += `<span class="tl-tick" style="left:${left}px"><i></i><b>${formatClock(t)}</b></span>`
    }
    ui.timelineRuler.innerHTML = ruler
  }

  function renderTimeline() {
    if (!ui.timelineBlocks) return
    const tracks = getTracks()
    const dur = tlTotalDuration()
    ui.timelineTrack.style.width = `${dur * tlPxPerSec}px`
    ui.timeline?.classList.toggle("is-multitrack", tracks.length > 1)
    const headerHeight = waveform ? TL_WAVE_TOP + TL_WAVE_H + 4 : TL_HEADER_H
    const blocksHeight = tracks.length * TL_ROW_H
    ui.timelineBlocks.style.top = `${headerHeight}px`
    ui.timelineBlocks.style.height = `${blocksHeight}px`
    ui.timelineTrack.style.height = `${headerHeight + blocksHeight}px`
    ui.timelineScroll.style.height = `${headerHeight + blocksHeight + TL_SCROLL_PAD}px`
    ui.timeline?.classList.toggle("has-wave", !!waveform)

    renderRuler(dur)

    const fragment = document.createDocumentFragment()
    tracks.forEach((track, trackIndex) => {
      const row = document.createElement("div")
      row.className = "tl-track-row"
      row.dataset.lang = track.lang
      row.classList.toggle("is-hidden", !!track.hidden)
      row.classList.toggle("is-locked", !!track.locked)
      row.style.top = `${trackIndex * TL_ROW_H}px`
      if (track.label) {
        const controls = document.createElement("div")
        controls.className = "tl-track-controls"
        controls.innerHTML = `
          <button class="tl-track-btn" type="button" data-action="visibility" aria-pressed="${track.hidden ? "true" : "false"}" title="${escapeHtml(track.hidden ? t("trackShow", "Show track") : t("trackHide", "Hide track"))}" aria-label="${escapeHtml(track.hidden ? t("trackShow", "Show track") : t("trackHide", "Hide track"))}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="1.8"/></svg>
          </button>
          <button class="tl-track-btn" type="button" data-action="lock" aria-pressed="${track.locked ? "true" : "false"}" title="${escapeHtml(track.locked ? t("trackUnlock", "Unlock track") : t("trackLock", "Lock track"))}" aria-label="${escapeHtml(track.locked ? t("trackUnlock", "Unlock track") : t("trackLock", "Lock track"))}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5.7a3.5 3.5 0 0 1 7 0V7"/><rect x="3.5" y="7" width="9" height="6.5" rx="1.4"/></svg>
          </button>
          <span class="tl-track-label">${escapeHtml(track.label)}</span>
        `
        row.appendChild(controls)
      }
      track.segments.forEach((seg, index) => {
        const block = document.createElement("div")
        block.className = "tl-block"
        if (!seg.text?.trim() && seg.words?.some((word: SubtitleWord) => word.cut))
          block.classList.add("is-cut")
        block.classList.toggle("is-hidden", !!track.hidden)
        block.classList.toggle("is-locked", !!track.locked)
        block.dataset.lang = track.lang
        block.dataset.index = String(index)
        block.style.left = `${seg.start * tlPxPerSec}px`
        block.style.width = `${Math.max(MIN_SUBTITLE_DURATION, seg.end - seg.start) * tlPxPerSec}px`
        block.innerHTML = `
      <span class="tl-handle tl-handle-l" data-edge="start"></span>
      <span class="tl-block-label">${escapeHtml(seg.text || "—")}</span>
      <span class="tl-handle tl-handle-r" data-edge="end"></span>
    `
        row.appendChild(block)
      })
      fragment.appendChild(row)
    })
    ui.timelineBlocks.replaceChildren(fragment)
    renderCuts()
    drawWaveform()
    updateTimelinePlayhead()
  }

  function updateTimelineZoom() {
    if (!ui.timelineBlocks) return
    const tracks = getTracks()
    const dur = tlTotalDuration()
    ui.timelineTrack.style.width = `${dur * tlPxPerSec}px`
    renderRuler(dur)

    const segmentsByLang = new Map(tracks.map((track) => [track.lang, track.segments]))
    const blocks = ui.timelineBlocks.querySelectorAll<HTMLElement>(".tl-block")
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const seg = segmentsByLang.get(block.dataset.lang || "")?.[Number(block.dataset.index)]
      if (!seg) continue
      block.style.left = `${seg.start * tlPxPerSec}px`
      block.style.width = `${Math.max(MIN_SUBTITLE_DURATION, seg.end - seg.start) * tlPxPerSec}px`
    }

    renderCuts()
    scheduleDrawWaveform()
    updateTimelinePlayhead()
  }

  function renderCuts() {
    if (!ui.timelineCuts) return
    ui.timelineCuts.style.top = `${waveform ? TL_WAVE_TOP : TL_HEADER_H}px`
    ui.timelineCuts.innerHTML = cutRanges()
      .map(
        (range) =>
          `<span class="tl-cut" style="left:${range.start * tlPxPerSec}px;width:${Math.max(1, (range.end - range.start) * tlPxPerSec)}px"></span>`,
      )
      .join("")
  }

  // The canvas only covers the visible part of the timeline (it's sticky), so
  // long videos at high zoom never need a giant bitmap.
  function drawWaveform() {
    const canvas = ui.timelineWave as HTMLCanvasElement | null
    const view = ui.timelineScroll as HTMLElement | null
    if (!canvas || !view) return
    canvas.hidden = !waveform
    if (!waveform) return

    const width = view.clientWidth
    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(TL_WAVE_H * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      canvas.style.width = `${width}px`
      canvas.style.height = `${TL_WAVE_H}px`
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, TL_WAVE_H)
    if (!waveColor) waveColor = getComputedStyle(canvas).color
    ctx.fillStyle = waveColor

    const ranges = cutRanges()
    const mid = TL_WAVE_H / 2
    const scroll = view.scrollLeft
    // Bars sit on a fixed grid in timeline space so they don't shimmer on scroll.
    for (let x = -(scroll % TL_WAVE_STEP); x < width; x += TL_WAVE_STEP) {
      const from = (scroll + x) / tlPxPerSec
      if (from >= waveform.duration) break
      const to = (scroll + x + TL_WAVE_STEP) / tlPxPerSec
      const height = Math.max(1, peakBetween(waveform, from, to) * (mid - 2))
      ctx.globalAlpha = cutAt(ranges, (from + to) / 2) ? 0.28 : 1
      ctx.fillRect(x, mid - height, TL_WAVE_BAR, height * 2)
    }
    ctx.globalAlpha = 1
  }

  function scheduleDrawWaveform() {
    if (waveRaf) return
    waveRaf = requestAnimationFrame(() => {
      waveRaf = 0
      drawWaveform()
    })
  }

  function setWaveform(next: Waveform | null) {
    waveform = next
    renderTimeline()
  }

  function zoomTimeline(scale: number, anchorClientX?: number) {
    const nextPxPerSec = Math.max(
      TL_MIN_ZOOM,
      Math.min(TL_MAX_ZOOM, tlPxPerSec * scale),
    )
    if (nextPxPerSec === tlPxPerSec) return

    const view = ui.timelineScroll as HTMLElement | null
    let anchorTime: number | null = null
    let anchorOffset = 0
    if (view && typeof anchorClientX === "number") {
      const rect = view.getBoundingClientRect()
      anchorOffset = anchorClientX - rect.left
      anchorTime = (view.scrollLeft + anchorOffset) / tlPxPerSec
    }

    tlPxPerSec = nextPxPerSec
    updateTimelineZoom()

    if (view && anchorTime !== null) {
      view.scrollLeft = Math.max(0, anchorTime * tlPxPerSec - anchorOffset)
    }
  }

  function timelineWheelDeltaPx(event: WheelEvent) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
      return event.deltaY * (ui.timelineScroll?.clientHeight || window.innerHeight)
    return event.deltaY
  }

  function handleTimelineWheelZoom(event: WheelEvent) {
    if (!event.metaKey) return
    const deltaY = timelineWheelDeltaPx(event)
    if (!deltaY) return

    event.preventDefault()
    const clampedDelta = Math.max(-500, Math.min(500, deltaY))
    zoomTimeline(2 ** (-clampedDelta / 500), event.clientX)
  }

  function updateTimelinePlayhead(timeOverride?: number) {
    if (!ui.timelinePlayhead) return
    const t = timeOverride ?? ui.video.currentTime ?? 0
    const x = t * tlPxPerSec
    ui.timelinePlayhead.style.transform = `translate3d(${x}px,0,0)`
    if (ui.tlClock) {
      const nextClock = `${formatClock(t)} / ${formatClock(tlTotalDuration())}`
      if (nextClock !== lastClockText) {
        lastClockText = nextClock
        ui.tlClock.textContent = nextClock
      }
    }
    if (!ui.video.paused && ui.timelineScroll) {
      const view = ui.timelineScroll
      if (
        x < view.scrollLeft + 60 ||
        x > view.scrollLeft + view.clientWidth - 60
      ) {
        view.scrollLeft = x - view.clientWidth * 0.4
      }
    }
  }

  function setTimelineActive(idx: number, lang = activeTrackLang()) {
    if (!ui.timelineBlocks) return
    $$(".tl-block.is-active", ui.timelineBlocks).forEach((el) =>
      el.classList.remove("is-active"),
    )
    if (idx >= 0) {
      $(
        `.tl-block[data-lang="${lang}"][data-index="${idx}"]`,
        ui.timelineBlocks,
      )?.classList.add("is-active")
    }
  }

  function clearScrubSeekQueue() {
    if (scrubSeekRaf) {
      cancelAnimationFrame(scrubSeekRaf)
      scrubSeekRaf = 0
    }
    if (scrubSeekTimer) {
      window.clearTimeout(scrubSeekTimer)
      scrubSeekTimer = 0
    }
  }

  function setVideoTimeForScrub(time: number, force = false) {
    const video = ui.video as HTMLVideoElement
    const dur = tlTotalDuration()
    const target = Math.max(0, Math.min(dur, time))
    if (!force && Math.abs((video.currentTime || 0) - target) < SCRUB_SEEK_EPSILON)
      return

    video.currentTime = target
    lastScrubSeekAt = performance.now()
  }

  function scheduleScrubVideoSeek(force = false) {
    if (force) {
      clearScrubSeekQueue()
      setVideoTimeForScrub(scrubTargetT, true)
      return
    }
    if (!scrubbing) return
    if (ui.video.seeking) return
    if (
      Math.abs((ui.video.currentTime || 0) - scrubTargetT) < SCRUB_SEEK_EPSILON
    ) {
      return
    }

    const wait = Math.max(
      0,
      SCRUB_SEEK_MIN_INTERVAL - (performance.now() - lastScrubSeekAt),
    )
    if (wait > 0) {
      if (!scrubSeekTimer) {
        scrubSeekTimer = window.setTimeout(() => {
          scrubSeekTimer = 0
          scheduleScrubVideoSeek()
        }, wait)
      }
      return
    }

    if (scrubSeekRaf) return
    scrubSeekRaf = requestAnimationFrame(() => {
      scrubSeekRaf = 0
      if (!scrubbing || ui.video.seeking) return
      setVideoTimeForScrub(scrubTargetT)
    })
  }

  function scheduleScrubFrame() {
    if (scrubRaf) return
    scrubRaf = requestAnimationFrame(() => {
      scrubRaf = 0
      updateCaption(scrubTargetT)
      scheduleScrubVideoSeek()
    })
  }

  function scrubToClientX(clientX: number) {
    const rect = ui.timelineTrack.getBoundingClientRect()
    const dur = tlTotalDuration()
    const t = Math.max(0, Math.min(dur, (clientX - rect.left) / tlPxPerSec))
    scrubTargetT = t
    scheduleScrubFrame()
  }

  function beginScrub(event: PointerEvent) {
    blurActiveEditable()
    scrubbing = true
    scrubResumePlayback = !ui.video.paused
    if (scrubResumePlayback) ui.video.pause()
    cancelAnimationFrame(playheadRaf)
    playheadRaf = 0
    ui.timeline?.classList.add("is-scrubbing")
    ui.timelineTrack.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    scrubToClientX(event.clientX)
  }

  function endScrub() {
    if (!scrubbing) return
    scrubbing = false
    if (scrubRaf) {
      cancelAnimationFrame(scrubRaf)
      scrubRaf = 0
    }
    scheduleScrubVideoSeek(true)
    updateCaption()
    reanchorPlayhead()
    if (scrubResumePlayback) ui.video.play().catch(() => {})
    scrubResumePlayback = false
    ui.timeline?.classList.remove("is-scrubbing")
  }

  function endTimelineDrag() {
    if (!tlDrag) return
    const { block, moved, seg, index, lang, before } = tlDrag
    block.classList.remove("is-dragging")
    tlDrag = null
    if (moved) pushHistory(before)
    const segments = segmentsForLang(lang)
    segments.sort((a, b) => a.start - b.start)
    renderSegments()
    enableExports(true)
    if (!moved) {
      activateTrack(lang)
      ui.video.currentTime = segmentSeekTime(seg)
      const newIndex = segments.indexOf(seg)
      highlightSegment(newIndex >= 0 ? newIndex : index, {
        lang,
        scrollSidebar: true,
      })
    }
    updateCaption()
  }

  function togglePlay() {
    if (ui.video.paused) ui.video.play().catch(() => {})
    else ui.video.pause()
  }

  function reanchorPlayhead() {
    phAnchorMedia = ui.video.currentTime || 0
    phAnchorWall = performance.now()
  }

  function playheadLoop() {
    const real = ui.video.currentTime || 0
    const rate = ui.video.playbackRate || 1
    let predicted =
      phAnchorMedia + ((performance.now() - phAnchorWall) / 1000) * rate
    if (Math.abs(real - predicted) > 0.18 || real < predicted - 0.03) {
      reanchorPlayhead()
      predicted = real
    }
    // Jump over the cut parts, a frame early so they never show.
    const cut = cutAt(cutRanges(), predicted + 0.02 * rate)
    if (cut && !ui.video.paused) {
      ui.video.currentTime = Math.min(cut.end, ui.video.duration || cut.end)
      reanchorPlayhead()
      predicted = cut.end
    }
    updateCaption(Math.min(predicted, tlTotalDuration()))
    playheadRaf = requestAnimationFrame(playheadLoop)
  }

  function cyclePlaybackRate() {
    const index = PLAYBACK_RATES.indexOf(ui.video.playbackRate)
    const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length]
    // The default rate survives loading another video.
    ui.video.defaultPlaybackRate = next
    ui.video.playbackRate = next
  }

  function syncSpeedUi() {
    if (!ui.tlSpeed) return
    const rate = ui.video.playbackRate || 1
    ui.tlSpeed.textContent = `${rate}×`
    ui.tlSpeed.classList.toggle("is-active", rate !== 1)
  }

  function syncVolumeUi() {
    const muted = ui.video.muted || ui.video.volume === 0
    ui.timeline?.classList.toggle("is-muted", muted)
    if (ui.vpVolume) ui.vpVolume.value = String(muted ? 0 : ui.video.volume)
  }

  function isFullscreen() {
    const doc = document as any
    return (
      (doc.fullscreenElement || doc.webkitFullscreenElement) === ui.videoPreview
    )
  }

  function syncFullscreenUi() {
    ui.timeline?.classList.toggle("is-fullscreen", isFullscreen())
  }

  function scrollTimelineToBlock(index: number, lang = activeTrackLang()) {
    const view = ui.timelineScroll
    const seg = segmentsForLang(lang)[index]
    if (!view || !seg) return
    const left = seg.start * tlPxPerSec
    const right = Math.max(left + MIN_SUBTITLE_DURATION * tlPxPerSec, seg.end * tlPxPerSec)
    if (
      left < view.scrollLeft + 8 ||
      right > view.scrollLeft + view.clientWidth - 8
    ) {
      view.scrollLeft = Math.max(0, left - view.clientWidth * 0.3)
    }
  }

  function highlightSegment(
    index: number,
    {
      lang = activeTrackLang(),
      scrollSidebar = false,
      scrollTimeline = false,
      touchSidebar = true,
    } = {},
  ) {
    setTimelineActive(index, lang)
    if (touchSidebar) onActiveSegment?.(index, lang, scrollSidebar)
    if (scrollTimeline && index >= 0) scrollTimelineToBlock(index, lang)
  }

  function updateCaption(timeOverride?: number) {
    const frameOnly = typeof timeOverride === "number"
    const current =
      frameOnly ? timeOverride : ui.video.currentTime
    updateTimelinePlayhead(current)
    onPlaybackTime?.(current)
    const tracks = getTracks()
    const editing = !!document.activeElement?.closest?.(".transcript")
    if (!tracks.length || !ui.video.duration) {
      renderCaptions?.([], current)
      if (!frameOnly) highlightSegment(-1, { touchSidebar: !editing })
      return
    }
    const activeLang = activeTrackLang()
    const captionTracks = tracks
      .filter((track) => !track.hidden)
      .map((track) => {
        const segIdx = findSegmentIndexAt(track.segments, current, true)
        const segment = segIdx >= 0 ? track.segments[segIdx] : undefined
        return {
          lang: track.lang,
          label: track.label,
          role: track.role,
          text: segment?.text || "",
          segment,
        }
      })
      .filter((track) => track.text.trim())
    const activeTrack =
      tracks.find((track) => track.lang === activeLang) || tracks[0]
    const idx = findSegmentIndexAt(activeTrack.segments, current)
    renderCaptions?.(captionTracks, current)
    if (!frameOnly) {
      highlightSegment(idx, {
        lang: activeTrack.lang,
        scrollSidebar: !editing,
      })
    }
  }

  function updateCaptionFromMediaEvent() {
    if (!scrubbing) updateCaption()
  }

  function wireTimeline() {
    ui.timelineTrack?.addEventListener("pointerdown", (event: any) => {
      if (event.target.closest(".tl-block, .tl-track-controls")) return
      beginScrub(event)
    })
    ui.timelineTrack?.addEventListener("pointermove", (event: any) => {
      if (scrubbing) scrubToClientX(event.clientX)
    })
    ui.timelineTrack?.addEventListener("pointerup", endScrub)
    ui.timelineTrack?.addEventListener("pointercancel", endScrub)

    ui.timelineBlocks?.addEventListener("pointerdown", (event: any) => {
      if (event.target.closest(".tl-track-controls")) {
        event.stopPropagation()
        return
      }
      const block = event.target.closest(".tl-block")
      if (!block) return
      const handle = event.target.closest(".tl-handle")
      const index = Number(block.dataset.index)
      const lang = block.dataset.lang || activeTrackLang()
      const seg = segmentsForLang(lang)[index]
      if (!seg) return
      event.preventDefault()
      blurActiveEditable()
      activateTrack(lang)
      if (trackForLang(lang)?.locked) {
        ui.video.currentTime = segmentSeekTime(seg)
        highlightSegment(index, { lang, scrollSidebar: true })
        updateCaption()
        return
      }
      tlDrag = {
        index,
        lang,
        seg,
        block,
        mode: handle ? handle.dataset.edge : "move",
        startX: event.clientX,
        original: { ...seg },
        moved: false,
        before: snapshotSegments(),
      }
      block.setPointerCapture?.(event.pointerId)
      block.classList.add("is-dragging")
    })

    ui.timelineBlocks?.addEventListener("pointermove", (event: any) => {
      if (!tlDrag) return
      const dx = event.clientX - tlDrag.startX
      const dt = dx / tlPxPerSec
      if (!tlDrag.moved && Math.abs(dx) <= 3) return
      tlDrag.moved = true
      const { seg, mode, original } = tlDrag
      const dur0 = original.end - original.start
      if (mode === "move") {
        const ns = Math.max(0, original.start + dt)
        seg.start = ns
        seg.end = ns + dur0
      } else if (mode === "start") {
        seg.start = Math.max(
          0,
          Math.min(original.end - MIN_SUBTITLE_DURATION, original.start + dt),
        )
      } else {
        seg.end = Math.max(original.start + MIN_SUBTITLE_DURATION, original.end + dt)
      }
      if (original.words) {
        seg.words = wordsForDraggedBlock(original, seg.start, seg.end)
      }
      tlDrag.block.style.left = `${seg.start * tlPxPerSec}px`
      tlDrag.block.style.width = `${(seg.end - seg.start) * tlPxPerSec}px`
      updateCaption()
    })

    ui.timelineBlocks?.addEventListener("pointerup", endTimelineDrag)
    ui.timelineBlocks?.addEventListener("pointercancel", endTimelineDrag)

    ui.timelineBlocks?.addEventListener("click", (event: any) => {
      const button = event.target.closest(".tl-track-btn")
      if (!button) return
      event.preventDefault()
      event.stopPropagation()
      const row = button.closest(".tl-track-row")
      const lang = row?.dataset.lang
      if (!lang) return
      if (button.dataset.action === "visibility") toggleTrackHidden?.(lang)
      else if (button.dataset.action === "lock") toggleTrackLocked?.(lang)
    })

    ui.tlPlay?.addEventListener("click", togglePlay)
    ui.video.addEventListener("click", togglePlay)
    ui.video.addEventListener("play", () => {
      ui.timeline?.classList.add("is-playing")
      cancelAnimationFrame(playheadRaf)
      reanchorPlayhead()
      playheadLoop()
    })
    ui.video.addEventListener("pause", () => {
      ui.timeline?.classList.remove("is-playing")
      cancelAnimationFrame(playheadRaf)
      playheadRaf = 0
      updateTimelinePlayhead()
    })
    ui.video.addEventListener("seeked", reanchorPlayhead)
    ui.video.addEventListener("seeked", () => {
      if (scrubbing) scheduleScrubVideoSeek()
    })
    ui.video.addEventListener("ratechange", reanchorPlayhead)
    ui.video.addEventListener("ratechange", syncSpeedUi)
    ui.tlSpeed?.addEventListener("click", cyclePlaybackRate)
    ui.video.addEventListener("timeupdate", updateCaptionFromMediaEvent)
    ui.video.addEventListener("seeked", updateCaptionFromMediaEvent)

    ui.vpMute?.addEventListener("click", () => {
      ui.video.muted = !ui.video.muted
      if (!ui.video.muted && ui.video.volume === 0) ui.video.volume = 1
    })
    ui.vpVolume?.addEventListener("input", () => {
      const v = Number(ui.vpVolume.value)
      ui.video.volume = v
      ui.video.muted = v === 0
    })
    ui.video.addEventListener("volumechange", syncVolumeUi)

    ui.vpFullscreen?.addEventListener("click", () => {
      const doc = document as any
      if (isFullscreen()) {
        ;(doc.exitFullscreen || doc.webkitExitFullscreen)?.call(document)
      } else {
        const el = ui.videoPreview as any
        ;(el?.requestFullscreen || el?.webkitRequestFullscreen)?.call(el)
      }
    })
    document.addEventListener("fullscreenchange", syncFullscreenUi)
    document.addEventListener("webkitfullscreenchange", syncFullscreenUi)
    syncVolumeUi()

    ui.timelineScroll?.addEventListener("wheel", handleTimelineWheelZoom, {
      passive: false,
    })
    ui.timelineScroll?.addEventListener("scroll", scheduleDrawWaveform, {
      passive: true,
    })
    if (ui.timelineScroll && "ResizeObserver" in window)
      new ResizeObserver(() => scheduleDrawWaveform()).observe(ui.timelineScroll)
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      waveColor = ""
      scheduleDrawWaveform()
    })
    ui.tlZoomIn?.addEventListener("click", () => zoomTimeline(1.4))
    ui.tlZoomOut?.addEventListener("click", () => zoomTimeline(1 / 1.4))
    ui.video.addEventListener("loadedmetadata", renderTimeline)
  }

  wireTimeline()

  return {
    mediaDuration,
    renderTimeline,
    highlightSegment,
    updateCaption,
    updateTimelinePlayhead,
    setWaveform,
  }
}
