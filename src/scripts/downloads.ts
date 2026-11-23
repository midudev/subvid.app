type DownloadsControllerOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
  prettifyBytes: (bytes: number) => string
  hasBuiltInTranslationSupport: () => boolean
}

const RING_C = 2 * Math.PI * 15.5

export function createDownloadsController({
  ui,
  tt,
  prettifyBytes,
  hasBuiltInTranslationSupport,
}: DownloadsControllerOptions) {
  const downloads: any = {
    ffmpeg: {
      label: tt("downloads.ffmpeg"),
      state: "pending",
      progress: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      pendingNote: tt("downloads.ffmpegPendingNote"),
    },
    asr: {
      label: tt("downloads.whisper"),
      state: "pending",
      progress: 0,
      loaded: 0,
      total: 0,
      speed: 0,
    },
    translation: {
      label: tt("downloads.translation"),
      state: "pending",
      progress: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      pendingNote: hasBuiltInTranslationSupport()
        ? tt("downloads.pendingNoteChrome")
        : tt("downloads.pendingNote"),
      readyNote: "",
    },
  }

  const STATE_LABEL = {
    error: tt("downloads.downloadFailed"),
  }

  let clearConfirmTimer = 0
  let cachedModelsBytes = 0

  function trackSpeed(item: any, loaded: number) {
    const now = performance.now()
    if (item._lastTime == null) {
      item._lastTime = now
      item._lastLoaded = loaded
      return
    }
    const dt = (now - item._lastTime) / 1000
    if (dt >= 0.35) {
      const inst = Math.max(0, (loaded - item._lastLoaded) / dt)
      item.speed = item.speed ? item.speed * 0.55 + inst * 0.45 : inst
      item._lastTime = now
      item._lastLoaded = loaded
    }
  }

  function updateDownloadStatus(key: string, state: string) {
    const item = downloads[key]
    item.state = state
    if (state === "ready") {
      item.progress = 100
      item.speed = 0
    }
    if (state === "error") {
      item.speed = 0
    }
    renderDownloads()
  }

  function makeTransformersTracker(key: string) {
    const files = new Map()
    return (e: any) => {
      const item = downloads[key]
      if (
        e?.status === "progress" ||
        e?.status === "download" ||
        e?.status === "initiate"
      ) {
        if (
          typeof e.loaded === "number" &&
          typeof e.total === "number" &&
          e.total > 0
        ) {
          files.set(e.file, { loaded: e.loaded, total: e.total })
        }
        let loaded = 0
        let total = 0
        files.forEach((f: any) => {
          loaded += f.loaded
          total += f.total
        })
        item.loaded = loaded
        item.total = total
        item.progress = total
          ? Math.min(100, (loaded / total) * 100)
          : item.progress
        item.state = "downloading"
        trackSpeed(item, loaded)
        renderDownloads()
      }
    }
  }

  async function fetchWithProgress(
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal = 0,
  ) {
    const item = downloads[key]
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      const blob = await (await fetch(url)).blob()
      return URL.createObjectURL(new Blob([blob], { type: mimeType }))
    }
    const headerTotal = Number(response.headers.get("content-length")) || 0
    const partTotal = headerTotal || fallbackTotal
    item.total = (item._totalBase || 0) + partTotal
    const reader = response.body.getReader()
    const chunks = []
    let partLoaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      partLoaded += value.length
      item.loaded = (item._loadedBase || 0) + partLoaded
      item.progress = item.total
        ? Math.min(99, (item.loaded / item.total) * 100)
        : item.progress
      trackSpeed(item, item.loaded)
      renderDownloads()
    }
    item._loadedBase = (item._loadedBase || 0) + partLoaded
    item._totalBase = (item._totalBase || 0) + partTotal
    return URL.createObjectURL(new Blob(chunks, { type: mimeType }))
  }

  function downloadIcon(state: string) {
    if (state === "ready")
      return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    if (state === "error")
      return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`
    if (state === "downloading") return `<span class="spinner"></span>`
    return `<span class="dot"></span>`
  }

  // Progress events arrive per network chunk (hundreds per second), so DOM
  // updates are coalesced into a single paint per frame.
  let renderRaf = 0
  function renderDownloads() {
    if (renderRaf) return
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0
      renderDownloadsNow()
    })
  }

  type DownloadRowRefs = {
    li: HTMLLIElement
    icon: HTMLSpanElement
    pct: HTMLSpanElement
    track: HTMLDivElement
    fill: HTMLDivElement
    foot: HTMLSpanElement
    lastState: string
    lastPct: string
    lastFoot: string
    lastIndeterminate: boolean
  }
  const downloadRows = new Map<string, DownloadRowRefs>()

  function ensureDownloadRow(key: string, label: string): DownloadRowRefs {
    const existing = downloadRows.get(key)
    if (existing) return existing
    const li = document.createElement("li")
    li.className = "item item-pending"
    li.innerHTML = `
      <span class="item-icon">${downloadIcon("pending")}</span>
      <div class="item-body">
        <div class="item-head">
          <strong></strong>
          <span class="item-pct" hidden></span>
        </div>
        <div class="dl-track" hidden>
          <div class="dl-fill"></div>
        </div>
        <span class="item-foot" hidden></span>
      </div>`
    const strong = li.querySelector("strong")!
    strong.textContent = label
    const refs: DownloadRowRefs = {
      li,
      icon: li.querySelector(".item-icon") as HTMLSpanElement,
      pct: li.querySelector(".item-pct") as HTMLSpanElement,
      track: li.querySelector(".dl-track") as HTMLDivElement,
      fill: li.querySelector(".dl-fill") as HTMLDivElement,
      foot: li.querySelector(".item-foot") as HTMLSpanElement,
      lastState: "pending",
      lastPct: "",
      lastFoot: "",
      lastIndeterminate: false,
    }
    ui.downloadsList.appendChild(li)
    downloadRows.set(key, refs)
    return refs
  }

  function renderDownloadsList() {
    Object.entries(downloads).forEach(([key, item]: [string, any]) => {
      const refs = ensureDownloadRow(key, item.label)
      const pct = item.state === "ready" ? 100 : Math.round(item.progress)
      const sizeInfo =
        item.state === "ready" && item.total
          ? prettifyBytes(item.total)
          : item.total
            ? `${prettifyBytes(item.loaded)} / ${prettifyBytes(item.total)}`
            : ""
      const speedInfo =
        item.state === "downloading" && item.speed > 0
          ? `${prettifyBytes(item.speed)}/s`
          : ""
      const meta = [speedInfo, sizeInfo].filter(Boolean).join(" · ")
      const showTrack = item.state === "downloading"
      const footText =
        item.state === "pending"
          ? item.pendingNote || ""
          : item.state === "ready" && item.readyNote
            ? item.readyNote
            : item.state === "error"
              ? STATE_LABEL.error
              : meta

      if (refs.lastState !== item.state) {
        refs.lastState = item.state
        refs.li.className = `item item-${item.state}`
        refs.icon.innerHTML = downloadIcon(item.state)
      }
      refs.pct.hidden = !showTrack
      if (showTrack) {
        const pctText = `${pct}%`
        if (refs.lastPct !== pctText) {
          refs.lastPct = pctText
          refs.pct.textContent = pctText
        }
      }
      refs.track.hidden = !showTrack
      if (showTrack) {
        const indeterminate = !item.total
        if (refs.lastIndeterminate !== indeterminate) {
          refs.lastIndeterminate = indeterminate
          refs.track.classList.toggle("is-indeterminate", indeterminate)
        }
        refs.fill.style.transform = `scaleX(${pct / 100})`
      }
      refs.foot.hidden = !footText
      if (refs.lastFoot !== footText) {
        refs.lastFoot = footText
        refs.foot.textContent = footText
      }
    })
  }

  function renderDownloadsNow() {
    // The detailed list is only visible while the panel is open.
    if (!ui.downloadsPanel.hidden) renderDownloadsList()

    const tracked = Object.values(downloads).filter(
      (i: any) => i.state !== "pending",
    )
    const overall = tracked.length
      ? tracked.reduce(
          (acc: number, i: any) =>
            acc + (i.state === "ready" ? 100 : i.progress),
          0,
        ) / tracked.length
      : 0
    const allReady =
      tracked.length > 0 && tracked.every((i: any) => i.state === "ready")
    const hasError = Object.values(downloads).some(
      (i: any) => i.state === "error",
    )
    const liveCount = Object.values(downloads).filter(
      (i: any) => i.state === "downloading",
    ).length

    ui.downloadsRing.style.strokeDasharray = String(RING_C)
    ui.downloadsRing.style.strokeDashoffset = String(
      RING_C * (1 - overall / 100),
    )
    ui.downloadsPct.textContent = `${Math.round(overall)}%`

    ui.downloadsOverall.style.transform = `scaleX(${overall / 100})`
    ui.downloadsPanel.classList.toggle("is-ready", allReady)
    ui.downloadsPanel.classList.toggle("is-error", hasError)
    ui.downloadsToggle.classList.toggle("is-ready", allReady)
    ui.downloadsToggle.classList.toggle("is-error", hasError)
    ui.downloadsToggle.classList.toggle("is-busy", liveCount > 0 && !allReady)

    ui.downloadsSummary.textContent = allReady
      ? tt("downloads.allReady")
      : hasError
        ? tt("downloads.withErrors")
        : liveCount
          ? tt("downloads.inProgress", { n: liveCount })
          : ""

    const labelText = allReady
      ? tt("downloads.allReady")
      : hasError
        ? tt("downloads.downloadFailed")
        : liveCount && overall < 100
          ? `${tt("downloads.downloadInProgress")} · ${Math.round(overall)}%`
          : tt("downloads.preparingModels")
    ui.downloadsLabel.textContent = labelText
    ui.statusDock?.classList.toggle("is-idle", tracked.length === 0)
    ui.downloadsLabel.dataset.state = allReady
      ? "ready"
      : hasError
        ? "error"
        : "busy"
  }

  function clearModelsLabel() {
    return cachedModelsBytes > 0
      ? tt("downloads.clearWithSize", { size: prettifyBytes(cachedModelsBytes) })
      : tt("downloads.clearNone")
  }

  async function getCachedModelsSize() {
    if (typeof caches === "undefined") return 0
    let total = 0
    try {
      const keys = await caches.keys()
      const targets = keys.filter((k) => /transformers/i.test(k))
      for (const key of targets) {
        const cache = await caches.open(key)
        const requests = await cache.keys()
        const sizes = await Promise.all(
          requests.map(async (req) => {
            const res = await cache.match(req)
            if (!res) return 0
            const len = Number(res.headers.get("content-length"))
            return len || (await res.clone().blob()).size
          }),
        )
        for (const size of sizes) total += size
      }
    } catch (e) {
      console.warn("[clear-models] size calc failed", e)
    }
    return total
  }

  async function refreshClearModelsUI() {
    const btn = ui.clearModelsBtn
    if (!btn || btn.dataset.confirm === "1" || btn.dataset.busy === "1") return
    cachedModelsBytes = await getCachedModelsSize()
    btn.textContent = clearModelsLabel()
    btn.disabled = cachedModelsBytes === 0
  }

  async function clearLocalModels() {
    const btn = ui.clearModelsBtn
    if (!btn || !cachedModelsBytes) return

    if (btn.dataset.confirm !== "1") {
      btn.dataset.confirm = "1"
      btn.classList.add("is-confirm")
      btn.textContent = tt("downloads.clearConfirm", {
        size: prettifyBytes(cachedModelsBytes),
      })
      clearTimeout(clearConfirmTimer)
      clearConfirmTimer = window.setTimeout(() => {
        btn.dataset.confirm = ""
        btn.classList.remove("is-confirm")
        btn.textContent = clearModelsLabel()
      }, 3500)
      return
    }

    clearTimeout(clearConfirmTimer)
    btn.dataset.confirm = ""
    btn.dataset.busy = "1"
    btn.classList.remove("is-confirm")
    btn.disabled = true
    btn.textContent = tt("downloads.deleting")

    const freed = cachedModelsBytes
    let deleted = false
    try {
      if (typeof caches !== "undefined") {
        const keys = await caches.keys()
        const targets = keys.filter((k) => /transformers/i.test(k))
        await Promise.all(
          (targets.length ? targets : ["transformers-cache"]).map((k) =>
            caches.delete(k),
          ),
        )
        deleted = true
      }
    } catch (e) {
      console.warn("[clear-models] failed to delete cache", e)
    }

    btn.dataset.busy = ""
    cachedModelsBytes = 0
    btn.textContent = clearModelsLabel()
    btn.disabled = true
    if (ui.clearModelsNote) {
      ui.clearModelsNote.hidden = false
      ui.clearModelsNote.textContent = deleted
        ? tt("downloads.freed", { size: prettifyBytes(freed) })
        : tt("downloads.clearFailed")
    }
  }

  return {
    downloads,
    renderDownloads,
    updateDownloadStatus,
    makeTransformersTracker,
    fetchWithProgress,
    refreshClearModelsUI,
    clearLocalModels,
  }
}
