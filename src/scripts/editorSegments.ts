import { $ } from "@/scripts/dom.ts"
import { LANGS } from "@/scripts/languages.ts"
import { formatClock, parseClock } from "@/scripts/subtitles.ts"

type EditorState = {
  detectedLang: string
  baseSegments: any[]
  segmentsByLang: Record<string, any[]>
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
  trackStates?: Record<string, { hidden?: boolean; locked?: boolean }>
}

type EditorSegmentsOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
  langName: (code: string) => string
  getState: () => EditorState
  setActiveLang: (lang: string) => void
  setOrderedLangs: (langs: string[]) => void
  setSegmentsForLang: (lang: string, segments: any[]) => void
  trackLabel: (lang: string) => string
  translateSegments: (segments: any[], source: string, target: string) => Promise<any[]>
  snapshotSegments: () => string
  pushHistory: (snapshotBefore: string) => void
  renderTimeline: () => void
  highlightSegment: (index: number, options?: any) => void
  updateCaption: () => void
  enableExports: (on: boolean) => void
}

export function createEditorSegmentsController(options: EditorSegmentsOptions) {
  const {
    ui,
    tt,
    langName,
    getState,
    setActiveLang,
    setOrderedLangs,
    setSegmentsForLang,
    trackLabel,
    translateSegments,
    snapshotSegments,
    pushHistory,
    renderTimeline,
    highlightSegment,
    updateCaption,
    enableExports,
  } = options

  let translatingLang = ""
  let textEditSnapshot: string | null = null

  function escapeHtml(value: string) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  function visibleEditorLangs() {
    const state = getState()
    const langs =
      state.dualTrackMode && state.dualTrackLangs.includes(state.activeLang)
        ? state.dualTrackLangs
        : [state.activeLang]
    return langs.filter((lang, index) => lang && langs.indexOf(lang) === index)
  }

  function segmentsForLang(lang: string) {
    return getState().segmentsByLang[lang] || []
  }

  function setActiveLangFromElement(li: HTMLElement) {
    const lang = li.dataset.lang
    if (!lang || getState().activeLang === lang) return
    setActiveLang(lang)
    renderTabs()
  }

  function segmentFromElement(li: HTMLElement) {
    const lang = li.dataset.lang || getState().activeLang
    const index = Number(li.dataset.index)
    const segments = segmentsForLang(lang)
    return { lang, index, segments, seg: segments[index] }
  }

  function segmentSeekTime(seg: any) {
    const start = Math.max(0, Number(seg?.start) || 0)
    const end = Number.isFinite(seg?.end) ? Number(seg.end) : start + 0.5
    return Math.min(start + 0.001, Math.max(start, end - 0.001))
  }

  function buildLangSelects() {
    ui.inputLang.innerHTML = `<option value="">${tt("detectAuto")}</option>`
    ui.outputLang.innerHTML = `<option value="same">${tt("sameAsAudio")}</option>`
    Object.keys(LANGS).forEach((code) => {
      const inOpt = document.createElement("option")
      inOpt.value = code
      inOpt.textContent = langName(code)
      ui.inputLang.appendChild(inOpt)

      const outOpt = document.createElement("option")
      outOpt.value = code
      outOpt.textContent = langName(code)
      ui.outputLang.appendChild(outOpt)
    })
  }

  function renderTabs() {
    const { orderedLangs, activeLang } = getState()
    ui.langTabs.innerHTML = ""
    orderedLangs.forEach((lang) => {
      const tab = document.createElement("button")
      tab.type = "button"
      tab.className = `tab${lang === activeLang ? " is-active" : ""}`
      tab.textContent = langName(lang)
      tab.addEventListener("click", () => {
        if (getState().activeLang === lang) return
        setActiveLang(lang)
        renderTabs()
        renderSegments()
        enableExports(true)
        updateCaption()
      })
      ui.langTabs.appendChild(tab)
    })
    populateAddLang()
  }

  function populateAddLang() {
    if (!ui.langAddSelect) return
    const { orderedLangs } = getState()
    const remaining = Object.entries(LANGS).filter(
      ([code]) => !orderedLangs.includes(code),
    )
    ui.langAddSelect.innerHTML = `<option value="">${tt("addLangOption")}</option>`
    remaining.forEach(([code]) => {
      const opt = document.createElement("option")
      opt.value = code
      opt.textContent = langName(code)
      ui.langAddSelect.appendChild(opt)
    })
    ui.langAddSelect.value = ""
    ui.langAddSelect.disabled =
      !!translatingLang || orderedLangs.length === 0 || remaining.length === 0
  }

  function setLangAddStatus(message: string, kind = "ok") {
    if (!ui.langAddStatus) return
    ui.langAddStatus.textContent = message
    ui.langAddStatus.dataset.kind = kind
    ui.langAddStatus.hidden = !message
  }

  async function addLanguage(target: string) {
    const state = getState()
    if (translatingLang || !(LANGS as any)[target] || state.orderedLangs.includes(target))
      return
    const source =
      state.detectedLang && (LANGS as any)[state.detectedLang]
        ? state.detectedLang
        : state.orderedLangs[0]
    const sourceSegs = state.segmentsByLang[source] || state.baseSegments
    if (!sourceSegs?.length) return

    translatingLang = target
    if (ui.langAddSelect) ui.langAddSelect.disabled = true
    setLangAddStatus(tt("translatingTo", { lang: langName(target) }), "busy")
    try {
      const translated = await translateSegments(sourceSegs, source, target)
      const before = snapshotSegments()
      setSegmentsForLang(target, translated)
      setOrderedLangs([...getState().orderedLangs, target])
      setActiveLang(target)
      pushHistory(before)
      setLangAddStatus("", "ok")
      renderTabs()
      renderSegments()
      enableExports(true)
      updateCaption()
    } catch (error) {
      console.error(error)
      setLangAddStatus(tt("translationFailed"), "error")
    } finally {
      translatingLang = ""
      populateAddLang()
    }
  }

  function renderSegments() {
    const state = getState()
    const langs = visibleEditorLangs()
    const isDual = state.dualTrackMode && langs.length > 1
    ui.segList.innerHTML = ""
    ui.segList.classList.toggle("is-dual", isDual)
    const totalSegments = langs.reduce(
      (count, lang) => count + segmentsForLang(lang).length,
      0,
    )
    if (!totalSegments) {
      ui.segList.innerHTML = `<li class="seg-empty">${tt("segEmpty")}</li>`
      ui.segCount.textContent = ""
      renderTimeline()
      return
    }
    langs.forEach((lang) => {
      const segments = segmentsForLang(lang)
      if (isDual) {
        const title = document.createElement("li")
        title.className = "seg-track-title"
        title.textContent = trackLabel(lang)
        ui.segList.appendChild(title)
      }
      segments.forEach((seg, index) => {
        const li = document.createElement("li")
        li.className = "seg"
        li.dataset.lang = lang
        li.dataset.index = String(index)
        li.innerHTML = `
      <div class="seg-row">
        <button class="seg-play" type="button" title="${tt("goTitle")}" aria-label="${tt("goAria")}">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 2l5 3.5L3 9V2z" fill="currentColor"/></svg>
        </button>
        <input class="t-input t-start" value="${formatClock(seg.start)}" aria-label="${tt("startAria")}" />
        <span class="t-sep">→</span>
        <input class="t-input t-end" value="${formatClock(seg.end)}" aria-label="${tt("endAria")}" />
        <button class="seg-del" type="button" title="${tt("delTitle")}" aria-label="${tt("delAria")}">✕</button>
      </div>
      <textarea class="seg-text" rows="2" spellcheck="false">${escapeHtml(seg.text)}</textarea>
    `
        ui.segList.appendChild(li)
      })
    })
    ui.segCount.textContent = isDual
      ? tt("tracks.count", { n: totalSegments, count: langs.length })
      : tt("segCount", { n: totalSegments })
    renderTimeline()
  }

  function wireSegmentEditor() {
    ui.segList.addEventListener("input", (event: any) => {
      const li = event.target.closest(".seg")
      if (!li) return
      const { seg } = segmentFromElement(li)
      if (!seg) return
      if (event.target.classList.contains("seg-text")) {
        seg.text = event.target.value
        updateCaption()
      }
    })

    ui.segList.addEventListener("change", (event: any) => {
      const li = event.target.closest(".seg")
      if (!li) return
      const { segments, seg } = segmentFromElement(li)
      if (!seg) return
      if (
        event.target.classList.contains("t-start") ||
        event.target.classList.contains("t-end")
      ) {
        const parsed = parseClock(event.target.value)
        if (parsed === null) {
          event.target.value = formatClock(
            event.target.classList.contains("t-start") ? seg.start : seg.end,
          )
          return
        }
        const before = snapshotSegments()
        if (event.target.classList.contains("t-start")) seg.start = parsed
        else seg.end = parsed
        if (seg.end <= seg.start) seg.end = seg.start + 0.5
        segments.sort((a, b) => a.start - b.start)
        pushHistory(before)
        renderSegments()
        updateCaption()
      }
    })

    ui.segList.addEventListener("click", (event: any) => {
      const li = event.target.closest(".seg")
      if (!li) return
      setActiveLangFromElement(li)
      const { lang, index, segments, seg } = segmentFromElement(li)
      if (!seg) return
      if (event.target.closest(".seg-play")) {
        ui.video.currentTime = segmentSeekTime(seg)
        ui.video.play().catch(() => {})
      } else if (event.target.closest(".seg-del")) {
        const before = snapshotSegments()
        segments.splice(index, 1)
        pushHistory(before)
        renderSegments()
        enableExports(true)
        updateCaption()
        return
      } else if (!event.target.closest(".seg-text, .t-input")) {
        ui.video.currentTime = segmentSeekTime(seg)
        updateCaption()
      }
      highlightSegment(index, { lang, scrollTimeline: true })
    })

    ui.segList.addEventListener("focusin", (event: any) => {
      const li = event.target.closest(".seg")
      if (!li) return
      const isEditable =
        event.target.classList.contains("seg-text") ||
        event.target.classList.contains("t-input")
      if (!isEditable) return
      const index = Number(li.dataset.index)
      const { lang, seg } = segmentFromElement(li)
      if (!seg) return
      setActiveLangFromElement(li)
      if (event.target.classList.contains("seg-text"))
        textEditSnapshot = snapshotSegments()
      const seekTime = segmentSeekTime(seg)
      if (Math.abs(ui.video.currentTime - seekTime) > 0.05)
        ui.video.currentTime = seekTime
      highlightSegment(index, { lang, scrollTimeline: true })
    })

    ui.segList.addEventListener("focusout", (event: any) => {
      if (!event.target.classList?.contains("seg-text")) return
      if (textEditSnapshot && snapshotSegments() !== textEditSnapshot)
        pushHistory(textEditSnapshot)
      textEditSnapshot = null
    })

    ui.addSegBtn.addEventListener("click", () => {
      const before = snapshotSegments()
      const lang = getState().activeLang
      const segments = segmentsForLang(lang)
      const t = ui.video.currentTime || 0
      segments.push({ start: t, end: t + 2, text: "" })
      segments.sort((a, b) => a.start - b.start)
      pushHistory(before)
      renderSegments()
      enableExports(true)
      const created = $(
        `.seg[data-lang="${lang}"][data-index="${segments.findIndex((s) => s.start === t)}"] .seg-text`,
        ui.segList,
      )
      created?.focus()
    })
  }

  return {
    addLanguage,
    buildLangSelects,
    populateAddLang,
    renderSegments,
    renderTabs,
    setLangAddStatus,
    wireSegmentEditor,
  }
}
