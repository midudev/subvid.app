import { cutDuration, type TimeRange } from "@/scripts/cuts.ts"
import { LANGS } from "@/scripts/languages.ts"
import type { TranscriptEditor } from "@/scripts/transcriptEditor.ts"

// The transcription plus one translation, shown together on the video.
const MAX_LANGS = 2

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
  removeSegmentsForLang: (lang: string) => void
  /** Shows both languages on the video, each one with its own style. */
  showDualTrack: (existing: string, added: string) => void
  /** Back to a single subtitle once the other language is removed. */
  hideDualTrack: (remaining: string) => void
  translateSegments: (segments: any[], source: string, target: string) => Promise<any[]>
  /** Whether a translation model is already loaded (false ⇒ a download is pending). */
  isTranslationReady: () => boolean
  snapshotSegments: () => string
  pushHistory: (snapshotBefore: string) => void
  transcript: TranscriptEditor
  cutRanges: () => TimeRange[]
  renderTimeline: () => void
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
    removeSegmentsForLang,
    showDualTrack,
    hideDualTrack,
    translateSegments,
    isTranslationReady,
    snapshotSegments,
    pushHistory,
    transcript,
    cutRanges,
    renderTimeline,
    updateCaption,
    enableExports,
  } = options

  let translatingLang = ""

  function segmentsForLang(lang: string) {
    return getState().segmentsByLang[lang] || []
  }

  function renderTabs() {
    const { orderedLangs, activeLang } = getState()
    ui.langTabs.innerHTML = ""
    // There's always at least one language left, so only a pair can lose one.
    const removable = orderedLangs.length > 1 && !translatingLang
    orderedLangs.forEach((lang) => {
      const item = document.createElement("div")
      item.className = "tab-item"
      const tab = document.createElement("button")
      tab.type = "button"
      tab.className = `tab${lang === activeLang ? " is-active" : ""}`
      tab.textContent = langName(lang)
      tab.addEventListener("click", () => selectLang(lang))
      item.append(tab)
      if (removable) {
        const remove = document.createElement("button")
        remove.type = "button"
        remove.className = "tab-remove"
        remove.title = tt("removeLang", { lang: langName(lang) })
        remove.setAttribute("aria-label", remove.title)
        remove.innerHTML =
          '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>'
        remove.addEventListener("click", () => removeLanguage(lang))
        item.append(remove)
      }
      ui.langTabs.appendChild(item)
    })
    // The language being translated shows up as a placeholder tab until it's ready.
    if (translatingLang) {
      const pending = document.createElement("span")
      pending.className = "tab is-pending"
      pending.setAttribute("aria-busy", "true")
      pending.textContent = langName(translatingLang)
      ui.langTabs.appendChild(pending)
    }
    populateAddLang()
  }

  /** Switches the transcript, tabs and timeline to another language. */
  function selectLang(lang: string) {
    const { activeLang, orderedLangs } = getState()
    if (activeLang === lang || !orderedLangs.includes(lang)) return
    transcript.commitPendingEdit()
    setActiveLang(lang)
    refresh()
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
    ui.langAddSelect.hidden = !!translatingLang || orderedLangs.length >= MAX_LANGS
    ui.langAddSelect.disabled = orderedLangs.length === 0 || remaining.length === 0
  }

  function setLangAddStatus(message: string, kind = "ok") {
    if (!ui.langAddStatus) return
    ui.langAddStatus.textContent = message
    ui.langAddStatus.dataset.kind = kind
    ui.langAddStatus.hidden = !message
  }

  async function addLanguage(target: string) {
    const state = getState()
    if (
      translatingLang ||
      !(LANGS as any)[target] ||
      state.orderedLangs.includes(target) ||
      state.orderedLangs.length >= MAX_LANGS
    )
      return
    const existing = state.orderedLangs[0]
    // A removed transcription is still in memory, so it comes back as it was.
    if (target === state.detectedLang && state.segmentsByLang[target]?.length) {
      showLanguage(existing, target, snapshotSegments())
      return
    }
    const source =
      state.detectedLang && (LANGS as any)[state.detectedLang]
        ? state.detectedLang
        : existing
    // Lines whose words were all cut have nothing left to translate.
    const sourceSegs = (state.segmentsByLang[source] || state.baseSegments).filter(
      (seg) => seg.text.trim(),
    )
    if (!sourceSegs?.length) return

    translatingLang = target
    renderTabs()

    const translatingMessage = tt("translatingTo", { lang: langName(target) })
    const needsDownload = !isTranslationReady()
    setLangAddStatus(
      needsDownload ? tt("steps.downloadingTranslation") : translatingMessage,
      "busy",
    )

    // While the model downloads we keep the "downloading" label; once it's ready
    // we switch to the translating label so the user understands each phase.
    let readyWatcher = 0
    if (needsDownload) {
      readyWatcher = window.setInterval(() => {
        if (!isTranslationReady()) return
        window.clearInterval(readyWatcher)
        readyWatcher = 0
        setLangAddStatus(translatingMessage, "busy")
      }, 200)
    }

    let translated: any[]
    try {
      translated = await translateSegments(sourceSegs, source, target)
    } catch (error) {
      console.error(error)
      setLangAddStatus(tt("translationFailed"), "error")
      return
    } finally {
      if (readyWatcher) window.clearInterval(readyWatcher)
      translatingLang = ""
      renderTabs()
    }
    const before = snapshotSegments()
    setSegmentsForLang(target, translated)
    setLangAddStatus("", "ok")
    showLanguage(existing, target, before)
  }

  function showLanguage(existing: string, added: string, before: string) {
    const { orderedLangs, detectedLang } = getState()
    // The transcription always goes first.
    setOrderedLangs(
      added === detectedLang ? [added, ...orderedLangs] : [...orderedLangs, added],
    )
    showDualTrack(existing, added)
    setActiveLang(added)
    pushHistory(before)
    refresh()
  }

  function removeLanguage(lang: string) {
    const { orderedLangs, detectedLang } = getState()
    if (translatingLang || orderedLangs.length < 2 || !orderedLangs.includes(lang)) return
    transcript.commitPendingEdit()
    const before = snapshotSegments()
    const remaining = orderedLangs.filter((code) => code !== lang)
    hideDualTrack(remaining[0])
    setOrderedLangs(remaining)
    // The transcription stays in memory: its word timings hold the video cuts.
    if (lang !== detectedLang) removeSegmentsForLang(lang)
    setActiveLang(remaining[0])
    pushHistory(before)
    setLangAddStatus("", "ok")
    refresh()
  }

  function refresh() {
    renderTabs()
    renderSegments()
    enableExports(true)
    updateCaption()
  }

  function renderSegments() {
    transcript.render()
    renderTranscriptMeta()
    renderTimeline()
  }

  /** Line count and the cut summary under the transcript. */
  function renderTranscriptMeta() {
    const { activeLang, detectedLang, orderedLangs } = getState()
    const total = segmentsForLang(activeLang).length
    ui.segCount.textContent = total ? tt("segCount", { n: total }) : ""
    const cutSeconds = cutDuration(cutRanges())
    ui.transcriptHint.hidden = !total
    ui.transcriptHint.replaceChildren()
    if (total && activeLang === detectedLang) {
      ui.transcriptHint.textContent = cutSeconds
        ? tt("transcript.cutSummary", { time: cutSeconds.toFixed(1) })
        : tt(transcript.wordEdit() ? "transcript.wordEditHint" : "transcript.hint")
    } else if (total && orderedLangs.includes(detectedLang)) {
      // Cuts are made on the transcription, the only track with word timings.
      const link = document.createElement("button")
      link.type = "button"
      link.className = "tx-hint-link"
      link.textContent = tt("transcript.cutOnSource", {
        lang: langName(detectedLang),
      })
      link.addEventListener("click", () => {
        setActiveLang(detectedLang)
        renderTabs()
        renderSegments()
        updateCaption()
      })
      ui.transcriptHint.append(link)
    }
  }

  return {
    addLanguage,
    populateAddLang,
    renderSegments,
    renderTabs,
    renderTranscriptMeta,
    selectLang,
    setLangAddStatus,
  }
}
