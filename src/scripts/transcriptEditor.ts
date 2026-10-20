// The transcript as a single editable document: one line per subtitle and one
// span per word. Text edits preserve the media; only the explicit cut action
// removes selected words from the video. Translation tracks are plain text.
import { keptParts, type TimeRange } from "@/scripts/cuts.ts"
import {
  estimatedWordsForSegment,
  wordsText,
  type SubtitleSegment,
  type SubtitleWord,
} from "@/scripts/subtitles.ts"

type Segment = SubtitleSegment
type WordRef = { line: number; word: number }
type WordHit = WordRef & {
  span: HTMLElement
  from: number
  to: number
  partial: boolean
}
type CaretInfo = {
  line: number
  /** Last word ending at or before the caret. */
  before?: number
  /** First word starting at or after the caret. */
  after?: number
  /** Word the caret is strictly inside of. */
  inside?: { word: number; offset: number; span: HTMLElement }
}
type CaretMark = { chars: number; space: boolean }
type Token = { text: string; sources: number[]; word?: SubtitleWord }

type TranscriptEditorOptions = {
  root: HTMLElement
  cutButton: HTMLButtonElement
  tt: (path: string, vars?: Record<string, unknown>) => string
  segmentsFor: (lang: string) => Segment[]
  activeLang: () => string
  /** The track whose words drive the cuts (the transcription). */
  sourceLang: () => string
  cutRanges: () => TimeRange[]
  snapshotSegments: () => string
  pushHistory: (snapshotBefore: string) => void
  undo: () => void
  redo: () => void
  seek: (time: number) => void
  /** Text changed while typing: captions should follow. */
  onTextChange: () => void
  /** Words were cut/restored or lines split/merged. */
  onStructureChange: () => void
}

const TEXT_EDIT_IDLE_MS = 1200

function setEditable(el: HTMLElement, on: boolean) {
  if (!on) {
    el.contentEditable = "false"
    return
  }
  try {
    el.contentEditable = "plaintext-only"
  } catch {
    el.contentEditable = "true"
  }
}

function shortClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function nonSpaceLength(text: string) {
  return text.replace(/\s/g, "").length
}

export function createTranscriptEditor(options: TranscriptEditorOptions) {
  const {
    root,
    cutButton,
    tt,
    segmentsFor,
    activeLang,
    sourceLang,
    cutRanges,
    snapshotSegments,
    pushHistory,
    undo,
    redo,
    seek,
    onTextChange,
    onStructureChange,
  } = options

  let renderedLang = ""
  let pendingSnapshot: string | null = null
  let commitTimer = 0
  let wordTimes: Array<{ start: number; end: number; el: HTMLElement }> = []
  let wordTimesDirty = true
  let currentWord: HTMLElement | null = null
  let activeLine: HTMLElement | null = null
  let cutSelection: Range | null = null

  const segments = () => segmentsFor(activeLang())
  const cutMode = () => !!activeLang() && activeLang() === sourceLang()

  // ── Model helpers ──

  function ensureWords(seg: Segment) {
    const kept = (seg.words || []).filter((word) => !word.cut)
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
    if (seg.words?.length && normalize(wordsText(kept)) === normalize(seg.text))
      return seg.words
    // No word timings (or text edited elsewhere): estimate them from the line.
    seg.words = estimatedWordsForSegment({ ...seg, words: undefined }).map(
      (word) => ({ ...word }),
    )
    return seg.words
  }

  function syncText(seg: Segment) {
    seg.text = wordsText((seg.words || []).filter((word) => !word.cut))
  }

  // ── Rendering ──

  function cutGroup(words: SubtitleWord[], from: number, to: number) {
    const group = document.createElement("span")
    group.className = "tx-cut"
    group.contentEditable = "false"
    group.dataset.from = String(from)
    group.dataset.to = String(to)
    group.title = tt("transcript.restore")
    group.textContent = wordsText(words.slice(from, to))
    return group
  }

  function renderLine(seg: Segment, index: number) {
    const line = document.createElement("p")
    line.className = "tx-line"
    line.dataset.index = String(index)
    line.dataset.time = shortClock(seg.start)

    if (!cutMode()) {
      line.classList.add("is-plain")
      const ranges = cutRanges()
      const fullyCut =
        ranges.length > 0 && keptParts(ranges, seg.start, seg.end).length === 0
      line.classList.toggle("is-cut", fullyCut)
      setEditable(line, !fullyCut)
      line.spellcheck = false
      line.textContent = seg.text
      return line
    }

    const words = ensureWords(seg)
    let i = 0
    while (i < words.length) {
      // Empty words retain their original timing and separate existing cuts.
      if (!words[i].cut && !words[i].text.trim()) {
        const anchor = document.createElement("span")
        anchor.className = "tx-anchor"
        anchor.dataset.w = String(i)
        anchor.hidden = true
        anchor.contentEditable = "false"
        line.append(anchor)
        i += 1
        continue
      }
      if (line.querySelector(".tx-w, .tx-cut")) line.append(" ")
      if (words[i].cut) {
        const from = i
        while (i < words.length && words[i].cut) i += 1
        line.append(cutGroup(words, from, i))
        continue
      }
      const span = document.createElement("span")
      span.className = "tx-w"
      span.dataset.w = String(i)
      span.textContent = words[i].text
      line.append(span)
      i += 1
    }
    line.classList.toggle(
      "is-cut",
      words.length > 0 && words.every((w) => w.cut),
    )
    if (!line.querySelector(".tx-w, .tx-cut"))
      line.append(document.createElement("br"))
    return line
  }

  function render() {
    commitPendingEdit()
    cutSelection = null
    cutButton.hidden = !cutMode() || !segments().length
    cutButton.disabled = true
    const segs = segments()
    renderedLang = activeLang()
    currentWord = null
    activeLine = null
    wordTimesDirty = true
    root.classList.toggle("is-plain", !cutMode())

    if (!segs.length) {
      setEditable(root, false)
      root.innerHTML = `<p class="tx-empty">${tt("segEmpty")}</p>`
      return
    }

    setEditable(root, cutMode())
    root.spellcheck = false
    const fragment = document.createDocumentFragment()
    segs.forEach((seg, index) => fragment.append(renderLine(seg, index)))
    root.replaceChildren(fragment)
  }

  function renderLineAt(index: number) {
    const seg = segments()[index]
    const old = lineEl(index)
    if (!seg || !old) return render()
    old.replaceWith(renderLine(seg, index))
    wordTimesDirty = true
  }

  // ── DOM lookups ──

  function lineEl(index: number) {
    return root.querySelector<HTMLElement>(`.tx-line[data-index="${index}"]`)
  }

  function lineOf(node: Node | null) {
    const el = node instanceof Element ? node : node?.parentElement
    const line = el?.closest<HTMLElement>(".tx-line")
    return line && root.contains(line) ? line : null
  }

  function wordSpans(line: HTMLElement) {
    return [...line.querySelectorAll<HTMLElement>(".tx-w")]
  }

  function wordSpan(line: HTMLElement, word: number) {
    return line.querySelector<HTMLElement>(`.tx-w[data-w="${word}"]`)
  }

  function textOffsetWithin(el: HTMLElement, node: Node, offset: number) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.setEnd(node, offset)
    return range.toString().length
  }

  function selectionRange() {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return null
    const range = selection.getRangeAt(0)
    return root.contains(range.commonAncestorContainer) ? range : null
  }

  function caretInfo(range: Range): CaretInfo | null {
    const line = lineOf(range.startContainer)
    if (!line) return null
    const info: CaretInfo = { line: Number(line.dataset.index) }
    for (const span of wordSpans(line)) {
      const word = Number(span.dataset.w)
      if (range.comparePoint(span, 0) >= 0) {
        info.after = word
        break
      }
      if (range.comparePoint(span, span.childNodes.length) <= 0) {
        info.before = word
        continue
      }
      const offset = textOffsetWithin(
        span,
        range.startContainer,
        range.startOffset,
      )
      const length = span.textContent?.length || 0
      if (offset <= 0) {
        info.after = word
        break
      }
      if (offset >= length) {
        info.before = word
        continue
      }
      info.inside = { word, offset, span }
      break
    }
    return info
  }

  function selectedWords(range: Range): WordHit[] {
    const hits: WordHit[] = []
    root.querySelectorAll<HTMLElement>(".tx-line").forEach((line) => {
      if (!range.intersectsNode(line)) return
      for (const span of wordSpans(line)) {
        if (!range.intersectsNode(span)) continue
        const length = span.textContent?.length || 0
        const from = span.contains(range.startContainer)
          ? textOffsetWithin(span, range.startContainer, range.startOffset)
          : 0
        const to = span.contains(range.endContainer)
          ? textOffsetWithin(span, range.endContainer, range.endOffset)
          : length
        if (to <= from) continue
        hits.push({
          line: Number(line.dataset.index),
          word: Number(span.dataset.w),
          span,
          from,
          to,
          partial: from > 0 || to < length,
        })
      }
    })
    return hits
  }

  // ── Caret ──

  function setCaret(node: Node, offset: number) {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function caretAtWord(line: number, word: number, edge: "start" | "end") {
    const el = lineEl(line)
    const span = el && wordSpan(el, word)
    if (!span) {
      if (el) setCaret(el, 0)
      return
    }
    const text = span.firstChild || span
    setCaret(text, edge === "start" ? 0 : text.textContent?.length || 0)
  }

  /** Puts the caret next to the closest word that is still in the video. */
  function caretNear(line: number, word: number, prefer: "before" | "after") {
    const words = segments()[line]?.words || []
    let previous = -1
    for (let i = Math.min(word, words.length) - 1; i >= 0; i -= 1)
      if (!words[i].cut && words[i].text.trim()) {
        previous = i
        break
      }
    let next = -1
    for (let i = Math.max(0, word); i < words.length; i += 1)
      if (!words[i].cut && words[i].text.trim()) {
        next = i
        break
      }
    if (prefer === "before" && previous >= 0) caretAtWord(line, previous, "end")
    else if (next >= 0) caretAtWord(line, next, "start")
    else if (previous >= 0) caretAtWord(line, previous, "end")
    else caretAtWord(line, -1, "start")
  }

  // Counting non-space characters survives re-renders that normalize spaces.
  function caretMark(line: HTMLElement, node: Node, offset: number): CaretMark {
    const range = document.createRange()
    range.setStart(line, 0)
    range.setEnd(node, offset)
    const fragment = range.cloneContents()
    fragment.querySelectorAll(".tx-cut").forEach((el) => el.remove())
    const text = fragment.textContent || ""
    return { chars: nonSpaceLength(text), space: /\s$/.test(text) }
  }

  function restoreCaret(line: HTMLElement, mark: CaretMark) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let count = 0
    let target: { node: Text; offset: number } | null = null
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      if (node.parentElement?.closest(".tx-cut")) continue
      if (!target && mark.chars === 0) target = { node, offset: 0 }
      for (let i = 0; i < node.data.length && !target; i += 1) {
        if (/\s/.test(node.data[i])) continue
        count += 1
        if (count === mark.chars) target = { node, offset: i + 1 }
      }
      if (target) break
    }
    if (!target) {
      setCaret(line, line.childNodes.length)
      return
    }
    if (mark.space) {
      const { node: text, offset } = target
      if (/\s/.test(text.data[offset] || "")) target.offset += 1
      else if (offset === text.length) {
        let next = text.parentElement?.classList.contains("tx-w")
          ? text.parentElement.nextSibling
          : text.nextSibling
        while (
          next instanceof HTMLElement &&
          next.classList.contains("tx-anchor")
        )
          next = next.nextSibling
        if (next instanceof Text && /^\s/.test(next.data)) {
          target = { node: next, offset: 1 }
        } else {
          // A removed final word leaves no rendered separator. Keep the
          // caret's space so newly typed text does not join the previous word.
          text.insertData(offset, " ")
          target.offset += 1
        }
      }
    }
    setCaret(target.node, target.offset)
  }

  // ── History ──

  function beginTextEdit() {
    pendingSnapshot ??= snapshotSegments()
    window.clearTimeout(commitTimer)
    commitTimer = window.setTimeout(commitPendingEdit, TEXT_EDIT_IDLE_MS)
  }

  function commitPendingEdit() {
    window.clearTimeout(commitTimer)
    if (pendingSnapshot && pendingSnapshot !== snapshotSegments())
      pushHistory(pendingSnapshot)
    pendingSnapshot = null
  }

  function structuralChange(apply: () => void) {
    commitPendingEdit()
    const before = snapshotSegments()
    apply()
    pushHistory(before)
    onStructureChange()
  }

  // ── Cuts ──

  function cutWords(refs: WordRef[], prefer: "before" | "after") {
    const segs = segments()
    const targets = refs.filter(({ line, word }) => {
      const w = segs[line]?.words?.[word]
      return w && !w.cut
    })
    if (!targets.length) return
    structuralChange(() => {
      const lines = new Set<number>()
      targets.forEach(({ line, word }) => {
        segs[line].words![word].cut = true
        lines.add(line)
      })
      lines.forEach((line) => {
        syncText(segs[line])
        renderLineAt(line)
      })
    })
    const anchor =
      prefer === "before" ? targets[0] : targets[targets.length - 1]
    caretNear(
      anchor.line,
      prefer === "before" ? anchor.word : anchor.word + 1,
      prefer,
    )
  }

  function restoreWords(line: number, from: number, to: number) {
    const seg = segments()[line]
    if (!seg?.words) return
    structuralChange(() => {
      for (let i = from; i < to; i += 1)
        if (seg.words![i]) seg.words![i].cut = false
      syncText(seg)
      renderLineAt(line)
    })
  }

  // ── Text corrections ──

  /** Remove only the selected text. Empty timed words remain as media anchors. */
  function deleteText(range: Range) {
    const hits = selectedWords(range)
    const firstLine =
      lineOf(range.startContainer) ||
      (hits.length ? lineEl(hits[0].line) : null)
    if (!firstLine) return
    const index = Number(firstLine.dataset.index)
    const mark = firstLine.contains(range.startContainer)
      ? caretMark(firstLine, range.startContainer, range.startOffset)
      : { chars: 0, space: false }
    beginTextEdit()
    if (!hits.length) {
      // Deleting a space joins words using the existing timing reconciliation.
      // Never let a DOM deletion remove a cut marker or a temporal anchor.
      const walker = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT)
      const edits: Array<{ node: Text; from: number; to: number }> = []
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        if (
          node.parentElement?.closest(".tx-cut") ||
          !range.intersectsNode(node)
        )
          continue
        edits.push({
          node,
          from: node === range.startContainer ? range.startOffset : 0,
          to: node === range.endContainer ? range.endOffset : node.length,
        })
      }
      for (const { node, from, to } of edits) node.deleteData(from, to - from)
      setCaret(range.startContainer, range.startOffset)
      reconcileFromSelection()
      return
    }
    const changedLines = new Set<number>()
    for (const hit of hits) {
      const word = segments()[hit.line].words![hit.word]
      word.text = word.text.slice(0, hit.from) + word.text.slice(hit.to)
      changedLines.add(hit.line)
    }
    for (const line of changedLines) {
      syncText(segments()[line])
      renderLineAt(line)
    }
    const fresh = lineEl(index)
    if (fresh) {
      restoreCaret(fresh, mark)
      const last = hits[hits.length - 1]
      const caret = selectionRange()
      if (
        last.line === index &&
        last.to === last.span.textContent!.length &&
        caret
      ) {
        const tail = caret.cloneRange()
        tail.setEnd(fresh, fresh.childNodes.length)
        if (/^\S/.test(tail.toString())) {
          // Keep the separator after an erased word so typing at its old
          // position does not concatenate the correction with the next word.
          const space = document.createTextNode(" ")
          caret.insertNode(space)
          setCaret(space, 0)
        }
      }
    }
    onTextChange()
  }

  function handleDelete(event: InputEvent) {
    let range = selectionRange()
    if (!range) return
    if (range.collapsed) {
      const forward = event.inputType.endsWith("Forward")
      const info = caretInfo(range)
      if (
        info &&
        !info.inside &&
        (forward ? info.after == null : info.before == null)
      ) {
        mergeLines(forward ? info.line : info.line - 1)
        return
      }
      // Native target ranges account for platform word and grapheme boundaries.
      const target = event.getTargetRanges?.()[0]
      if (target && !target.collapsed) {
        range = document.createRange()
        range.setStart(target.startContainer, target.startOffset)
        range.setEnd(target.endContainer, target.endOffset)
      } else {
        // Firefox does not supply target ranges for every deletion type.
        const granularity = event.inputType.startsWith("deleteWord")
          ? "word"
          : /Line(Backward|Forward)$/.test(event.inputType)
            ? "lineboundary"
            : "character"
        window
          .getSelection()
          ?.modify("extend", forward ? "forward" : "backward", granularity)
        range = selectionRange()
      }
      if (range && /^deleteContent(Backward|Forward)$/.test(event.inputType)) {
        const parent =
          range.startContainer instanceof Element
            ? range.startContainer
            : range.startContainer.parentElement
        const span = parent?.closest<HTMLElement>(".tx-w")
        if (span?.contains(range.endContainer)) {
          // Some engines delete a single code point of an emoji sequence.
          // Expand to complete graphemes, including combining marks and ZWJ.
          const from = textOffsetWithin(
            span,
            range.startContainer,
            range.startOffset,
          )
          const to = textOffsetWithin(span, range.endContainer, range.endOffset)
          const text = span.textContent || ""
          const boundaries = [
            ...new Intl.Segmenter(undefined, {
              granularity: "grapheme",
            }).segment(text),
          ].map(({ index }) => index)
          boundaries.push(text.length)
          const start = boundaries.findLast((offset) => offset <= from) ?? 0
          const end = boundaries.find((offset) => offset >= to) ?? text.length
          const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
          let offset = 0
          let node: Text | null
          while ((node = walker.nextNode() as Text | null)) {
            if (start >= offset && start < offset + node.length)
              range.setStart(node, start - offset)
            if (end > offset && end <= offset + node.length)
              range.setEnd(node, end - offset)
            offset += node.length
          }
        }
      }
    }
    if (
      range &&
      !range.collapsed &&
      root.contains(range.commonAncestorContainer)
    )
      deleteText(range)
  }

  function replaceSelection(range: Range, text: string) {
    const hits = selectedWords(range)
    if (hits.length && text) {
      const first = hits[0]
      const last = hits[hits.length - 1]
      const line = lineEl(first.line)!
      const mark = line.contains(range.startContainer)
        ? caretMark(line, range.startContainer, range.startOffset)
        : { chars: 0, space: false }
      const prefix = first.span.textContent!.slice(0, first.from)
      const suffix = last.span.textContent!.slice(last.to)
      beginTextEdit()
      for (const hit of hits) {
        const word = segments()[hit.line].words![hit.word]
        word.text = word.text.slice(0, hit.from) + word.text.slice(hit.to)
      }
      const word = segments()[first.line].words![first.word]
      word.text = prefix + text + (first.line === last.line ? suffix : "")
      if (first.line === last.line && first !== last)
        segments()[last.line].words![last.word].text = ""
      // Preserve the source interval when a correction contains several words.
      const parts = word.text.split(/\s+/).filter(Boolean)
      if (parts.length > 1) {
        const total = parts.reduce((sum, part) => sum + part.length, 0)
        let cursor = word.start
        segments()[first.line].words!.splice(
          first.word,
          1,
          ...parts.map((part, i) => {
            const end =
              i === parts.length - 1
                ? word.end
                : cursor + ((word.end - word.start) * part.length) / total
            const next = { start: cursor, end, text: part }
            cursor = end
            return next
          }),
        )
      }
      for (const index of new Set(hits.map((hit) => hit.line))) {
        syncText(segments()[index])
        renderLineAt(index)
      }
      restoreCaret(lineEl(first.line)!, {
        chars: mark.chars + nonSpaceLength(text),
        space: /\s$/.test(text),
      })
      onTextChange()
      return
    }
    deleteText(range)
    const caret = selectionRange()
    if (!caret || !text) return
    beginTextEdit()
    caret.collapse(true)
    const node = document.createTextNode(text)
    caret.insertNode(node)
    setCaret(node, text.length)
    reconcileFromSelection()
  }

  function updateCutSelection() {
    const selection = selectionRange()
    if (selection && !selection.collapsed) cutSelection = selection.cloneRange()
    else if (document.activeElement !== cutButton) cutSelection = null
    cutButton.disabled =
      !cutMode() ||
      !cutSelection ||
      !selectedWords(cutSelection).some(({ line, word }) => {
        const item = segments()[line]?.words?.[word]
        return item && !item.cut && item.end > item.start
      })
  }

  function cutSelectedWords() {
    if (
      !cutMode() ||
      !cutSelection ||
      !root.contains(cutSelection.commonAncestorContainer)
    )
      return
    const refs = selectedWords(cutSelection).filter(({ line, word }) => {
      const item = segments()[line]?.words?.[word]
      return item && !item.cut && item.end > item.start
    })
    root.focus()
    cutWords(refs, "before")
    cutSelection = null
    cutButton.disabled = true
  }

  // ── Lines ──

  function splitLine(range: Range) {
    const info = caretInfo(range)
    if (!info) return
    const segs = segments()
    const seg = segs[info.line]
    if (!seg) return
    const words = ensureWords(seg)
    let at = info.after ?? words.length
    if (info.inside) {
      const length = info.inside.span.textContent?.length || 0
      at =
        info.inside.offset >= length / 2
          ? info.inside.word + 1
          : info.inside.word
    }
    if (at <= 0 || at >= words.length) return

    structuralChange(() => {
      const head = words.slice(0, at)
      const tail = words.slice(at)
      const end = seg.end
      seg.words = head
      seg.end = Math.max(seg.start + 0.1, head[head.length - 1].end)
      const next: Segment = {
        start: Math.max(seg.end, tail[0].start),
        end: Math.max(end, tail[tail.length - 1].end),
        text: "",
        words: tail,
      }
      syncText(seg)
      syncText(next)
      segs.splice(info.line + 1, 0, next)
      render()
    })
    caretNear(info.line + 1, 0, "after")
  }

  function mergeLines(first: number) {
    const segs = segments()
    const a = segs[first]
    const b = segs[first + 1]
    if (!a || !b) return
    const join = ensureWords(a).length
    ensureWords(b)
    structuralChange(() => {
      a.words = [...a.words!, ...b.words!]
      a.start = Math.min(a.start, b.start)
      a.end = Math.max(a.end, b.end)
      syncText(a)
      segs.splice(first + 1, 1)
      render()
    })
    caretNear(first, join, "before")
  }

  // ── Reading typed text back ──

  // Native typing lands wherever the browser puts it (inside a word span or in
  // the spaces between them). Every character is tagged with the word it came
  // from, so retyped words keep their timing and new words get none.
  function reconcileLine(line: HTMLElement) {
    const index = Number(line.dataset.index)
    const seg = segments()[index]
    if (!seg) return
    const oldWords = seg.words || []
    type Item =
      | { kind: "chars"; chars: Array<[string, number]> }
      | { kind: "cut"; from: number; to: number }
    const items: Item[] = []
    let chars: Array<[string, number]> = []
    let looseText = false
    const flush = () => {
      if (chars.length) items.push({ kind: "chars", chars })
      chars = []
    }
    const walk = (node: Node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const owner = child.parentElement?.closest<HTMLElement>(".tx-w")
          const source = owner ? Number(owner.dataset.w) : -1
          const data = (child as Text).data
          if (source < 0 && data.trim()) looseText = true
          for (const ch of data) chars.push([ch, source])
        } else if (child instanceof HTMLElement) {
          if (child.classList.contains("tx-anchor")) {
            // Reinsert temporal anchors below, without splitting adjacent text.
            return
          } else if (child.classList.contains("tx-cut")) {
            flush()
            items.push({
              kind: "cut",
              from: Number(child.dataset.from),
              to: Number(child.dataset.to),
            })
          } else if (child.tagName === "BR") chars.push([" ", -1])
          else walk(child)
        }
      })
    }
    walk(line)
    flush()

    const sequence: Array<Token | SubtitleWord> = []
    const tokens: Token[] = []
    items.forEach((item) => {
      if (item.kind === "cut") {
        sequence.push(...oldWords.slice(item.from, item.to))
        return
      }
      let text = ""
      let sources = new Set<number>()
      const push = () => {
        if (!text) return
        const token = { text, sources: [...sources].filter((s) => s >= 0) }
        tokens.push(token)
        sequence.push(token)
        text = ""
        sources = new Set()
      }
      item.chars.forEach(([ch, source]) => {
        if (/\s/.test(ch)) push()
        else {
          text += ch
          sources.add(source)
        }
      })
      push()
    })

    // Timing: a word split in several tokens shares its time; merged words
    // span all of theirs; brand-new words get a zero-length slot.
    const bySource = new Map<number, Token[]>()
    tokens.forEach((token) => {
      if (token.sources.length !== 1) return
      const group = bySource.get(token.sources[0]) || []
      group.push(token)
      bySource.set(token.sources[0], group)
    })
    bySource.forEach((group, source) => {
      const original = oldWords[source]
      if (!original) return
      // Typing a new word right next to an existing one lands in its span:
      // the untouched word keeps its time and the new ones get none.
      const kept = group.findIndex((token) => token.text === original.text)
      if (kept >= 0) {
        group.forEach((token, i) => {
          const at = i < kept ? original.start : original.end
          token.word =
            i === kept
              ? { start: original.start, end: original.end, text: token.text }
              : { start: at, end: at, text: token.text }
        })
        return
      }
      const total = group.reduce((sum, token) => sum + token.text.length, 0)
      let cursor = original.start
      group.forEach((token, i) => {
        const end =
          i === group.length - 1
            ? original.end
            : cursor +
              ((original.end - original.start) * token.text.length) / total
        token.word = { start: cursor, end, text: token.text }
        cursor = end
      })
    })
    tokens.forEach((token) => {
      if (token.sources.length < 2) return
      const merged = token.sources
        .map((source) => oldWords[source])
        .filter(Boolean)
      token.word = {
        start: Math.min(...merged.map((w) => w.start)),
        end: Math.max(...merged.map((w) => w.end)),
        text: token.text,
      }
    })
    let lastEnd: number | null = null
    const next = sequence.map((item, i) => {
      let word = "sources" in item ? item.word : item
      if (!word) {
        const following = sequence
          .slice(i + 1)
          .map((rest) => ("sources" in rest ? rest.word : rest))
          .find(Boolean)
        const at = lastEnd ?? following?.start ?? seg.start
        word = { start: at, end: at, text: (item as Token).text }
      }
      lastEnd = word.end
      return word
    })

    // Native composition can replace entire spans. Keep their time records,
    // including cut markers, even if the browser removed the corresponding DOM.
    const represented = new Set(tokens.flatMap((token) => token.sources))
    const retained = new Set(sequence.filter((item) => !("sources" in item)))
    oldWords.forEach((word, index) => {
      if (represented.has(index) || retained.has(word)) return
      const anchor = word.cut ? word : { ...word, text: "" }
      const at = next.findIndex((item) => item.start >= anchor.start)
      next.splice(at < 0 ? next.length : at, 0, anchor)
    })

    const structural =
      next.length !== oldWords.length ||
      next.some(
        (word, i) =>
          word.start !== oldWords[i].start ||
          word.end !== oldWords[i].end ||
          !!word.cut !== !!oldWords[i].cut,
      )
    const drifted = wordSpans(line).some(
      (span) =>
        (span.textContent || "").trim() !== next[Number(span.dataset.w)]?.text,
    )
    const changed =
      structural || next.some((word, i) => word.text !== oldWords[i]?.text)
    if (!changed && !looseText) return

    beginTextEdit()
    seg.words = next
    syncText(seg)
    if (structural || looseText || drifted) {
      const selection = window.getSelection()
      const mark =
        selection?.rangeCount && line.contains(selection.anchorNode)
          ? caretMark(line, selection.anchorNode!, selection.anchorOffset)
          : null
      renderLineAt(index)
      const fresh = lineEl(index)
      if (fresh && mark) restoreCaret(fresh, mark)
    }
    onTextChange()
  }

  function reconcilePlainLine(line: HTMLElement) {
    const seg = segments()[Number(line.dataset.index)]
    if (!seg) return
    const text = (line.textContent || "").replace(/\n/g, " ")
    if (text === seg.text) return
    beginTextEdit()
    seg.text = text
    onTextChange()
  }

  function reconcileFromSelection() {
    const range = selectionRange()
    const line = lineOf(range?.startContainer || null)
    if (!line) {
      // Text typed outside any line: drop it and redraw.
      if (
        [...root.childNodes].some(
          (n) => !(n instanceof HTMLElement && n.matches(".tx-line")),
        )
      )
        render()
      return
    }
    if (line.classList.contains("is-plain")) reconcilePlainLine(line)
    else reconcileLine(line)
  }

  // ── Copy / cut keep the struck words out ──

  function selectedPlainText(range: Range) {
    const fragment = range.cloneContents()
    fragment.querySelectorAll(".tx-cut").forEach((el) => el.remove())
    const lines = [...fragment.querySelectorAll(".tx-line")]
    if (!lines.length)
      return (fragment.textContent || "").replace(/\s+/g, " ").trim()
    return lines
      .map((line) => (line.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  }

  // ── Playback highlight ──

  function rebuildWordTimes() {
    wordTimesDirty = false
    wordTimes = []
    if (!cutMode()) return
    const segs = segments()
    root.querySelectorAll<HTMLElement>(".tx-line").forEach((line) => {
      const words = segs[Number(line.dataset.index)]?.words || []
      wordSpans(line).forEach((el) => {
        const word = words[Number(el.dataset.w)]
        if (word) wordTimes.push({ start: word.start, end: word.end, el })
      })
    })
    wordTimes.sort((a, b) => a.start - b.start)
  }

  function highlightTime(time: number) {
    if (renderedLang !== activeLang()) return
    if (wordTimesDirty) rebuildWordTimes()
    let lo = 0
    let hi = wordTimes.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (wordTimes[mid].start <= time) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const hit =
      found >= 0 && time <= wordTimes[found].end + 0.08
        ? wordTimes[found].el
        : null
    if (hit === currentWord) return
    currentWord?.classList.remove("is-current")
    hit?.classList.add("is-current")
    currentWord = hit
  }

  function setActiveLine(index: number, lang: string, scroll: boolean) {
    if (lang !== renderedLang) return
    const line = index >= 0 ? lineEl(index) : null
    if (line !== activeLine) {
      activeLine?.classList.remove("is-active")
      line?.classList.add("is-active")
      activeLine = line
    }
    if (line && scroll && !root.contains(document.activeElement))
      line.scrollIntoView({ block: "nearest" })
  }

  // ── Events ──

  function wire() {
    document.addEventListener("selectionchange", updateCutSelection)
    cutButton.addEventListener("pointerdown", (event) => event.preventDefault())
    cutButton.addEventListener("click", cutSelectedWords)
    root.addEventListener("focusout", (event) => {
      if (
        event.relatedTarget !== cutButton &&
        !root.contains(event.relatedTarget as Node)
      ) {
        cutSelection = null
        cutButton.disabled = true
      }
    })
    root.addEventListener("beforeinput", (event: InputEvent) => {
      const type = event.inputType
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault()
        commitPendingEdit()
        if (type === "historyUndo") undo()
        else redo()
        return
      }
      if (
        type.startsWith("format") ||
        type === "insertParagraph" ||
        type === "insertLineBreak" ||
        type === "insertFromDrop" ||
        type === "deleteByDrag"
      ) {
        event.preventDefault()
        if (type === "insertParagraph" || type === "insertLineBreak") {
          const range = selectionRange()
          if (range && cutMode()) splitLine(range)
        }
        return
      }
      if (!cutMode() || event.isComposing) return

      if (type.startsWith("delete")) {
        event.preventDefault()
        handleDelete(event)
        return
      }
      if (event.isComposing) return
      const range = selectionRange()
      const target = event.getTargetRanges?.()[0]
      const replacing = range && !range.collapsed ? range : null
      const targetRange =
        replacing ||
        (target && !target.collapsed && type === "insertReplacementText"
          ? (() => {
              const r = document.createRange()
              r.setStart(target.startContainer, target.startOffset)
              r.setEnd(target.endContainer, target.endOffset)
              return r
            })()
          : null)
      if (targetRange) {
        const text =
          event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
        event.preventDefault()
        replaceSelection(targetRange, text.replace(/\s+/g, " "))
      }
    })

    root.addEventListener("input", (event) => {
      if ((event as InputEvent).isComposing) return
      reconcileFromSelection()
    })
    root.addEventListener("compositionend", () => reconcileFromSelection())

    root.addEventListener("copy", (event: ClipboardEvent) => {
      const range = selectionRange()
      if (!range || range.collapsed || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData("text/plain", selectedPlainText(range))
    })
    root.addEventListener("cut", (event: ClipboardEvent) => {
      const range = selectionRange()
      if (!range || range.collapsed || !event.clipboardData) return
      if (!cutMode()) return
      event.preventDefault()
      event.clipboardData.setData("text/plain", selectedPlainText(range))
      deleteText(range)
    })
    root.addEventListener("dragstart", (event) => event.preventDefault())

    root.addEventListener("mousedown", (event) => {
      // Keep the caret where it is when restoring words.
      if ((event.target as Element).closest(".tx-cut")) event.preventDefault()
    })

    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement
      const group = target.closest<HTMLElement>(".tx-cut")
      const line = target.closest<HTMLElement>(".tx-line")
      if (!line) return
      const index = Number(line.dataset.index)
      const seg = segments()[index]
      if (!seg) return
      if (group) {
        restoreWords(
          index,
          Number(group.dataset.from),
          Number(group.dataset.to),
        )
        return
      }
      // The timestamp gutter is the line's ::before.
      const gutter = parseFloat(getComputedStyle(line).paddingLeft) || 0
      if (event.clientX < line.getBoundingClientRect().left + gutter) {
        seek(seg.start)
        return
      }
      const span = target.closest<HTMLElement>(".tx-w")
      const word = span && seg.words?.[Number(span.dataset.w)]
      if (!window.getSelection()?.isCollapsed) return
      if (word) seek(word.start)
      else if (line.classList.contains("is-plain")) seek(seg.start)
    })

    root.addEventListener("focusout", (event) => {
      if (root.contains(event.relatedTarget as Node)) return
      commitPendingEdit()
      if (!cutMode()) {
        segments().forEach((seg) => {
          seg.text = seg.text.replace(/\s+/g, " ").trim()
        })
      }
    })
  }

  wire()

  return {
    render,
    renderedLang: () => renderedLang,
    commitPendingEdit,
    highlightTime,
    setActiveLine,
    cutSelectedWords,
  }
}

export type TranscriptEditor = ReturnType<typeof createTranscriptEditor>
