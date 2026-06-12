import { drawFrame, drawSubtitlesAt } from "@/scripts/export/subtitleRenderer.ts"

type VideoExportOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
  currentSegments: () => any[]
  selectedVideoFile: () => File | null
  activeLang: () => string
  baseFileName: () => string
  isExporting: () => boolean
  setExporting: (value: boolean) => void
  enableExports: (on: boolean) => void
  setStatus: (message: string, kind?: string) => void
  modal: any
  remuxAudioToAacLc?: (file: File) => Promise<Blob>
}

type WebCodecsExportResult =
  | { handled: true }
  | { handled: false; reason: string }

type ExportFormat = "mp4" | "webm"
type ExportQuality = "optimized" | "high" | "lossless"
type ExportSettings = {
  format: ExportFormat
  quality: ExportQuality
}

const EXPORT_FORMATS = new Set<ExportFormat>(["mp4", "webm"])
const EXPORT_QUALITIES = new Set<ExportQuality>([
  "optimized",
  "high",
  "lossless",
])
const RECORDER_MIME_TYPES: Record<ExportFormat, string[]> = {
  mp4: [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ],
  webm: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ],
}
const QUALITY_BITS_PER_PIXEL: Record<ExportQuality, number> = {
  optimized: 0.07,
  high: 0.13,
  lossless: 0.24,
}
const QUALITY_MIN_BITRATE: Record<ExportQuality, number> = {
  optimized: 350_000,
  high: 1_000_000,
  lossless: 8_000_000,
}
const QUALITY_MAX_BITRATE: Record<ExportQuality, number> = {
  optimized: 18_000_000,
  high: 36_000_000,
  lossless: 80_000_000,
}
const QUALITY_SOURCE_MULTIPLIER: Record<ExportQuality, number> = {
  optimized: 1.15,
  high: 2,
  lossless: Number.POSITIVE_INFINITY,
}

export function createVideoExporter(options: VideoExportOptions) {
  const {
    ui,
    tt,
    currentSegments,
    selectedVideoFile,
    activeLang,
    baseFileName,
    isExporting,
    setExporting,
    enableExports,
    setStatus,
    modal,
    remuxAudioToAacLc,
  } = options

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || "unknown error")
  }

  function formatDiagnostic(value: unknown) {
    if (!value) return tt("exportErrors.diagnosticUnavailable")
    if (typeof value === "string") return value
    try {
      const serialized = JSON.stringify(value)
      return serialized || tt("exportErrors.diagnosticUnavailable")
    } catch {
      return String(value)
    }
  }

  function getWebCodecsSupportIssue() {
    const missingApis = [
      typeof VideoEncoder === "undefined" ? "VideoEncoder" : "",
      typeof VideoDecoder === "undefined" ? "VideoDecoder" : "",
      typeof OffscreenCanvas === "undefined" ? "OffscreenCanvas" : "",
    ].filter(Boolean)

    if (missingApis.length) {
      return tt("exportErrors.webcodecsMissingApis", {
        apis: missingApis.join(", "),
      })
    }

    if (!selectedVideoFile()) return tt("exportErrors.webcodecsMissingFile")
    return ""
  }

  function exportSettings(): ExportSettings {
    const rawFormat = ui.exportFormat?.value
    const rawQuality = ui.exportQuality?.value
    return {
      format: EXPORT_FORMATS.has(rawFormat) ? rawFormat : "mp4",
      quality: EXPORT_QUALITIES.has(rawQuality) ? rawQuality : "optimized",
    }
  }

  function setExportControlsDisabled(disabled: boolean) {
    ui.downloadVideoBtn.disabled = disabled
    ui.downloadSrtBtn.disabled = disabled
    ui.exportFormat.disabled = disabled
    ui.exportQuality.disabled = disabled
  }

  function sourceBitrateFor(duration: number) {
    const file = selectedVideoFile()
    if (!file || !Number.isFinite(duration) || duration <= 0) return 0
    return Math.round((file.size * 8) / duration)
  }

  function videoBitrateFor(quality: ExportQuality, width: number, height: number) {
    const pixels = Math.max(640 * 360, (width || 1280) * (height || 720))
    const resolutionBitrate = Math.round(
      pixels * 30 * QUALITY_BITS_PER_PIXEL[quality],
    )
    const sourceBitrate = sourceBitrateFor(ui.video.duration)
    const sourceAwareMax = sourceBitrate
      ? Math.round(sourceBitrate * QUALITY_SOURCE_MULTIPLIER[quality])
      : Number.POSITIVE_INFINITY
    const bitrate = Math.min(resolutionBitrate, sourceAwareMax)
    const targetBitrate = Math.max(
      QUALITY_MIN_BITRATE[quality],
      Math.min(QUALITY_MAX_BITRATE[quality], bitrate),
    )
    console.info("[export] video bitrate target", {
      quality,
      sourceBitrate,
      targetBitrate,
      width,
      height,
    })
    return Math.max(
      QUALITY_MIN_BITRATE[quality],
      Math.min(QUALITY_MAX_BITRATE[quality], targetBitrate),
    )
  }

  function recorderMimeType(format: ExportFormat) {
    return RECORDER_MIME_TYPES[format].find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    )
  }

  async function webCodecsVideoCodec(
    mediabunny: any,
    settings: ExportSettings,
    bitrate: number,
  ) {
    const candidates = settings.format === "mp4" ? ["avc"] : ["vp9", "vp8"]
    for (const codec of candidates) {
      try {
        const supported = await mediabunny.canEncodeVideo?.(codec, {
          width: ui.video.videoWidth || undefined,
          height: ui.video.videoHeight || undefined,
          bitrate,
        })
        if (supported) return codec
      } catch {}
    }
    return candidates[0]
  }

  function downloadBlob(blob: Blob, settings: ExportSettings) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${baseFileName()}.${activeLang()}.${settings.format}`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function downloadVideo() {
    const segments = currentSegments()
    if (!segments.length || isExporting()) return

    const settings = exportSettings()
    setExporting(true)
    setExportControlsDisabled(true)
    ui.transcribeBtn.disabled = true
    ui.backBtn.disabled = true

    try {
      let fallbackReason = getWebCodecsSupportIssue()
      if (!fallbackReason) {
        const result = await exportWithWebCodecs(segments, settings)
        if (result.handled) return
        fallbackReason = result.reason
      }
      if (fallbackReason) {
        console.warn(
          "[export] WebCodecs unavailable; using recorder fallback:",
          fallbackReason,
        )
      }
      await exportWithRecorder(segments, settings, fallbackReason)
    } finally {
      setExporting(false)
      ui.backBtn.disabled = false
      ui.transcribeBtn.disabled = false
      enableExports(true)
    }
  }

  async function exportWithWebCodecs(
    segments: any[],
    settings: ExportSettings,
  ): Promise<WebCodecsExportResult> {
    let mediabunny: any
    try {
      mediabunny = await import("mediabunny")
    } catch (e) {
      console.warn("[export] mediabunny failed to load, falling back", e)
      return {
        handled: false,
        reason: tt("exportErrors.mediabunnyLoadFailed", {
          error: errorMessage(e),
        }),
      }
    }

    const {
      Input,
      Output,
      Conversion,
      BlobSource,
      ALL_FORMATS,
      Mp4OutputFormat,
      WebMOutputFormat,
      BufferTarget,
    } = mediabunny

    modal.openExportModal()
    modal.setExportStep("prepare", "active")
    modal.setExportStage(tt("exportStages.preparingEncoder"), "busy")
    ui.exportHint.textContent = tt("exportStages.renderingLocally")

    const file = selectedVideoFile()
    if (!file) {
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsMissingFile"),
      }
    }

    let input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    })
    const output = new Output({
      format:
        settings.format === "mp4"
          ? new Mp4OutputFormat()
          : new WebMOutputFormat(),
      target: new BufferTarget(),
    })
    const videoBitrate = videoBitrateFor(
      settings.quality,
      ui.video.videoWidth,
      ui.video.videoHeight,
    )
    const videoCodec = await webCodecsVideoCodec(
      mediabunny,
      settings,
      videoBitrate,
    )

    let canvas: any = null
    let ctx: any = null

    // For MP4, probe the source audio codec. If it's not AAC-LC (mp4a.40.2),
    // QuickTime will show an "incompatible content" warning (HE-AAC, Opus, etc.).
    // When ffmpeg is available, use it to transcode the audio to AAC-LC before
    // passing the file to mediabunny — ffmpeg handles HE-AAC/SBR correctly while
    // WebCodecs decoders often don't, causing severe quality degradation.
    if (settings.format === "mp4" && remuxAudioToAacLc) {
      try {
        const audioTracks = await input.getAudioTracks()
        const firstTrack = audioTracks[0]
        if (firstTrack) {
          const codecStr = await firstTrack.getCodecParameterString()
          if (codecStr !== "mp4a.40.2") {
            modal.setExportStage(tt("exportStages.preparingEncoder"), "busy")
            const remuxed = await remuxAudioToAacLc(file)
            // Replace input with the remuxed version (AAC-LC audio, video unchanged)
            input = new Input({ source: new BlobSource(remuxed), formats: ALL_FORMATS })
          }
        }
      } catch {
        // If probing or remux fails, continue with original input
      }
    }

    let conversion: any
    try {
      conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: videoCodec,
          bitrate: videoBitrate,
          latencyMode: "quality",
          keyFrameInterval: settings.quality === "optimized" ? 4 : 2,
          process: (sample: any) => {
            if (!ctx) {
              canvas = new OffscreenCanvas(
                sample.displayWidth,
                sample.displayHeight,
              )
              ctx = canvas.getContext("2d")
            }
            sample.draw(ctx, 0, 0)
            drawSubtitlesAt(
              ctx,
              sample.timestamp,
              canvas.width,
              canvas.height,
              segments,
            )
            return canvas
          },
        },
      })
    } catch (e) {
      console.warn("[export] WebCodecs init failed, falling back", e)
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsInitFailed", {
          error: errorMessage(e),
        }),
      }
    }

    if (!conversion.isValid) {
      console.warn(
        "[export] WebCodecs conversion invalid, falling back",
        conversion.discardedTracks,
      )
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsInvalid", {
          tracks: formatDiagnostic(conversion.discardedTracks),
        }),
      }
    }

    // Audio tracks can be silently dropped when the browser can't encode the required
    // codec (e.g. AAC for MP4). isValid stays true because MP4 doesn't require audio,
    // so we have to catch this separately and fall back to the recorder which captures
    // audio directly from the video element.
    const droppedAudio = conversion.discardedTracks.some(
      (t: any) => t.track?.type === "audio" && t.reason !== "discarded_by_user",
    )
    if (droppedAudio) {
      console.warn(
        "[export] Audio track dropped in WebCodecs path, falling back to recorder",
        conversion.discardedTracks,
      )
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsInvalid", {
          tracks: "audio",
        }),
      }
    }

    conversion.onProgress = (p: number) => {
      modal.setExportProgress(Math.min(95, p * 95))
    }

    modal.setExportStep("prepare", "done")
    modal.setExportStep("render", "active")
    modal.setExportStage(tt("exportStages.renderingVideo"), "busy")

    try {
      await conversion.execute()
    } catch (e: any) {
      console.error(e)
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsFailed", {
          error: errorMessage(e),
        }),
      }
    }

    modal.setExportStep("render", "done")
    modal.setExportStep("encode", "done")
    modal.setExportStep("done", "active")
    modal.setExportStage(tt("exportStages.saving"), "busy")

    const blob = new Blob([output.target.buffer], {
      type: `video/${settings.format}`,
    })
    downloadBlob(blob, settings)

    modal.setExportStep("done", "done")
    modal.setExportProgress(100)
    modal.setExportStage(tt("exportStages.exported"), "ok")
    ui.exportTitle.textContent = tt("exportStages.complete")
    ui.exportHint.hidden = true
    ui.exportClose.hidden = false
    setStatus(tt("videoExported"), "ok")
    return { handled: true }
  }

  async function exportWithRecorder(
    segments: any[],
    settings: ExportSettings,
    fallbackReason = "",
  ) {
    const video = ui.video

    modal.openExportModal()
    if (fallbackReason) {
      modal.setExportNotice(tt("exportStages.webcodecsFallbackNotice"))
    }

    const capture = video.captureStream
      ? video.captureStream.bind(video)
      : video.mozCaptureStream
        ? video.mozCaptureStream.bind(video)
        : null
    if (!capture || typeof MediaRecorder === "undefined") {
      modal.failExport(
        fallbackReason
          ? tt("exportErrors.noSupportAfterFallback")
          : tt("exportErrors.noSupport"),
      )
      return
    }

    const w = video.videoWidth || 1280
    const h = video.videoHeight || 720
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")

    const canvasStream = canvas.captureStream(30)
    let hasAudio = false
    try {
      const elementStream = capture()
      elementStream.getAudioTracks().forEach((track: MediaStreamTrack) => {
        canvasStream.addTrack(track)
        hasAudio = true
      })
    } catch (e) {
      console.warn("No audio track for the export", e)
    }

    const mimeType = recorderMimeType(settings.format)
    if (!mimeType) {
      modal.failExport(
        tt("exportErrors.formatNotSupported", {
          format: settings.format.toUpperCase(),
        }),
      )
      return
    }
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: videoBitrateFor(settings.quality, w, h),
      })
    } catch (e) {
      console.error(e)
      modal.failExport(tt("exportErrors.recordStart"))
      return
    }

    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        modal.setExportStep("render", "done")
        modal.setExportStep("encode", "active")
        modal.setExportStage(tt("exportStages.generatingFile"), "busy")
        const blob = new Blob(chunks, { type: mimeType })
        downloadBlob(blob, settings)
        resolve()
      }
    })

    const previousVolume = video.volume
    const wasMuted = video.muted
    video.muted = true
    video.volume = 0

    modal.setExportStage(tt("exportStages.preparingVideo"), "busy")
    video.pause()
    try {
      video.currentTime = 0
    } catch {}
    await new Promise((r) => setTimeout(r, 150))

    modal.setExportStep("prepare", "done")
    modal.setExportStep("render", "active")
    modal.setExportStage(
      hasAudio
        ? tt("exportStages.recordingAudio")
        : tt("exportStages.recordingNoAudio"),
      "busy",
    )
    ui.exportHint.textContent = tt("exportStages.keepTabActive")

    let raf = 0
    let stopped = false
    const stopRecording = () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      video.removeEventListener("ended", onEnded)
      if (recorder.state !== "inactive") recorder.stop()
    }
    const onEnded = () => stopRecording()

    const tick = () => {
      if (ctx) drawFrame(ctx, video, w, h, segments)
      const dur = video.duration
      if (dur && isFinite(dur)) {
        modal.setExportProgress(Math.min(94, (video.currentTime / dur) * 94))
        if (video.currentTime >= dur - 0.05) {
          stopRecording()
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }

    video.addEventListener("ended", onEnded)
    recorder.start(100)
    tick()

    try {
      await video.play()
    } catch (e) {
      console.error(e)
      stopRecording()
      recorder.onstop = null
      if (recorder.state !== "inactive") recorder.stop()
      video.muted = wasMuted
      video.volume = previousVolume
      modal.failExport(tt("exportErrors.playbackBlocked"))
      return
    }

    await finished

    video.muted = wasMuted
    video.volume = previousVolume

    modal.setExportStep("encode", "done")
    modal.setExportStep("done", "done")
    modal.setExportProgress(100)
    modal.setExportStage(tt("exportStages.exported"), "ok")
    ui.exportTitle.textContent = tt("exportStages.complete")
    ui.exportHint.hidden = true
    ui.exportClose.hidden = false
    setStatus(tt("videoExported"), "ok")
  }

  return {
    downloadVideo,
  }
}
