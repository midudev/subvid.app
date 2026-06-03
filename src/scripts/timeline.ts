import { $, $$ } from "@/scripts/dom.ts"
import { formatClock } from "@/scripts/subtitles.ts"

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
  } = options
  const TL_MIN_DUR = 0.3
  const TL_HEADER_H = 34
  const TL_ROW_H = 58
  const TL_SCROLL_PAD = 22
  const SCRUB_SEEK_MIN_INTERVAL = 45
  const SCRUB_SEEK_EPSILON = 0.025
  let tlPxPerSec = 90
  let tlDuration = 0
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

  function tlTotalDuration() {
    const segEnd = getTracks().reduce((max, track) => {
      const last = track.segments[track.segments.length - 1]
      return Math.max(max, last?.end || 0)
    }, 0)
    return Math.max(tlDuration, segEnd, 1)
  }

  function renderTimeline() {
    if (!ui.timelineBlocks) return
    const tracks = getTracks()
    const dur = tlTotalDuration()
    ui.timelineTrack.style.width = `${dur * tlPxPerSec}px`
    ui.timeline?.classList.toggle("is-multitrack", tracks.length > 1)
    const blocksHeight = tracks.length * TL_ROW_H
    ui.timelineBlocks.style.height = `${blocksHeight}px`
    ui.timelineTrack.style.height = `${TL_HEADER_H + blocksHeight}px`
    ui.timelineScroll.style.height = `${TL_HEADER_H + blocksHeight + TL_SCROLL_PAD}px`

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

    ui.timelineBlocks.innerHTML = ""
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
        block.classList.toggle("is-hidden", !!track.hidden)
        block.classList.toggle("is-locked", !!track.locked)
        block.dataset.lang = track.lang
        block.dataset.index = String(index)
        block.style.left = `${seg.start * tlPxPerSec}px`
        block.style.width = `${Math.max(TL_MIN_DUR, seg.end - seg.start) * tlPxPerSec}px`
        block.innerHTML = `
      <span class="tl-handle tl-handle-l" data-edge="start"></span>
      <span class="tl-block-label">${escapeHtml(seg.text || "—")}</span>
      <span class="tl-handle tl-handle-r" data-edge="end"></span>
    `
        row.appendChild(block)
      })
      ui.timelineBlocks.appendChild(row)
    })
    updateTimelinePlayhead()
  }

  function updateTimelinePlayhead(timeOverride?: number) {
    if (!ui.timelinePlayhead) return
    const t = timeOverride ?? ui.video.currentTime ?? 0
    const x = t * tlPxPerSec
    ui.timelinePlayhead.style.transform = `translate3d(${x}px,0,0)`
    if (ui.tlClock)
      ui.tlClock.textContent = `${formatClock(t)} / ${formatClock(tlTotalDuration())}`
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
    updateCaption(Math.min(predicted, tlTotalDuration()))
    playheadRaf = requestAnimationFrame(playheadLoop)
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
    const right = Math.max(left + TL_MIN_DUR * tlPxPerSec, seg.end * tlPxPerSec)
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
    if (touchSidebar) {
      $$(".seg.is-active", ui.segList).forEach((el) =>
        el.classList.remove("is-active"),
      )
      if (index >= 0) {
        const li = $(`.seg[data-lang="${lang}"][data-index="${index}"]`, ui.segList)
        if (li) {
          li.classList.add("is-active")
          if (scrollSidebar) li.scrollIntoView({ block: "nearest" })
        }
      }
    }
    if (scrollTimeline && index >= 0) scrollTimelineToBlock(index, lang)
  }

  function updateCaption(timeOverride?: number) {
    const frameOnly = typeof timeOverride === "number"
    const current =
      frameOnly ? timeOverride : ui.video.currentTime
    updateTimelinePlayhead(current)
    const tracks = getTracks()
    const editing = document.activeElement?.tagName === "TEXTAREA"
    if (!tracks.length || !ui.video.duration) {
      renderCaptions?.([], current)
      if (!frameOnly) highlightSegment(-1, { touchSidebar: !editing })
      return
    }
    const activeLang = activeTrackLang()
    const captionTracks = tracks
      .filter((track) => !track.hidden)
      .map((track) => {
        const segment = track.segments.find(
          (s) => current >= s.start && current <= s.end,
        )
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
    const idx = activeTrack.segments.findIndex(
      (s) => current >= s.start && current <= s.end,
    )
    renderCaptions?.(captionTracks, current)
    if (!frameOnly) {
      highlightSegment(idx, {
        lang: activeTrack.lang,
        touchSidebar: !editing,
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
        origStart: seg.start,
        origEnd: seg.end,
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
      if (Math.abs(dx) > 3) tlDrag.moved = true
      const dur0 = tlDrag.origEnd - tlDrag.origStart
      const { seg, mode } = tlDrag
      if (mode === "move") {
        const ns = Math.max(0, tlDrag.origStart + dt)
        seg.start = ns
        seg.end = ns + dur0
      } else if (mode === "start") {
        seg.start = Math.max(
          0,
          Math.min(tlDrag.origEnd - TL_MIN_DUR, tlDrag.origStart + dt),
        )
      } else {
        seg.end = Math.max(tlDrag.origStart + TL_MIN_DUR, tlDrag.origEnd + dt)
      }
      tlDrag.block.style.left = `${seg.start * tlPxPerSec}px`
      tlDrag.block.style.width = `${(seg.end - seg.start) * tlPxPerSec}px`
      const li = $(
        `.seg[data-lang="${tlDrag.lang}"][data-index="${tlDrag.index}"]`,
        ui.segList,
      )
      if (li) {
        const s = $<HTMLInputElement>(".t-start", li)
        const e = $<HTMLInputElement>(".t-end", li)
        if (s) s.value = formatClock(seg.start)
        if (e) e.value = formatClock(seg.end)
      }
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

    ui.tlZoomIn?.addEventListener("click", () => {
      tlPxPerSec = Math.min(400, tlPxPerSec * 1.4)
      renderTimeline()
    })
    ui.tlZoomOut?.addEventListener("click", () => {
      tlPxPerSec = Math.max(12, tlPxPerSec / 1.4)
      renderTimeline()
    })
    ui.video.addEventListener("loadedmetadata", () => {
      tlDuration = Number.isFinite(ui.video.duration) ? ui.video.duration : 0
      renderTimeline()
    })
  }

  wireTimeline()

  return {
    renderTimeline,
    highlightSegment,
    updateCaption,
    updateTimelinePlayhead,
  }
}
