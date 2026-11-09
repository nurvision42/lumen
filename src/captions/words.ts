import { roundTime } from "../sprite/select.js";

/**
 * A later word stays in the same cue when it starts at most this long after
 * the previous word ends. 40ms gaps stay together. 240ms and longer start a
 * new cue. Overlaps and touching edges stay together.
 * This is an acoustic pause, not a claim that the cut is a semantic boundary.
 */
export const PAUSE_GAP_SEC = 0.2;

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface DraftCue {
  start: number;
  end: number;
  text: string;
  /** Inclusive index into the words array that was segmented. */
  wordFrom: number;
  wordTo: number;
}

const MARK = /[\s\p{P}\p{S}]/gu;

/** Cue text is the character stream. Commas and periods are not shown. */
export function displayWord(text: string): string {
  return text.replace(MARK, "");
}

/**
 * Group sorted word timings into a first-draft cue list.
 * `words` may be unsorted or overlapping. Punctuation-only tokens are dropped
 * and do not create a cue. The returned indexes refer to the original array.
 */
export function segmentWords(words: readonly TimedWord[], gapSec = PAUSE_GAP_SEC): DraftCue[] {
  const usable = words.flatMap((word, index) => {
    const text = displayWord(word.text);
    if (text.length === 0) return [];
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || !(word.end > word.start)) return [];
    return [{ index, text, start: word.start, end: word.end }];
  });
  usable.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  const cues: DraftCue[] = [];
  for (const word of usable) {
    const last = cues[cues.length - 1];
    const gap = last === undefined ? Number.POSITIVE_INFINITY : word.start - last.end;
    if (last !== undefined && gap <= gapSec) {
      last.end = Math.max(last.end, word.end);
      last.text += word.text;
      last.wordFrom = Math.min(last.wordFrom, word.index);
      last.wordTo = Math.max(last.wordTo, word.index);
      if (word.start < last.start) last.start = word.start;
      continue;
    }
    cues.push({
      start: word.start,
      end: word.end,
      text: word.text,
      wordFrom: word.index,
      wordTo: word.index,
    });
  }
  return cues.map((cue) => ({
    ...cue,
    start: roundTime(cue.start),
    end: roundTime(cue.end),
  }));
}
