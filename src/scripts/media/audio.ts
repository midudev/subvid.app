import { FFmpeg } from "@ffmpeg/ffmpeg"
// @ffmpeg/ffmpeg always spawns its worker with { type: "module" }, so the
// worker must use import() (not importScripts). We let Vite bundle the ESM
// worker — resolving its relative imports — and serve it same-origin.
import ffmpegWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url"
import { fetchFile } from "@ffmpeg/util"

type AudioServiceOptions = {
  tt: (path: string, vars?: Record<string, unknown>) => string
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>
  updateDownloadStatus: (key: string, state: string) => void
  setStatus: (message: string, kind?: string) => void
  setProgress: (percent: number) => void
  applyProgress: (percent: number) => void
  setIndeterminate: (on: boolean) => void
  startProgressCreep: (from: number, ceiling: number, expected: number) => void
  stopProgressCreep: () => void
}

export function createAudioService(options: AudioServiceOptions) {
  let ffmpeg: any = null
  let ffmpegLoading: Promise<any> | null = null

  async function ensureFfmpeg() {
    if (ffmpeg) return ffmpeg
    if (ffmpegLoading) return ffmpegLoading
    ffmpegLoading = loadFfmpeg()
    try {
      ffmpeg = await ffmpegLoading
      return ffmpeg
    } finally {
      ffmpegLoading = null
    }
  }

  async function loadFfmpeg() {
    options.updateDownloadStatus("ffmpeg", "downloading")
    const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm"
    const coreURL = `${coreBase}/ffmpeg-core.js`
    console.info("[ffmpeg] fetching core WASM…")
    const wasmURL = await options.fetchWithProgress(
      `${coreBase}/ffmpeg-core.wasm`,
      "ffmpeg",
      "application/wasm",
      32232419,
    )
    console.info("[ffmpeg] core WASM ready:", wasmURL)

    const classWorkerURL = ffmpegWorkerURL
    console.info("[ffmpeg] class worker url:", classWorkerURL)

    const instance = new FFmpeg()
    instance.on("log", ({ type, message }: any) => {
      console.info(`[ffmpeg:${type}] ${message}`)
    })

    console.info("[ffmpeg] calling load()…")
    const t0 = performance.now()
    const watchdog = setInterval(() => {
      console.warn(
        `[ffmpeg] load() still pending after ${Math.round(
          (performance.now() - t0) / 1000,
        )}s`,
      )
    }, 3000)
    try {
      await instance.load({ classWorkerURL, coreURL, wasmURL })
      console.info(
        `[ffmpeg] load() resolved in ${Math.round(performance.now() - t0)}ms`,
      )
    } catch (err) {
      console.error("[ffmpeg] load() failed:", err)
      throw err
    } finally {
      clearInterval(watchdog)
    }
    options.updateDownloadStatus("ffmpeg", "ready")
    return instance
  }

  async function decodeWavPcm16(
    bytes: Uint8Array,
    onProgress?: (ratio: number) => void,
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.byteLength < 44) return null
    if (view.getUint32(0, false) !== 0x52494646) return null
    if (view.getUint32(8, false) !== 0x57415645) return null

    let offset = 12
    let channels = 0
    let audioFormat = 0
    let bitsPerSample = 0
    let dataOffset = -1
    let dataLength = 0
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false)
      const size = view.getUint32(offset + 4, true)
      const body = offset + 8
      if (id === 0x666d7420 /* 'fmt ' */) {
        audioFormat = view.getUint16(body, true)
        channels = view.getUint16(body + 2, true)
        bitsPerSample = view.getUint16(body + 14, true)
      } else if (id === 0x64617461 /* 'data' */) {
        dataOffset = body
        dataLength = Math.min(size, view.byteLength - body)
      }
      offset = body + size + (size & 1)
    }
    if (audioFormat !== 1 || bitsPerSample !== 16 || dataOffset < 0) return null

    const ch = Math.max(1, channels)
    const stride = 2 * ch
    const frames = Math.floor(dataLength / stride)
    const out = new Float32Array(frames)
    const BLOCK = 96_000
    for (let i = 0; i < frames; i += BLOCK) {
      const end = Math.min(frames, i + BLOCK)
      for (let f = i; f < end; f++) {
        out[f] = view.getInt16(dataOffset + f * stride, true) / 32768
      }
      onProgress?.(frames ? end / frames : 1)
      await new Promise((r) => setTimeout(r, 0))
    }
    return out
  }

  async function extractAudioBuffer(file: File) {
    const inputName = "input-video"
    const outputName = "audio.wav"

    options.setIndeterminate(true)
    options.setStatus(options.tt("steps.loadingFfmpeg"), "busy")
    const worker = await ensureFfmpeg()
    options.setStatus(options.tt("steps.readingVideo"), "busy")
    await worker.writeFile(inputName, await fetchFile(file))
    options.setStatus(options.tt("steps.extractingAudio"), "busy")
    await worker.exec([
      "-i",
      inputName,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputName,
    ])

    options.setStatus(options.tt("steps.readingAudio"), "busy")
    options.setProgress(32)
    const outputData = await worker.readFile(outputName)
    await worker.deleteFile(inputName)
    await worker.deleteFile(outputName)
    options.applyProgress(34)

    const bytes =
      outputData instanceof Uint8Array
        ? outputData
        : new Uint8Array(outputData as ArrayBuffer)

    options.setStatus(options.tt("steps.decodingAudio"), "busy")
    let copied = await decodeWavPcm16(bytes, (ratio) => {
      options.applyProgress(34 + ratio * 4)
    })

    if (!copied) {
      options.startProgressCreep(34, 38, 2500)
      const audioContext = new AudioContext({ sampleRate: 16000 })
      const decoded = await audioContext.decodeAudioData(bytes.buffer.slice(0))
      const mono = decoded.getChannelData(0)
      copied = new Float32Array(mono.length)
      copied.set(mono)
      await audioContext.close()
      options.stopProgressCreep()
    }

    options.setProgress(38)
    return copied
  }

  async function remuxAudioToAacLc(file: File): Promise<Blob> {
    const worker = await ensureFfmpeg()
    const inputName = "export-source.mp4"
    const outputName = "export-aac.mp4"
    try {
      await worker.writeFile(inputName, await fetchFile(file))
      await worker.exec([
        "-i", inputName,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        outputName,
      ])
      const data = await worker.readFile(outputName)
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      return new Blob([bytes], { type: "video/mp4" })
    } finally {
      await worker.deleteFile(inputName).catch(() => {})
      await worker.deleteFile(outputName).catch(() => {})
    }
  }

  return {
    ensureFfmpeg,
    decodeWavPcm16,
    extractAudioBuffer,
    remuxAudioToAacLc,
  }
}
