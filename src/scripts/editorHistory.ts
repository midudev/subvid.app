type HistoryState<TSegmentsByLang> = {
  segmentsByLang: TSegmentsByLang
  orderedLangs: string[]
  activeLang: string
  dualTrackMode?: boolean
  dualTrackLangs?: string[]
  trackStates?: Record<string, { hidden?: boolean; locked?: boolean }>
}

type EditorHistoryOptions<TSegmentsByLang> = {
  getState: () => HistoryState<TSegmentsByLang>
  restoreState: (state: HistoryState<TSegmentsByLang>) => void
  refreshButtons: (canUndo: boolean, canRedo: boolean) => void
  onRestore: () => void
  limit?: number
}

export function createEditorHistory<TSegmentsByLang>({
  getState,
  restoreState,
  refreshButtons,
  onRestore,
  limit = 100,
}: EditorHistoryOptions<TSegmentsByLang>) {
  let undoStack: string[] = []
  let redoStack: string[] = []

  function snapshotSegments() {
    return JSON.stringify(getState())
  }

  function refreshHistoryButtons() {
    refreshButtons(undoStack.length > 0, redoStack.length > 0)
  }

  function resetHistory() {
    undoStack = []
    redoStack = []
    refreshHistoryButtons()
  }

  function pushHistory(snapshotBefore: string) {
    undoStack.push(snapshotBefore)
    if (undoStack.length > limit) undoStack.shift()
    redoStack = []
    refreshHistoryButtons()
  }

  function restoreSnapshot(json: string) {
    restoreState(JSON.parse(json))
    onRestore()
  }

  function undo() {
    if (!undoStack.length) return
    redoStack.push(snapshotSegments())
    restoreSnapshot(undoStack.pop()!)
    refreshHistoryButtons()
  }

  function redo() {
    if (!redoStack.length) return
    undoStack.push(snapshotSegments())
    restoreSnapshot(redoStack.pop()!)
    refreshHistoryButtons()
  }

  return {
    snapshotSegments,
    pushHistory,
    resetHistory,
    undo,
    redo,
  }
}
