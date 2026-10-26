// Pure helpers for turning word-level timestamps into SRT cues.

const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;

/**
 * Normalise Whisper word chunks ({ text, timestamp: [start, end] }) into
 * { text, start, end } words. Stray punctuation tokens are glued onto the
 * previous word so they never start a line on their own.
 */
export function normalizeWords(chunks) {
  const words = [];
  for (const c of chunks) {
    const text = (c.text ?? '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp ?? [];
    if (start == null) start = words.length ? words[words.length - 1].end : 0;
    if (PUNCT_ONLY.test(text) && words.length) {
      const prev = words[words.length - 1];
      prev.text += text;
      if (end != null) prev.end = Math.max(prev.end, end);
      continue;
    }
    words.push({ text, start, end: end ?? null });
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end == null || w.end < w.start) {
      const next = words[i + 1];
      w.end = next ? Math.max(w.start, next.start) : w.start + 0.5;
    }
  }
  return words;
}

/**
 * Greedily pack words into lines of at most `maxChars` characters (a word is
 * never split; a single word longer than the limit gets its own line), and
 * lines into cues of at most `maxLines` lines.
 */
export function buildCues(words, { maxChars, maxLines = 2, pauseSplit = 0.8, sentenceBreak = true }) {
  const cues = [];
  let lines = [];
  let line = '';
  let first = null;
  let last = null;

  const flushLine = () => {
    if (line) lines.push(line);
    line = '';
  };
  const flushCue = () => {
    flushLine();
    if (lines.length) cues.push({ start: first.start, end: last.end, lines });
    lines = [];
    first = last = null;
  };

  for (const w of words) {
    if (last) {
      const longPause = pauseSplit > 0 && w.start - last.end >= pauseSplit;
      const sentenceDone = sentenceBreak && SENTENCE_END.test(last.text);
      if (longPause || sentenceDone) flushCue();
    }
    if (line && line.length + 1 + w.text.length > maxChars) {
      flushLine();
      if (lines.length >= maxLines) flushCue();
    }
    line = line ? `${line} ${w.text}` : w.text;
    first ??= w;
    last = w;
  }
  flushCue();

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (cue.end - cue.start < 0.2) cue.end = cue.start + 0.2;
    if (next && cue.end > next.start) cue.end = Math.max(cue.start + 0.001, next.start);
  }
  return cues;
}

export function formatTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.lines.join('\n')}\n`)
    .join('\n');
}
