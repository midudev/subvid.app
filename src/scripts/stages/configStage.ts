import { prettifyBytes } from "@/scripts/file.ts"
import { ASR_MODEL, LANGS } from "@/scripts/languages.ts"
import { createAudioService } from "@/scripts/media/audio.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import {
  normalizeLanguageCode,
  normalizeSegments,
} from "@/scripts/subtitles.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>

type GeneratedState = {
  detectedLang: string
  baseSegments: Segment[]
  segmentsByLang: SegmentsByLang
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
}

type AudioJobResult = {
  audio: Float32Array
  audioSeconds: number
}

type AudioJob = {
  key: string
  promise: Promise<AudioJobResult>
  result?: AudioJobResult
  error?: unknown
}

type TranscriptionRequest = {
  file: File
  language: string
  wordTimestamps: boolean
}

type TranscriptionJobResult = {
  output: any
  audio: Float32Array
  audioSeconds: number
  chunksDone: number
}

type TranscriptionJob = {
  key: string
  fileKey: string
  request: TranscriptionRequest
  promise: Promise<TranscriptionJobResult>
  result?: TranscriptionJobResult
  error?: unknown
  settled: boolean
}

type ConfigStageOptions = {
  ui: typeof appUi
  tt: (path: string, vars?: Record<string, unknown>) => string
  downloads: any
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>
  updateDownloadStatus: (key: string, state: string) => void
  transformersClient: any
  translateSegments: (
    segments: Segment[],
    sourceLang: string,
    targetLang: string,
  ) => Promise<Segment[]>
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setGeneratedState: (state: GeneratedState) => void
  renderTabs: () => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  resetHistory: () => void
  updateCaption: () => void
  setStage: (stage: Stage) => void
}

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

export function createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile,
  isExporting,
  setGeneratedState,
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
}: ConfigStageOptions) {
  let asrReady = false
  let asrReadyPromise: Promise<void> | null = null
  let progressRaf = 0
  let progressIndeterminate = false
  let activeFileKey = ""
  let audioJob: AudioJob | null = null
  let audioProgressJobKey: string | null = null
  let progressOwnerKey: string | null = null
  let transcriptionQueue = Promise.resolve()
  const transcriptionJobs = new Map<string, TranscriptionJob>()

  function setStatus(message: string, kind = "ok") {
    ui.configStatus.textContent = message
    ui.configStatus.dataset.kind = kind
  }

  function setProgress(percent: number) {
    setIndeterminate(false)
    applyProgress(percent)
  }

  function setIndeterminate(on: boolean) {
    if (on) stopProgressCreep()
    progressIndeterminate = on
    ui.configProgressFill.classList.toggle("is-indeterminate", on)
    if (on) ui.configProgressPct.textContent = ""
  }

  function applyProgress(percent: number) {
    if (progressIndeterminate) return
    const clamped = Math.max(0, Math.min(100, percent))
    ui.configProgressFill.style.width = `${clamped}%`
    ui.configProgressPct.textContent = `${Math.round(clamped)}%`
  }

  function stopProgressCreep() {
    if (progressRaf) {
      cancelAnimationFrame(progressRaf)
      progressRaf = 0
    }
  }

  function startProgressCreep(from: number, ceiling: number, expected: number) {
    stopProgressCreep()
    const start = performance.now()
    const span = ceiling - from
    const tick = (now: number) => {
      const t = (now - start) / Math.max(1, expected)
      const eased = 1 - Math.exp(-1.6 * t)
      applyProgress(from + span * eased)
      progressRaf = requestAnimationFrame(tick)
    }
    progressRaf = requestAnimationFrame(tick)
  }

  function fileKey(file: File) {
    return [file.name, file.size, file.lastModified, file.type || "video"].join(":")
  }

  function selectedFileKey() {
    const file = selectedVideoFile()
    return file ? fileKey(file) : ""
  }

  function ensureFileSession(file: File) {
    const key = fileKey(file)
    if (activeFileKey !== key) {
      resetTranscriptionCache()
      activeFileKey = key
    }
    return key
  }

  function transcriptionKey(request: TranscriptionRequest) {
    const language = request.language || "auto"
    const detail = request.wordTimestamps ? "words" : "segments"
    return `${fileKey(request.file)}:${language}:${detail}`
  }

  function canUpdateJobProgress(jobKey: string | null) {
    return !!jobKey && jobKey === progressOwnerKey && activeFileKey === selectedFileKey()
  }

  function withAudioProgress(jobKey: string, run: () => Promise<AudioJobResult>) {
    audioProgressJobKey = jobKey
    return run().finally(() => {
      if (audioProgressJobKey === jobKey) audioProgressJobKey = null
    })
  }

  const { ensureFfmpeg, extractAudioBuffer, remuxAudioToAacLc } = createAudioService({
    tt,
    fetchWithProgress,
    updateDownloadStatus,
    setStatus: (message, kind) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setStatus(message, kind)
    },
    setProgress: (percent) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setProgress(percent)
    },
    applyProgress: (percent) => {
      if (canUpdateJobProgress(audioProgressJobKey)) applyProgress(percent)
    },
    setIndeterminate: (on) => {
      if (canUpdateJobProgress(audioProgressJobKey)) setIndeterminate(on)
    },
    startProgressCreep: (from, ceiling, expected) => {
      if (canUpdateJobProgress(audioProgressJobKey))
        startProgressCreep(from, ceiling, expected)
    },
    stopProgressCreep: () => {
      if (canUpdateJobProgress(audioProgressJobKey)) stopProgressCreep()
    },
  })

  function logGeneration(event: string, details: Record<string, unknown> = {}) {
    console.info(`[generate] ${event}`, details)
  }

  function formatElapsed(ms: number) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
    if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
    return `${seconds}s`
  }

  function outputTarget(sourceLang: string) {
    const value = ui.outputLang.value
    if (!value || value === "same") return sourceLang
    return value in LANGS ? value : sourceLang
  }

  function canEnableDualTrackOption() {
    const target = ui.outputLang.value
    return !ui.inputLang.value && !!target && target !== "same"
  }

  function syncDualTrackOption() {
    const available = canEnableDualTrackOption()
    ui.dualTrackField.hidden = !available
    ui.dualTrack.disabled = !available
    if (!available) ui.dualTrack.checked = false
  }

  async function ensureRecognizer() {
    if (asrReady) return
    if (!asrReadyPromise) {
      asrReadyPromise = (async () => {
        updateDownloadStatus("asr", "downloading")
        await transformersClient.call("ensure-asr", {
          model: ASR_MODEL,
          webgpu: hasWebGPU,
        })
        asrReady = true
        updateDownloadStatus("asr", "ready")
      })().finally(() => {
        asrReadyPromise = null
      })
    }
    await asrReadyPromise
  }

  async function preloadAssetsInBackground() {
    await Promise.allSettled([
      ensureFfmpeg().catch((error) => {
        console.error(error)
        updateDownloadStatus("ffmpeg", "error")
      }),
      ensureRecognizer().catch((error) => {
        console.error(error)
        updateDownloadStatus("asr", "error")
      }),
    ])
  }

  function requestFromCurrentOptions(file: File): TranscriptionRequest {
    return {
      file,
      language: ui.inputLang.value || "",
      wordTimestamps: true,
    }
  }

  function takeProgressOwnership(job: TranscriptionJob) {
    progressOwnerKey = job.key
    ui.configProgress.hidden = false
    setIndeterminate(false)
  }

  function getAudioJob(file: File, jobKey: string) {
    const key = fileKey(file)
    if (audioJob?.key === key && !audioJob.error) return audioJob

    const job: AudioJob = {
      key,
      promise: withAudioProgress(jobKey, async () => {
        const extractStartedAt = performance.now()
        const audio = await extractAudioBuffer(file)
        const audioSeconds = audio.length / 16000
        logGeneration("audio:ready", {
          audioSeconds: Math.round(audioSeconds),
          samples: audio.length,
          elapsedMs: Math.round(performance.now() - extractStartedAt),
        })
        return { audio, audioSeconds }
      }),
    }

    job.promise.then(
      (result) => {
        job.result = result
      },
      (error) => {
        job.error = error
      },
    )
    audioJob = job
    return job
  }

  async function runTranscriptionJob(
    job: TranscriptionJob,
  ): Promise<TranscriptionJobResult> {
    const { file, language, wordTimestamps } = job.request
    const { audio, audioSeconds } = await getAudioJob(file, job.key).promise

    if (canUpdateJobProgress(job.key)) {
      setStatus(tt("steps.loadingSpeech"), "busy")
      startProgressCreep(38, 48, 8000)
    }

    const asrMonitor = setInterval(() => {
      if (!canUpdateJobProgress(job.key)) return
      const download = downloads.asr
      if (download.state === "downloading" && download.total) {
        stopProgressCreep()
        const ratio = Math.min(1, download.progress / 100)
        applyProgress(38 + ratio * 10)
        const meta =
          prettifyBytes(download.loaded) + " / " + prettifyBytes(download.total)
        setStatus(`Step 4/5 · Downloading speech model… ${meta}`, "busy")
      }
    }, 200)

    try {
      const recognizerStartedAt = performance.now()
      const cached = asrReady
      logGeneration("recognizer:start", { cached })
      await ensureRecognizer()
      logGeneration("recognizer:ready", {
        cached,
        elapsedMs: Math.round(performance.now() - recognizerStartedAt),
      })
    } finally {
      clearInterval(asrMonitor)
      if (canUpdateJobProgress(job.key)) {
        stopProgressCreep()
        setProgress(48)
      }
    }

    const TR_START = 48
    const TR_END = 90
    const chunkSeconds = 30 - 2 * 5
    const totalChunks = Math.max(1, Math.ceil(audioSeconds / chunkSeconds))
    const chunkSpan = (TR_END - TR_START) / totalChunks
    let chunksDone = 0
    let lastChunkAt = performance.now()
    let perChunkMs = Math.max(2000, (audioSeconds / totalChunks) * 900)

    const transcribeStatus = () => {
      setStatus(tt("steps.transcribing"), "busy")
    }

    if (canUpdateJobProgress(job.key)) {
      transcribeStatus()
      applyProgress(TR_START)
      startProgressCreep(TR_START, TR_START + chunkSpan, perChunkMs)
    }

    const transcribeStartedAt = performance.now()
    logGeneration("transcription:start", {
      audioSeconds: Math.round(audioSeconds),
      estimatedChunks: totalChunks,
      language: language || "auto",
      wordTimestamps,
    })

    transformersClient.setChunkHandler(() => {
      const now = performance.now()
      perChunkMs = Math.max(500, now - lastChunkAt)
      lastChunkAt = now
      chunksDone = Math.min(totalChunks, chunksDone + 1)
      const floor = Math.min(TR_END, TR_START + chunksDone * chunkSpan)
      const ceiling = Math.min(TR_END, floor + chunkSpan)

      if (canUpdateJobProgress(job.key)) {
        transcribeStatus()
        stopProgressCreep()
        applyProgress(floor)
        if (chunksDone < totalChunks)
          startProgressCreep(floor, ceiling, perChunkMs)
      }

      logGeneration("transcription:chunk", {
        chunk: chunksDone,
        estimatedChunks: totalChunks,
        elapsedMs: Math.round(now - transcribeStartedAt),
      })
    })

    try {
      const audioForWorker = audio.slice()
      const output = await transformersClient.call(
        "transcribe",
        {
          audio: audioForWorker,
          language: language || null,
          wordTimestamps,
        },
        [audioForWorker.buffer],
      )
      logGeneration("transcription:done", {
        chunks: chunksDone,
        elapsedMs: Math.round(performance.now() - transcribeStartedAt),
      })
      if (canUpdateJobProgress(job.key)) {
        stopProgressCreep()
        setProgress(TR_END)
      }
      return { output, audio, audioSeconds, chunksDone }
    } finally {
      transformersClient.setChunkHandler(null)
    }
  }

  function getOrCreateTranscriptionJob(request: TranscriptionRequest) {
    const fileKeyValue = ensureFileSession(request.file)
    const key = transcriptionKey(request)
    const existing = transcriptionJobs.get(key)
    if (existing && !existing.error) return existing
    if (existing?.error) transcriptionJobs.delete(key)

    const job = {
      key,
      fileKey: fileKeyValue,
      request,
      settled: false,
    } as TranscriptionJob

    job.promise = transcriptionQueue
      .then(() => runTranscriptionJob(job))
      .then(
        (result) => {
          job.result = result
          return result
        },
        (error) => {
          job.error = error
          throw error
        },
      )
      .finally(() => {
        job.settled = true
      })

    transcriptionQueue = job.promise.catch(() => {})
    transcriptionJobs.set(key, job)
    return job
  }

  function resetTranscriptionCache() {
    activeFileKey = ""
    audioJob = null
    audioProgressJobKey = null
    progressOwnerKey = null
    transcriptionJobs.clear()
    transformersClient.setChunkHandler(null)
    stopProgressCreep()
    setIndeterminate(false)
  }

  function startEarlyTranscription(file = selectedVideoFile()) {
    if (!file || isExporting()) return
    ensureFileSession(file)
    const job = getOrCreateTranscriptionJob({
      file,
      language: "",
      wordTimestamps: true,
    })
    takeProgressOwnership(job)
    if (!job.result) {
      setStatus(tt("steps.preparing"), "busy")
      setProgress(2)
    }
    job.promise
      .then(() => {
        if (!canUpdateJobProgress(job.key)) return
        setStatus(tt("transcriptionReady"), "ok")
        ui.configProgress.hidden = true
      })
      .catch((error) => {
        console.warn("[generate] early transcription failed", error)
        if (!canUpdateJobProgress(job.key)) return
        setStatus(tt("videoLoaded"), "ok")
        setProgress(0)
        ui.configProgress.hidden = true
      })
  }

  async function generate() {
    const file = selectedVideoFile()
    if (!file || isExporting()) return

    ui.transcribeBtn.disabled = true
    ui.downloadVideoBtn.disabled = true
    ui.downloadSrtBtn.disabled = true
    ui.configError.hidden = true
    ui.configError.textContent = ""
    ui.generationTime.hidden = true
    ui.generationTime.textContent = ""
    const request = requestFromCurrentOptions(file)
    const job = getOrCreateTranscriptionJob(request)
    const hadVisibleProgress =
      progressOwnerKey === job.key && !ui.configProgress.hidden
    takeProgressOwnership(job)
    if (!job.result && !hadVisibleProgress) {
      setStatus(tt("steps.preparing"), "busy")
      setProgress(2)
    }
    const generationStartedAt = performance.now()
    logGeneration("start", {
      fileSize: file.size,
      fileType: file.type || "unknown",
      inputLang: ui.inputLang.value || "auto",
      outputLang: ui.outputLang.value || "same",
      wordAnimation: ui.wordAnimation.checked,
      webgpu: hasWebGPU,
    })

    try {
      const reusedTranscription = !!job.result
      if (reusedTranscription) {
        logGeneration("transcription:cache-hit", {
          language: request.language || "auto",
          wordTimestamps: request.wordTimestamps,
        })
      }
      const { output, audio, chunksDone } = await job.promise
      logGeneration("transcription:available", {
        cached: reusedTranscription,
        chunks: chunksDone,
        totalElapsedMs: Math.round(performance.now() - generationStartedAt),
      })

      stopProgressCreep()
      setProgress(90)
      setStatus(tt("steps.buildingLines"), "busy")
      applyProgress(92)

      const normalizeStartedAt = performance.now()
      const detectedLang =
        normalizeLanguageCode(output?.language) ||
        normalizeLanguageCode(ui.inputLang.value) ||
        "en"
      const vw = ui.configVideo?.videoWidth || ui.video?.videoWidth || 0
      const vh = ui.configVideo?.videoHeight || ui.video?.videoHeight || 0
      const aspectRatio = vw && vh ? vw / vh : 16 / 9
      const baseSegments = normalizeSegments(output, {
        audio,
        sampleRate: 16_000,
        aspectRatio,
      })
      logGeneration("segments:ready", {
        detectedLang,
        segments: baseSegments.length,
        elapsedMs: Math.round(performance.now() - normalizeStartedAt),
        totalElapsedMs: Math.round(performance.now() - generationStartedAt),
      })

      if (!baseSegments.length) throw new Error(tt("noSpeech"))

      const target = outputTarget(detectedLang)
      const targets = [detectedLang]
      if (target !== detectedLang && !targets.includes(target))
        targets.push(target)
      const dualTrackMode =
        ui.dualTrack.checked &&
        !ui.inputLang.value &&
        target !== detectedLang &&
        targets.includes(target)

      const TX_START = 92
      const TX_SPAN = 100 - TX_START
      const segmentsByLang: SegmentsByLang = {}
      let done = 0

      for (const lang of targets) {
        if (lang === detectedLang) {
          segmentsByLang[lang] = baseSegments.map((segment) => ({ ...segment }))
        } else {
          const translationStartedAt = performance.now()
          logGeneration("translation:start", {
            sourceLang: detectedLang,
            targetLang: lang,
            segments: baseSegments.length,
          })
          startProgressCreep(
            TX_START + (done / targets.length) * TX_SPAN,
            Math.min(99, TX_START + ((done + 1) / targets.length) * TX_SPAN),
            6000,
          )
          segmentsByLang[lang] = await translateSegments(
            baseSegments,
            detectedLang,
            lang,
          )
          stopProgressCreep()
          logGeneration("translation:done", {
            sourceLang: detectedLang,
            targetLang: lang,
            elapsedMs: Math.round(performance.now() - translationStartedAt),
            totalElapsedMs: Math.round(performance.now() - generationStartedAt),
          })
        }
        done += 1
        setProgress(TX_START + (done / targets.length) * TX_SPAN)
      }

      setGeneratedState({
        detectedLang,
        baseSegments,
        segmentsByLang,
        orderedLangs: targets,
        activeLang: target,
        dualTrackMode,
        dualTrackLangs: dualTrackMode ? [detectedLang, target] : [],
      })
      renderTabs()
      renderSegments()
      enableExports(true)
      ui.addSegBtn.disabled = false
      resetHistory()
      const totalElapsedMs = Math.round(performance.now() - generationStartedAt)
      ui.generationTime.textContent = tt("generatedIn", {
        time: formatElapsed(totalElapsedMs),
      })
      ui.generationTime.hidden = false
      setProgress(100)
      setStatus(
        tt("ready", { n: baseSegments.length, count: targets.length }),
        "ok",
      )
      setStage("editor")
      updateCaption()
      ui.configProgress.hidden = true
      logGeneration("done", {
        totalElapsedMs,
        segments: baseSegments.length,
        tracks: targets.length,
      })
    } catch (error: any) {
      console.error(error)
      console.warn("[generate] failed", {
        elapsedMs: Math.round(performance.now() - generationStartedAt),
        error,
      })
      const message = error?.message || tt("genError")
      setStatus(message, "error")
      setProgress(0)
      ui.configError.textContent = message
      ui.configError.hidden = false
      ui.configProgress.hidden = true
    } finally {
      ui.transcribeBtn.disabled = false
    }
  }

  function wireConfigStage() {
    ui.transcribeBtn.addEventListener("click", generate)
    ui.inputLang.addEventListener("change", syncDualTrackOption)
    ui.outputLang.addEventListener("change", syncDualTrackOption)
    syncDualTrackOption()
  }

  return {
    setStatus,
    setProgress,
    applyProgress,
    setIndeterminate,
    startProgressCreep,
    stopProgressCreep,
    ensureRecognizer,
    preloadAssetsInBackground,
    startEarlyTranscription,
    resetTranscriptionCache,
    generate,
    wireConfigStage,
    remuxAudioToAacLc,
  }
}
