// Everything needed once the user interacts with a video: config stage,
// audio extraction, transcription, subtitle preview, editor & export wiring.
// Loaded lazily from app.ts so the landing page stays lightweight.
import { cutRangesFromSegments } from "@/scripts/cuts.ts";
import type {
  AppState,
  Editor,
  Segment,
  TrackRole,
  VisibleTrack,
} from "@/scripts/editor.ts";
import type { createVideoExporter } from "@/scripts/export/videoExport.ts";
import { createExportModal } from "@/scripts/export/exportModal.ts";
import { baseFileName } from "@/scripts/file.ts";
import { I18N, langName, tt } from "@/scripts/i18n.ts";
import type { Stage } from "@/scripts/stageManager.ts";
import { createConfigStageController } from "@/scripts/stages/configStage.ts";
import { createSubtitlePreview } from "@/scripts/stages/subtitlePreview.ts";
import { createTransformersClient } from "@/scripts/transformersClient.ts";
import type { createTranslationService } from "@/scripts/translation.ts";
import type { ui as appUi } from "@/scripts/ui.ts";

type SessionOptions = {
  ui: typeof appUi;
  setStage: (stage: Stage) => void;
  downloads: any;
  renderDownloads: () => void;
  updateDownloadStatus: (key: string, state: string) => void;
  makeTransformersTracker: (key: string) => (payload: unknown) => void;
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>;
};

export function createAppSession({
  ui,
  setStage,
  downloads,
  renderDownloads,
  updateDownloadStatus,
  makeTransformersTracker,
  fetchWithProgress,
}: SessionOptions) {
  let selectedVideoFile: File | null = null;
  let exporting = false;
  // Held only until the editor chunk loads and computes peaks, then released.
  let pendingWaveformAudio: Float32Array | null = null;
  const state: AppState = {
    detectedLang: "",
    baseSegments: [],
    segmentsByLang: {},
    orderedLangs: [],
    activeLang: "",
    dualTrackMode: false,
    dualTrackLangs: [],
    trackStates: {},
  };

  const asrTracker = makeTransformersTracker("asr");
  const translationTracker = makeTransformersTracker("translation");
  const transformersClient = createTransformersClient({
    onProgress(key, payload) {
      if (key === "asr") asrTracker(payload);
      else if (key === "translation") translationTracker(payload);
    },
  });

  // ── Lazily loaded chunks ──
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
        if (pendingWaveformAudio) {
          editor.setWaveformAudio(pendingWaveformAudio);
          pendingWaveformAudio = null;
        }
        return editor;
      })
      .catch((error) => {
        editorLoading = null;
        throw error;
      });
    return editorLoading;
  }

  let previewReaderLoading: Promise<void> | null = null;
  function loadPreviewReader() {
    previewReaderLoading ??= import("@/scripts/previewReader.ts")
      .then(({ createPreviewReader }) => {
        createPreviewReader({
          stage: ui.stageConfig,
          preview: ui.configPreview,
          video: ui.configVideo,
          progress: ui.configProgress,
          track: ui.configProgressTrack,
          fill: ui.configProgressFill,
        });
      })
      .catch(() => {
        previewReaderLoading = null;
      });
    return previewReaderLoading;
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
    if (state.dualTrackMode && lang === state.detectedLang)
      return "transcription";
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
    pendingWaveformAudio = null;
    editor?.setWaveformAudio(null);
  }

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
      if (editor) {
        editor.setWaveformAudio(audio);
        pendingWaveformAudio = null;
      } else {
        pendingWaveformAudio = audio;
      }
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

  const videoExporterOptions = (): Parameters<
    typeof createVideoExporter
  >[0] => ({
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

  configStageController.wireConfigStage();
  subtitlePreview.wire();
  ui.downloadVideoBtn.addEventListener("click", downloadVideo);
  ui.exportClose.addEventListener("click", closeExportModal);
  ui.exportBackdrop.addEventListener("click", closeExportModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal();
  });

  return {
    isExporting: () => exporting,
    setSelectedVideoFile: (file: File | null) => {
      selectedVideoFile = file;
    },
    resetEditorState,
    setLangAddStatus: (message: string, kind?: string) =>
      editor?.setLangAddStatus(message, kind),
    populateAddLang: () => editor?.populateAddLang(),
    renderSegments: () => editor?.renderSegments(),
    enableExports,
    resetHistory: () => editor?.resetHistory(),
    setStatus: configStageController.setStatus,
    setProgress: configStageController.setProgress,
    preloadAssetsInBackground: configStageController.preloadAssetsInBackground,
    startEarlyTranscription: (file: File) => {
      void loadPreviewReader();
      configStageController.startEarlyTranscription(file);
    },
    resetTranscriptionCache: () =>
      configStageController.resetTranscriptionCache(),
    generate: () => configStageController.generate(),
  };
}

export type AppSession = ReturnType<typeof createAppSession>;
