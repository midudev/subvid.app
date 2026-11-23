import {
  builtInBackendLabel,
  resolveTranslationBackend,
  translateCuesBuiltIn,
} from "@/scripts/builtInTranslate.ts"
import {
  LANGS,
  MARIAN_TRANSLATION_MODELS,
  TRANSLATION_MODEL,
} from "@/scripts/languages.ts"

const BRACKETED_SOUND_TRANSLATIONS: Record<string, Record<string, string>> = {
  es: {
    APPLAUSE: "APLAUSOS",
    CLAPPING: "APLAUSOS",
    LAUGHTER: "RISAS",
    LAUGHING: "RISAS",
    MUSIC: "MUSICA",
    CHEERING: "VITORES",
    SILENCE: "SILENCIO",
    NOISE: "RUIDO",
    "BACKGROUND NOISE": "RUIDO DE FONDO",
    INAUDIBLE: "INAUDIBLE",
    SIGH: "SUSPIRO",
    COUGH: "TOS",
    COUGHING: "TOS",
    CRYING: "LLANTO",
    GASP: "JADEO",
    BEEP: "PITIDO",
    WHISTLE: "SILBIDO",
  },
}

const BRACKETED_CUE_PATTERN = /\[([^\[\]]{1,80})\]/g
const MARIAN_BATCH_SIZE = 1
const NLLB_BATCH_SIZE = 32
const NOISY_PUNCTUATION_RUN = /(?:[.!?…]\s*){4,}/gu
const NOISY_TRANSLATION_TAIL = /[.!?…](?:\s*[.!?…¡¿,;:>]){3,}.*$/u
const REPEATED_TRAILING_SYMBOLS = /(?:[^\p{L}\p{N}\s])(?:\s*[^\p{L}\p{N}\s]){3,}\s*$/u
const TRANSLATION_DEBUG = import.meta.env.DEV
const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

type TranslationBackend = "prompt" | "marian" | "nllb"

function soundCueKey(label: string) {
  return label
    .trim()
    .replace(/^[\s.!?¡¿…]+|[\s.!?¡¿…]+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function translatedSoundCueLabels(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return []

  const labels: string[] = []
  for (const match of text.matchAll(BRACKETED_CUE_PATTERN)) {
    const translated = glossary[soundCueKey(match[1])]
    if (translated) labels.push(translated)
  }
  return labels
}

function translateBracketedSoundCues(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return text

  return text.replace(BRACKETED_CUE_PATTERN, (match, label) => {
    const translated = glossary[soundCueKey(label)]
    return translated ? `[${translated}]` : match
  })
}

function enforceBracketedSoundCues(
  translatedText: string,
  sourceText: string,
  targetLang: string,
) {
  const expectedLabels = translatedSoundCueLabels(sourceText, targetLang)
  if (!expectedLabels.length) return translatedText

  let labelIndex = 0
  const text = translatedText.replace(BRACKETED_CUE_PATTERN, (match) => {
    const label = expectedLabels[labelIndex]
    if (!label) return match
    labelIndex += 1
    return `[${label}]`
  })

  if (labelIndex >= expectedLabels.length) return text

  const missingLabels = expectedLabels
    .slice(labelIndex)
    .map((label) => `[${label}]`)
    .join(" ")
  return `${text.trimEnd()} ${missingLabels}`.trim()
}

function terminalPunctuationForSource(sourceText = "", fallbackRun = "") {
  const source = sourceText.trim()
  if (/[?？]\s*$/.test(source)) return "?"
  if (/[!！]\s*$/.test(source)) return "!"
  if (/[.…]\s*$/.test(source)) return "."
  if (fallbackRun.includes("?")) return "?"
  if (fallbackRun.includes("!")) return "!"
  return "."
}

function cleanTranslationArtifacts(text: string, sourceText = "") {
  let cleaned = String(text || "").trim()
  let previous = ""
  while (cleaned && cleaned !== previous) {
    previous = cleaned
    cleaned = cleaned
      .replace(NOISY_TRANSLATION_TAIL, (tail, offset, fullText) => {
        const prefix = fullText.slice(0, offset).trimEnd()
        if (!prefix) return ""
        if (/[.!?…]\s*$/.test(prefix)) return prefix
        return `${prefix}${terminalPunctuationForSource(sourceText, tail)}`
      })
      .replace(NOISY_PUNCTUATION_RUN, (run) => {
        return terminalPunctuationForSource(sourceText, run)
      })
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([¿¡])\s+/g, "$1")
      .replace(REPEATED_TRAILING_SYMBOLS, "")
      .trimEnd()
  }
  return cleaned
}

function hasNoisyTranslationArtifacts(text: string) {
  NOISY_PUNCTUATION_RUN.lastIndex = 0
  return (
    NOISY_TRANSLATION_TAIL.test(text) ||
    NOISY_PUNCTUATION_RUN.test(text) ||
    REPEATED_TRAILING_SYMBOLS.test(text)
  )
}

// Bounded greedy decoding for both local models: caps the output length to the
// input and blocks repeated trigrams, which otherwise make quantized (CPU)
// models loop ("The The The…") until they hit the 200-token default.
function generationOptions(texts: string[]) {
  const maxChars = texts.reduce(
    (max, text) => Math.max(max, String(text || "").length),
    0,
  )
  const maxNewTokens = Math.max(8, Math.min(48, Math.ceil(maxChars / 5) + 6))
  return {
    do_sample: false,
    early_stopping: true,
    max_length: maxNewTokens,
    max_new_tokens: maxNewTokens,
    no_repeat_ngram_size: 3,
    num_beams: 1,
    repetition_penalty: 1.15,
  }
}

function rawTranslationText(value: any, fallback = "") {
  if (value == null) return fallback
  if (typeof value === "string") return value
  return value.translation_text || value.generated_text || JSON.stringify(value)
}

function logLocalTranslationBatch({
  backend,
  sourceLang,
  targetLang,
  batchNumber,
  totalBatches,
  input,
  raw,
  output,
  generation,
}: {
  backend: "marian" | "nllb"
  sourceLang: string
  targetLang: string
  batchNumber?: number
  totalBatches?: number
  input: string[]
  raw: any
  output: string[]
  generation?: Record<string, unknown>
}) {
  if (!TRANSLATION_DEBUG) return

  const rawItems = Array.isArray(raw) ? raw : [raw]
  const suffix =
    batchNumber && totalBatches ? ` batch ${batchNumber}/${totalBatches}` : ""
  console.groupCollapsed(
    `[translate:${backend}] ${sourceLang} -> ${targetLang}${suffix}`,
  )
  if (generation) console.debug("generation", generation)
  console.debug("request texts", input)
  console.table(
    input.map((text, index) => ({
      index,
      input: text,
      raw: rawTranslationText(rawItems[index], text),
      cleaned: output[index],
      changed: rawTranslationText(rawItems[index], text) !== output[index],
    })),
  )
  const noisyRows = rawItems
    .map((item, index) => ({
      index,
      raw: rawTranslationText(item, input[index] || ""),
      cleaned: output[index],
    }))
    .filter((row) => hasNoisyTranslationArtifacts(row.raw))
  if (noisyRows.length) {
    console.warn(`[translate:${backend}] cleaned noisy output`, noisyRows)
  }
  console.debug("raw result", raw)
  console.groupEnd()
}

type TranslationServiceOptions = {
  downloads: any
  renderDownloads: () => void
  updateDownloadStatus: (key: string, state: string) => void
  transformersClient: {
    call: (
      type: string,
      payload?: unknown,
      transfer?: Transferable[],
    ) => Promise<unknown>
  }
  tt: (path: string, vars?: Record<string, unknown>) => string
  langName: (code: string) => string
  setStatus: (message: string, kind?: string) => void
}

export function createTranslationService(options: TranslationServiceOptions) {
  let translationReady = false
  let activeTranslationBackend: TranslationBackend | null = null
  let activeTranslationModel = ""

  function markTranslationBuiltIn() {
    activeTranslationBackend = "prompt"
    activeTranslationModel = builtInBackendLabel()
    translationReady = true
    const item = options.downloads.translation
    item.readyNote = options.tt("downloads.translationBuiltin", {
      engine: builtInBackendLabel(),
    })
    item.total = 0
    item.loaded = 0
    options.updateDownloadStatus("translation", "ready")
  }

  async function ensureTransformersTranslator(
    backend: Exclude<TranslationBackend, "prompt">,
    model: string,
    requireWebGPU = false,
  ) {
    if (
      translationReady &&
      activeTranslationBackend === backend &&
      activeTranslationModel === model
    ) {
      return
    }

    activeTranslationBackend = backend
    activeTranslationModel = model
    options.updateDownloadStatus("translation", "downloading")
    options.downloads.translation.readyNote = ""
    options.setStatus(options.tt("steps.downloadingTranslation"), "busy")
    await options.transformersClient.call("ensure-translation", {
      backend,
      model,
      webgpu: hasWebGPU,
      requireWebGPU,
    })
    translationReady = true
    options.updateDownloadStatus("translation", "ready")
  }

  function marianModelForPair(sourceLang: string, targetLang: string) {
    return MARIAN_TRANSLATION_MODELS[`${sourceLang}:${targetLang}`]
  }

  async function ensureNllbTranslator() {
    await ensureTransformersTranslator("nllb", TRANSLATION_MODEL)
  }

  // MarianMT also runs on the CPU: measured against NLLB (both 8-bit on WASM),
  // it downloads 113 MB instead of 895 MB, translates ~8x faster and scores
  // better on both en→es and es→en.
  async function ensureMarianTranslator(sourceLang: string, targetLang: string) {
    const model = marianModelForPair(sourceLang, targetLang)
    if (!model) return false
    await ensureTransformersTranslator("marian", model)
    return true
  }

  async function ensureTranslation(sourceLang: string, targetLang: string) {
    const backend = await resolveTranslationBackend(sourceLang, targetLang)
    if (backend === "prompt") {
      options.updateDownloadStatus("translation", "downloading")
      options.downloads.translation.readyNote = ""
      return backend
    }
    if (backend === "marian") {
      try {
        if (await ensureMarianTranslator(sourceLang, targetLang)) return "marian"
      } catch (err) {
        console.warn("[translate] MarianMT failed to load, falling back to NLLB", err)
      }
    }

    await ensureNllbTranslator()
    return "nllb"
  }

  function normalizeNllbTranslations(translated: any, fallbackTexts: string[]) {
    const normalized = Array.isArray(translated) ? translated : [translated]
    return fallbackTexts.map((text, i) =>
      cleanTranslationArtifacts(rawTranslationText(normalized[i], text), text),
    )
  }

  async function translateNllbBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    batchNumber?: number,
    totalBatches?: number,
  ) {
    const translated: any = await options.transformersClient.call("translate", {
      texts,
      src: (LANGS as any)[sourceLang].nllb,
      tgt: (LANGS as any)[targetLang].nllb,
      generation: generationOptions(texts),
    })
    const output = normalizeNllbTranslations(translated, texts)
    logLocalTranslationBatch({
      backend: "nllb",
      sourceLang,
      targetLang,
      batchNumber,
      totalBatches,
      input: texts,
      raw: translated,
      output,
    })
    return output
  }

  async function translateMarianBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    batchNumber?: number,
    totalBatches?: number,
  ) {
    const generation = generationOptions(texts)
    const translated: any = await options.transformersClient.call("translate", {
      backend: "marian",
      generation,
      texts,
    })
    const output = normalizeNllbTranslations(translated, texts)
    logLocalTranslationBatch({
      backend: "marian",
      sourceLang,
      targetLang,
      batchNumber,
      totalBatches,
      input: texts,
      raw: translated,
      output,
      generation,
    })
    return output
  }

  async function translateWithBatches(
    texts: string[],
    targetLang: string,
    batchSize: number,
    translateBatch: (
      batch: string[],
      batchNumber: number,
      totalBatches: number,
    ) => Promise<string[]>,
  ) {
    const translatedTexts: string[] = []
    const totalBatches = Math.max(1, Math.ceil(texts.length / batchSize))

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const batchNumber = Math.floor(i / batchSize) + 1
      options.setStatus(
        options.tt("steps.translatingBatch", {
          lang: options.langName(targetLang),
          current: batchNumber,
          total: totalBatches,
        }),
        "busy",
      )
      translatedTexts.push(...(await translateBatch(batch, batchNumber, totalBatches)))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    return translatedTexts
  }

  async function translateWithNllb(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ) {
    await ensureNllbTranslator()
    return translateWithBatches(texts, targetLang, NLLB_BATCH_SIZE, (
      batch,
      batchNumber,
      totalBatches,
    ) =>
      translateNllbBatch(
        batch,
        sourceLang,
        targetLang,
        batchNumber,
        totalBatches,
      ),
    )
  }

  async function translateWithMarian(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ) {
    if (!(await ensureMarianTranslator(sourceLang, targetLang))) {
      throw new Error("MarianMT is unavailable for this language pair")
    }
    return translateWithBatches(texts, targetLang, MARIAN_BATCH_SIZE, (
      batch,
      batchNumber,
      totalBatches,
    ) =>
      translateMarianBatch(
        batch,
        sourceLang,
        targetLang,
        batchNumber,
        totalBatches,
      ),
    )
  }

  async function translateWithLocalFallback(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    preferMarian = true,
  ) {
    if (preferMarian && marianModelForPair(sourceLang, targetLang)) {
      try {
        return await translateWithMarian(texts, sourceLang, targetLang)
      } catch (err) {
        console.warn("[translate] MarianMT failed, falling back to NLLB", err)
      }
    }
    options.setStatus(
      options.tt("steps.translatingTo", { lang: options.langName(targetLang) }),
      "busy",
    )
    return translateWithNllb(texts, sourceLang, targetLang)
  }

  async function translateSegments(
    segments: any[],
    sourceLang: string,
    targetLang: string,
  ) {
    if (!segments.length || sourceLang === targetLang)
      return segments.map((s) => ({ ...s }))
    if (!(LANGS as any)[sourceLang] || !(LANGS as any)[targetLang])
      return segments.map((s) => ({ ...s }))

    options.setStatus(
      options.tt("steps.translatingTo", { lang: options.langName(targetLang) }),
      "busy",
    )

    const preparedTexts = segments.map((s) =>
      translateBracketedSoundCues(s.text, targetLang),
    )
    const cues = segments.map((s, i) => ({
      text: preparedTexts[i],
      start: s.start,
      end: s.end,
    }))
    const backend = await ensureTranslation(sourceLang, targetLang)

    let translatedTexts
    if (backend === "nllb") {
      translatedTexts = await translateWithNllb(
        preparedTexts,
        sourceLang,
        targetLang,
      )
    } else if (backend === "marian") {
      translatedTexts = await translateWithLocalFallback(
        preparedTexts,
        sourceLang,
        targetLang,
      )
    } else {
      let announcedDownload = false
      const onModelProgress = (ratio: number) => {
        if (!announcedDownload && ratio < 1) {
          announcedDownload = true
          options.setStatus(options.tt("steps.downloadingTranslation"), "busy")
        }
        options.downloads.translation.progress = Math.min(99, Math.round(ratio * 100))
        options.renderDownloads()
      }
      try {
        translatedTexts = await translateCuesBuiltIn(cues, sourceLang, targetLang, {
          onProgress: onModelProgress,
          onReady: markTranslationBuiltIn,
          onBatch: (current: number, total: number) => {
            options.setStatus(
              options.tt("steps.translatingBatch", {
                lang: options.langName(targetLang),
                current,
                total,
              }),
              "busy",
            )
          },
          sourceLabel: (LANGS as any)[sourceLang].label,
          targetLabel: (LANGS as any)[targetLang].label,
        })
        markTranslationBuiltIn()
      } catch (err) {
        console.warn("[translate] built-in failed, falling back to NLLB", err)
        options.setStatus(options.tt("steps.translationFallback"), "busy")
        translatedTexts = await translateWithLocalFallback(
          preparedTexts,
          sourceLang,
          targetLang,
        )
      }
    }

    return segments.map((s, i) => ({
      start: s.start,
      end: s.end,
      text:
        cleanTranslationArtifacts(
          enforceBracketedSoundCues(
            translatedTexts[i] || s.text,
            s.text,
            targetLang,
          ),
          s.text,
        ) || s.text,
    }))
  }

  return {
    ensureNllbTranslator,
    ensureTranslation,
    isTranslationReady: () => translationReady,
    translateSegments,
  }
}
