import { hasBuiltInTranslationSupport } from "@/scripts/builtInSupport.ts";
import { cutRangesFromSegments } from "@/scripts/cuts.ts";
import { createDownloadsController } from "@/scripts/downloads.ts";
import type {
  AppState,
  Editor,
  Segment,
  TrackRole,
  VisibleTrack,
} from "@/scripts/editor.ts";
import type { createVideoExporter } from "@/scripts/export/videoExport.ts";
import { createExportModal } from "@/scripts/export/exportModal.ts";
import { baseFileName, prettifyBytes } from "@/scripts/file.ts";
import { I18N, langName, tt } from "@/scripts/i18n.ts";
import { createStageManager } from "@/scripts/stageManager.ts";
import { createConfigStageController } from "@/scripts/stages/configStage.ts";
import { createSubtitlePreview } from "@/scripts/stages/subtitlePreview.ts";
import { createUploadStageController } from "@/scripts/stages/uploadStage.ts";
import { createTransformersClient } from "@/scripts/transformersClient.ts";
import type { createTranslationService } from "@/scripts/translation.ts";
import { ui } from "@/scripts/ui.ts";

const {
  downloads,
  renderDownloads,
  updateDownloadStatus,
  makeTransformersTracker,
  fetchWithProgress,
  refreshClearModelsUI,
  clearLocalModels,
} = createDownloadsController({
  ui,
  tt,
  prettifyBytes,
  hasBuiltInTranslationSupport,
});

// ── State ──
let selectedVideoFile: File | null = null
let videoObjectUrl = ""
let exporting = false
// 16 kHz mono audio of the current video, drawn as the timeline waveform.
let waveformAudio: Float32Array | null = null
const state: AppState = {
  detectedLang: "",
  baseSegments: [],
  segmentsByLang: {},
  orderedLangs: [],
  activeLang: "",
  dualTrackMode: false,
  dualTrackLangs: [],
  trackStates: {},
}

const { setStage } = createStageManager({ ui });
const asrTracker = makeTransformersTracker("asr");
const translationTracker = makeTransformersTracker("translation");
const transformersClient = createTransformersClient({
  onProgress(key, payload) {
    if (key === "asr") asrTracker(payload);
    else if (key === "translation") translationTracker(payload);
  },
});

// ── Lazily loaded chunks ──
// The landing page only needs the upload and config stages. The editor and
// the translation service load once the user starts picking a file, and the
// video exporter once there are subtitles to export.
let editor: Editor | null = null;
let editorLoading: Promise<Editor> | null = null;
function loadEditor() {
  editorLoading ??= import("@/scripts/editor.ts")
    .then(({ createEditor }) => {
      editor = createEditor({
        ui,
        tt,
        I18N,
        langName,
        state,
        currentSegments,
        visibleTracks,
        trackRole,
        trackState,
        translateSegments,
        isTranslationReady,
        cutRanges,
        selectedVideoFile: () => selectedVideoFile,
        isExporting: () => exporting,
        setStage,
        onExportsEnabled: warmVideoExporter,
      });
      if (waveformAudio) editor.setWaveformAudio(waveformAudio);
      return editor;
    })
    .catch((error) => {
      editorLoading = null;
      throw error;
    });
  return editorLoading;
}

type TranslationService = ReturnType<typeof createTranslationService>;
let translationService: TranslationService | null = null;
let translationLoading: Promise<TranslationService> | null = null;
function loadTranslationService() {
  translationLoading ??= import("@/scripts/translation.ts")
    .then(({ createTranslationService }) => {
      translationService = createTranslationService({
        downloads,
        renderDownloads,
        updateDownloadStatus,
        transformersClient,
        tt,
        langName,
        setStatus: configStageController.setStatus,
      });
      return translationService;
    })
    .catch((error) => {
      translationLoading = null;
      throw error;
    });
  return translationLoading;
}

const translateSegments = async (
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
) =>
  (await loadTranslationService()).translateSegments(
    segments,
    sourceLang,
    targetLang,
  );

const isTranslationReady = () => !!translationService?.isTranslationReady();

type VideoExporter = ReturnType<typeof createVideoExporter>;
let videoExporter: Promise<VideoExporter> | null = null;
function loadVideoExporter() {
  videoExporter ??= import("@/scripts/export/videoExport.ts")
    .then(({ createVideoExporter }) =>
      createVideoExporter(videoExporterOptions()),
    )
    .catch((error) => {
      videoExporter = null;
      throw error;
    });
  return videoExporter;
}
// Warm the exporter up as soon as there's something to export.
function warmVideoExporter(on: boolean) {
  if (on) loadVideoExporter().catch(() => {});
}
async function downloadVideo() {
  const exporter = await loadVideoExporter();
  await exporter.downloadVideo();
}

// ── Tracks ──
function currentSegments(): Segment[] {
  return state.segmentsByLang[state.activeLang] || [];
}

// Only words explicitly marked as cut remove media from the video.
function cutRanges() {
  return cutRangesFromSegments(state.segmentsByLang[state.detectedLang]);
}

function trackLabel(lang: string) {
  if (state.dualTrackMode && lang === state.detectedLang)
    return tt("tracks.transcription", { lang: langName(lang) });
  if (state.dualTrackMode && state.dualTrackLangs.includes(lang))
    return tt("tracks.subtitles", { lang: langName(lang) });
  return langName(lang);
}

function trackRole(lang: string): TrackRole {
  if (state.dualTrackMode && lang === state.detectedLang) return "transcription";
  if (state.dualTrackMode && state.dualTrackLangs.includes(lang))
    return "subtitles";
  return "default";
}

function visibleTrackLangs() {
  const langs =
    state.dualTrackMode && state.dualTrackLangs.includes(state.activeLang)
      ? state.dualTrackLangs
      : [state.activeLang];
  return langs.filter((lang, index) => lang && langs.indexOf(lang) === index);
}

function trackState(lang: string) {
  return state.trackStates[lang] || {};
}

function visibleTracks(): VisibleTrack[] {
  return visibleTrackLangs()
    .map((lang) => ({
      lang,
      label: trackLabel(lang),
      role: trackRole(lang),
      segments: state.segmentsByLang[lang] || [],
      hidden: !!trackState(lang).hidden,
      locked: !!trackState(lang).locked,
    }))
    .filter((track) => track.segments.length);
}

function currentVideoSegments(): any[] {
  const tracks = visibleTracks().filter((track) => !track.hidden);
  return tracks.length ? tracks : [];
}

function resetEditorState() {
  state.detectedLang = "";
  state.baseSegments = [];
  state.segmentsByLang = {};
  state.orderedLangs = [];
  state.activeLang = "";
  state.dualTrackMode = false;
  state.dualTrackLangs = [];
  state.trackStates = {};
  waveformAudio = null;
  editor?.setWaveformAudio(null);
}

// Until the editor chunk is loaded there's nothing on screen to update: it
// renders the current state when it's created.
function enableExports(on: boolean) {
  editor?.enableExports(on);
}

const exportModal = createExportModal({ ui, tt, isExporting: () => exporting });
const { closeExportModal } = exportModal;

const subtitlePreview = createSubtitlePreview({ ui });

const configStageController = createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile: () => selectedVideoFile,
  isExporting: () => exporting,
  setGeneratedState: (generated) => {
    Object.assign(state, generated, { trackStates: {} });
    editor?.enableWordAnimationForAll();
    editor?.syncActiveCaptionStyle();
  },
  setWaveformAudio: (audio) => {
    waveformAudio = audio;
    editor?.setWaveformAudio(audio);
  },
  renderTabs: () => editor?.renderTabs(),
  renderSegments: () => editor?.renderSegments(),
  enableExports,
  resetHistory: () => editor?.resetHistory(),
  updateCaption: () => editor?.updateCaption(),
  setStage,
  prepareEditor: loadEditor,
  onTranscriptPreview: subtitlePreview.setTranscript,
});

const uploadStageController = createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus: configStageController.setStatus,
  setProgress: configStageController.setProgress,
  isExporting: () => exporting,
  getVideoObjectUrl: () => videoObjectUrl,
  setVideoObjectUrl: (url) => {
    videoObjectUrl = url;
  },
  setSelectedVideoFile: (file) => {
    selectedVideoFile = file;
  },
  resetEditorState,
  setLangAddStatus: (...args) => editor?.setLangAddStatus(...args),
  populateAddLang: () => editor?.populateAddLang(),
  renderSegments: () => editor?.renderSegments(),
  enableExports,
  resetHistory: () => editor?.resetHistory(),
  startEarlyTranscription: (file) =>
    configStageController.startEarlyTranscription(file),
  resetTranscriptionCache: () =>
    configStageController.resetTranscriptionCache(),
});

const videoExporterOptions = (): Parameters<typeof createVideoExporter>[0] => ({
  ui,
  tt,
  currentSegments: currentVideoSegments,
  cutRanges,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => state.activeLang,
  baseFileName: () => baseFileName(selectedVideoFile),
  isExporting: () => exporting,
  setExporting: (value) => {
    exporting = value;
  },
  enableExports,
  setStatus: configStageController.setStatus,
  modal: exportModal,
  remuxAudioToAacLc: configStageController.remuxAudioToAacLc,
});

// ── Init ──
renderDownloads();
configStageController.schedulePreload();
setStage("upload");
uploadStageController.wireUploadStage();
configStageController.wireConfigStage();
subtitlePreview.wire();
ui.downloadVideoBtn.addEventListener("click", downloadVideo);
ui.exportClose.addEventListener("click", closeExportModal);
ui.exportBackdrop.addEventListener("click", closeExportModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal();
});
ui.downloadsToggle.addEventListener("click", () => {
  const opening = ui.downloadsPanel.hidden;
  ui.downloadsPanel.hidden = !opening;
  // The panel header already shows the status, so drop the dock label while open.
  ui.statusDock?.classList.toggle("panel-open", opening);
  if (opening) {
    renderDownloads();
    refreshClearModelsUI();
  }
});
ui.clearModelsBtn?.addEventListener("click", clearLocalModels);
