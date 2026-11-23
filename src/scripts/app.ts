import { hasBuiltInTranslationSupport } from "@/scripts/builtInSupport.ts";
import { createDownloadsController } from "@/scripts/downloads.ts";
import { prettifyBytes } from "@/scripts/file.ts";
import { tt } from "@/scripts/i18n.ts";
import type { AppSession } from "@/scripts/session.ts";
import { createStageManager } from "@/scripts/stageManager.ts";
import { createUploadStageController } from "@/scripts/stages/uploadStage.ts";
import { ui } from "@/scripts/ui.ts";

// Keep the ASR model ID inline here so the landing bundle doesn't pull in
// languages.ts (all language tables & preview samples) on first paint.
const ASR_MODEL_ID = "Xenova/whisper-base";

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

let videoObjectUrl = "";
let selectedFilePending: File | null = null;
const { setStage } = createStageManager({ ui });

// Config, audio extraction, transcription, editor and export live in a lazy
// chunk loaded on first intent (hover/focus/drag/sample) or when cached models
// are detected on idle.
let session: AppSession | null = null;
let sessionLoading: Promise<AppSession> | null = null;
function loadSession() {
  sessionLoading ??= import("@/scripts/session.ts")
    .then(({ createAppSession }) => {
      session = createAppSession({
        ui,
        setStage,
        downloads,
        renderDownloads,
        updateDownloadStatus,
        makeTransformersTracker,
        fetchWithProgress,
      });
      if (selectedFilePending) {
        session.setSelectedVideoFile(selectedFilePending);
        selectedFilePending = null;
      }
      return session;
    })
    .catch((error) => {
      sessionLoading = null;
      throw error;
    });
  return sessionLoading;
}

async function hasCachedAsrModel() {
  if (typeof caches === "undefined") return false;
  try {
    const keys = await caches.keys();
    for (const key of keys.filter((k) => /transformers/i.test(k))) {
      const requests = await (await caches.open(key)).keys();
      if (requests.some((request) => request.url.includes(ASR_MODEL_ID)))
        return true;
    }
  } catch (error) {
    console.warn("[preload] cache lookup failed", error);
  }
  return false;
}

let preloadStarted = false;
function startPreload() {
  if (preloadStarted) return;
  preloadStarted = true;
  void loadSession().then((s) => s.preloadAssetsInBackground());
}

function schedulePreload() {
  const intentEvents = ["pointerenter", "focusin", "touchstart"];
  const onIntent = () => {
    intentEvents.forEach((type) =>
      ui.dropzone.removeEventListener(type, onIntent),
    );
    window.removeEventListener("dragenter", onIntent);
    startPreload();
  };
  intentEvents.forEach((type) =>
    ui.dropzone.addEventListener(type, onIntent, { passive: true }),
  );
  window.addEventListener("dragenter", onIntent);
  void hasCachedAsrModel().then((cached) => {
    if (!cached) return;
    if ("requestIdleCallback" in window) requestIdleCallback(onIntent);
    else setTimeout(onIntent, 200);
  });
}

const uploadStageController = createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus: (message, kind = "ok") => {
    if (session) session.setStatus(message, kind);
    else {
      ui.configStatus.textContent = message;
      ui.configStatus.dataset.kind = kind;
    }
  },
  setProgress: (percent) => {
    if (session) session.setProgress(percent);
    else {
      ui.configProgressFill.style.transform = `scaleX(${Math.max(0, Math.min(100, percent)) / 100})`;
      ui.configProgressPct.textContent = `${Math.round(percent)}%`;
    }
  },
  isExporting: () => session?.isExporting() ?? false,
  getVideoObjectUrl: () => videoObjectUrl,
  setVideoObjectUrl: (url) => {
    videoObjectUrl = url;
  },
  setSelectedVideoFile: (file) => {
    if (session) session.setSelectedVideoFile(file);
    else selectedFilePending = file;
  },
  resetEditorState: () => session?.resetEditorState(),
  setLangAddStatus: (...args) => session?.setLangAddStatus(...args),
  populateAddLang: () => session?.populateAddLang(),
  renderSegments: () => session?.renderSegments(),
  enableExports: (on) => session?.enableExports(on),
  resetHistory: () => session?.resetHistory(),
  startEarlyTranscription: (file) => {
    void loadSession().then((s) => s.startEarlyTranscription(file));
  },
  resetTranscriptionCache: () => session?.resetTranscriptionCache(),
  generate: () => {
    void loadSession().then((s) => s.generate());
  },
  onSampleIntent: () => {
    void loadSession();
  },
});

// ── Init ──
renderDownloads();
schedulePreload();
setStage("upload");
uploadStageController.wireUploadStage();
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
