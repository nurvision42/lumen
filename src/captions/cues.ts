import { CliError } from "../errors.js";
import { formatTime, parseTime, roundTime } from "../sprite/select.js";
import { asRecord } from "../walk.js";

export interface Cue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface CueDocument {
  cues: Cue[];
  confirmed?: boolean;
  format?: string;
}

/**
 * Portion of the spoken reference that must be found in the recognition
 * before a burn may replace cue text. Below this, the words are not the same passage.
 */
export const SPEECH_COVERAGE_MIN = 0.85;

/**
 * Portion of the recognition that must be found in the spoken reference.
 * Below this, too much recognized speech would be deleted to trust the edit.
 */
export const ASR_COVERAGE_MIN = 0.75;

export interface ScriptLine {
  text: string;
  start?: number;
  end?: number;
}

export interface ScriptNote {
  source: "file" | "shotlist" | "voice";
  file: string;
  fit: number;
  applied: boolean;
}

export interface CaptionFile {
  format: "lumen.captions@1";
  video: string;
  duration: number;
  clamped: boolean;
  confirmed: boolean;
  script: ScriptNote | null;
  asrDuration?: number;
  cues: Cue[];
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cueFromRecord(record: Record<string, unknown>): Cue | undefined {
  const text = textOf(record.text ?? record.subtitle_text ?? record.vo ?? record.transcript);
  const start = numberOf(record.start ?? record.start_time ?? record.startSec);
  const end = numberOf(record.end ?? record.end_time ?? record.endSec);
  if (text === undefined || start === undefined || end === undefined || !(end > start)) return undefined;
  const speaker = textOf(record.speaker);
  return { start, end, text, ...(speaker === undefined ? {} : { speaker }) };
}

function listOf(value: unknown): unknown[] | undefined {
  const record = asRecord(value);
  if (record === undefined) return Array.isArray(value) ? value : undefined;
  for (const key of ["cues", "subtitles", "lines"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (record.result !== undefined) return listOf(record.result);
  return undefined;
}

function cuesFromList(value: unknown): Cue[] {
  if (!Array.isArray(value)) return [];
  const cues: Cue[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const cue = cueFromRecord(record);
    if (cue !== undefined) cues.push(cue);
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function durationLines(value: unknown): Cue[] {
  if (!Array.isArray(value)) return [];
  let cursor = 0;
  const cues: Cue[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const duration = numberOf(record.durationSec);
    const text = textOf(record.vo ?? record.text ?? record.subtitle_text);
    if (duration === undefined || !(duration > 0)) continue;
    const start = cursor;
    cursor += duration;
    if (text === undefined) continue;
    cues.push({ start, end: cursor, text });
  }
  return cues;
}

export function readCueDocument(data: unknown): CueDocument {
  const record = asRecord(data);
  const format = typeof record?.format === "string" ? record.format : undefined;
  const confirmed = typeof record?.confirmed === "boolean" ? record.confirmed : undefined;
  const listed = listOf(data);
  const ranged = cuesFromList(listed ?? data);
  const cues = ranged.length > 0 ? ranged : durationLines(listed ?? data);
  return {
    cues,
    ...(confirmed === undefined ? {} : { confirmed }),
    ...(format === undefined ? {} : { format }),
  };
}

export function cuesFromTask(task: unknown): { cues: Cue[]; duration?: number } {
  const record = asRecord(task);
  const result = asRecord(record?.result) ?? record;
  const duration = numberOf(result?.duration ?? record?.duration);
  return {
    cues: readCueDocument(task).cues,
    ...(duration !== undefined && duration > 0 ? { duration } : {}),
  };
}

/** Drop or shorten cues that would run past the picture, including a black tail. */
export function clampCues(cues: readonly Cue[], duration: number): { cues: Cue[]; clamped: boolean } {
  const limit = Math.max(0, duration);
  let clamped = false;
  const next: Cue[] = [];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (text.length === 0) continue;
    const exceeded = cue.start < -0.001 || cue.end > limit + 0.001 || cue.start >= limit;
    if (exceeded) clamped = true;
    const start = roundTime(Math.max(0, Math.min(cue.start, limit)));
    let end = roundTime(Math.max(0, Math.min(cue.end, limit)));
    if (!(end > start) || start >= limit) continue;
    if (end > roundTime(limit)) end = roundTime(limit);
    if (!(end > start)) continue;
    next.push({ ...cue, start, end, text });
  }
  return { cues: next, clamped };
}

export function normalizeCaption(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (/[\s\p{P}\p{S}]/u.test(ch)) continue;
    out.push(ch.toLowerCase());
  }
  return out;
}

function indexMap(chars: readonly string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  chars.forEach((ch, index) => {
    const list = map.get(ch);
    if (list === undefined) map.set(ch, [index]);
    else list.push(index);
  });
  return map;
}

interface MatchBlock {
  i: number;
  j: number;
  size: number;
}

function longestMatch(
  a: readonly string[],
  bIndex: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): MatchBlock {
  let bestI = alo;
  let bestJ = blo;
  let best = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i += 1) {
    const next = new Map<number, number>();
    const indexes = bIndex.get(a[i] ?? "") ?? [];
    for (const j of indexes) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const size = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, size);
      if (size > best) {
        best = size;
        bestI = i - size + 1;
        bestJ = j - size + 1;
      }
    }
    j2len = next;
  }
  return { i: bestI, j: bestJ, size: best };
}

export function matchingBlocks(a: readonly string[], b: readonly string[]): MatchBlock[] {
  const bIndex = indexMap(b);
  const blocks: MatchBlock[] = [];
  const walk = (alo: number, ahi: number, blo: number, bhi: number): void => {
    const match = longestMatch(a, bIndex, alo, ahi, blo, bhi);
    if (match.size === 0) return;
    walk(alo, match.i, blo, match.j);
    blocks.push(match);
    walk(match.i + match.size, ahi, match.j + match.size, bhi);
  };
  walk(0, a.length, 0, b.length);
  blocks.push({ i: a.length, j: b.length, size: 0 });
  return blocks;
}

export function fitRatio(asrText: string, scriptText: string): number {
  const a = normalizeCaption(asrText);
  const b = normalizeCaption(scriptText);
  if (b.length === 0) return 1;
  if (a.length === 0) return 0;
  if (a.length * b.length > 8_000_000) return 0;
  let matched = 0;
  for (const block of matchingBlocks(a, b)) matched += block.size;
  return matched / b.length;
}

/** Punctuation stays on the previous word so a comma does not open a new cue. */
function speechPieces(text: string): { chars: string[]; pieces: string[] } {
  const chars: string[] = [];
  const pieces: string[] = [];
  let pending = "";
  for (const ch of text) {
    if (/[\s\p{P}\p{S}]/u.test(ch)) {
      if (pieces.length === 0) pending += ch;
      else pieces[pieces.length - 1] = `${pieces[pieces.length - 1] ?? ""}${ch}`;
      continue;
    }
    pieces.push(`${pending}${ch}`);
    pending = "";
    chars.push(ch.toLowerCase());
  }
  if (pending.length > 0) {
    if (pieces.length === 0) pieces.push(pending);
    else pieces[pieces.length - 1] = `${pieces[pieces.length - 1] ?? ""}${pending}`;
  }
  return { chars, pieces };
}

function give(pieces: readonly string[], targets: { cue: SpokenCue; weight: number }[]): boolean {
  if (pieces.length === 0) return true;
  if (targets.length === 0) return false;
  const total = targets.reduce((sum, target) => sum + target.weight, 0);
  if (!(total > 0)) return false;
  const base = targets.map((target) => Math.floor((pieces.length * target.weight) / total));
  let left = pieces.length - base.reduce((sum, count) => sum + count, 0);
  const order = targets
    .map((target, index) => ({ index, frac: (pieces.length * target.weight) / total - (base[index] ?? 0) }))
    .sort((a, b) => b.frac - a.frac);
  for (const item of order) {
    if (left <= 0) break;
    base[item.index] = (base[item.index] ?? 0) + 1;
    left -= 1;
  }
  let cursor = 0;
  targets.forEach((target, index) => {
    const count = base[index] ?? 0;
    target.cue.parts.push(...pieces.slice(cursor, cursor + count));
    cursor += count;
  });
  return true;
}

interface SpokenCue {
  index: number;
  start: number;
  end: number;
  normStart: number;
  normEnd: number;
  parts: string[];
  original: string;
  speaker?: string;
}

export interface CueTextChange {
  index: number;
  from: string;
  to: string;
}

export interface CueCorrection {
  ok: boolean;
  cues: Cue[];
  speechCoverage: number;
  asrCoverage: number;
  unplaced: string[];
  emptied: number[];
  changes: CueTextChange[];
  reasons: string[];
}

function overlapTargets(cues: SpokenCue[], from: number, to: number): { cue: SpokenCue; weight: number }[] {
  return cues
    .map((cue) => {
      const lo = Math.max(cue.normStart, from);
      const hi = Math.min(cue.normEnd, to);
      return { cue, weight: Math.max(0, hi - lo) };
    })
    .filter((target) => target.weight > 0);
}

/**
 * Replace cue text from a spoken reference. Cue count, order, start, and end
 * stay on the recognition. Words are placed by character alignment onto the
 * cue that already contains the matching recognition characters, not by
 * slicing time. A passage that falls between cues is left unplaced.
 */
export function correctCueTexts(asr: readonly Cue[], speech: string): CueCorrection {
  const spoken = speech.replace(/^\uFEFF/, "").trim();
  const original = asr.map((cue) => ({ ...cue }));
  if (asr.length === 0) {
    return {
      ok: false,
      cues: original,
      speechCoverage: 0,
      asrCoverage: 0,
      unplaced: [],
      emptied: [],
      changes: [],
      reasons: ["no recognition cues; refusing to invent timed subtitles from the spoken text"],
    };
  }
  if (spoken.length === 0) {
    return {
      ok: false,
      cues: original,
      speechCoverage: 0,
      asrCoverage: 0,
      unplaced: [],
      emptied: [],
      changes: [],
      reasons: ["spoken text is empty"],
    };
  }
  const { chars, pieces } = speechPieces(spoken);
  const cues: SpokenCue[] = [];
  let cursor = 0;
  asr.forEach((cue, index) => {
    const norm = normalizeCaption(cue.text);
    cues.push({
      index,
      start: cue.start,
      end: cue.end,
      normStart: cursor,
      normEnd: cursor + norm.length,
      parts: [],
      original: cue.text,
      ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
    });
    cursor += norm.length;
  });
  const flat: string[] = [];
  for (const cue of asr) flat.push(...normalizeCaption(cue.text));
  const speechCoverage = chars.length === 0 ? 0 : fitRatio(flat.join(""), spoken);
  const asrCoverage = flat.length === 0 ? 0 : fitRatio(spoken, flat.join(""));
  const unplaced: string[] = [];
  const noteUnplaced = (slice: readonly string[]): void => {
    const text = slice.join("").trim();
    if (normalizeCaption(text).length > 0) unplaced.push(text);
  };
  const blocks = chars.length === 0 || flat.length === 0 ? [] : matchingBlocks(flat, chars);
  let i = 0;
  let j = 0;
  for (const block of blocks) {
    if (i < block.i && j < block.j) {
      const slice = pieces.slice(j, block.j);
      if (!give(slice, overlapTargets(cues, i, block.i))) noteUnplaced(slice);
    } else if (j < block.j) {
      const slice = pieces.slice(j, block.j);
      const internal = cues.find((cue) => i > cue.normStart && i < cue.normEnd);
      if (internal !== undefined) internal.parts.push(...slice);
      else noteUnplaced(slice);
    }
    if (block.size > 0) {
      const slice = pieces.slice(block.j, block.j + block.size);
      if (!give(slice, overlapTargets(cues, block.i, block.i + block.size))) noteUnplaced(slice);
    }
    i = block.i + block.size;
    j = block.j + block.size;
  }
  const emptied: number[] = [];
  const corrected: Cue[] = cues.map((cue) => {
    const text = cue.parts.join("").trim();
    if (cue.original.trim().length > 0 && text.length === 0) emptied.push(cue.index);
    return {
      start: cue.start,
      end: cue.end,
      text,
      ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
    };
  });
  const reasons: string[] = [];
  if (speechCoverage + 1e-9 < SPEECH_COVERAGE_MIN || asrCoverage + 1e-9 < ASR_COVERAGE_MIN) {
    reasons.push(
      `spoken text does not match the recognition cues closely enough (speech ${speechCoverage.toFixed(3)}, asr ${asrCoverage.toFixed(3)}; need ${SPEECH_COVERAGE_MIN.toFixed(2)} and ${ASR_COVERAGE_MIN.toFixed(2)})`,
    );
  }
  for (const bit of unplaced) reasons.push(`spoken passage has no recognition cue: ${bit}`);
  for (const index of emptied) {
    const cue = asr[index];
    reasons.push(
      `correction would empty cue ${index + 1} (${cue?.start.toFixed(3)}-${cue?.end.toFixed(3)}) "${cue?.text ?? ""}". The cue was not deleted`,
    );
  }
  const changes = corrected.flatMap((cue, index) => {
    const from = asr[index]?.text ?? "";
    return from === cue.text ? [] : [{ index, from, to: cue.text }];
  });
  if (reasons.length > 0) {
    return { ok: false, cues: original, speechCoverage, asrCoverage, unplaced, emptied, changes: [], reasons };
  }
  return { ok: true, cues: corrected, speechCoverage, asrCoverage, unplaced, emptied, changes, reasons };
}

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((cue, index) => {
    const text = cue.speaker === undefined ? cue.text : `[${cue.speaker}] ${cue.text}`;
    return `${index + 1}\n${formatTime(cue.start).replace(".", ",")} --> ${formatTime(cue.end).replace(".", ",")}\n${text}\n`;
  }).join("\n");
}

function assTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const centi = Math.floor((ms % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centi).padStart(2, "0")}`;
}

/** Interchange only. Burn does not paint this file; the rounded box is a separate overlay. */
export function toAss(cues: readonly Cue[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,56,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map((cue) => {
    const text = `${cue.speaker === undefined ? "" : `[${cue.speaker}] `}${cue.text}`.replaceAll("\n", "\\N");
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${text}`;
  });
  return `${header}${lines.join("\n")}\n`;
}

export function toReadable(file: CaptionFile): string {
  const script = file.script === null
    ? "none"
    : `${file.script.source} fit=${file.script.fit.toFixed(3)} applied=${file.script.applied ? "yes" : "no"}`;
  const lines = [
    `duration: ${file.duration.toFixed(3)}`,
    `clamped: ${file.clamped ? "yes" : "no"}`,
    `confirmed: ${file.confirmed ? "yes" : "no"}`,
    `script: ${script}`,
    "",
  ];
  for (const cue of file.cues) {
    const text = cue.speaker === undefined ? cue.text : `[${cue.speaker}] ${cue.text}`;
    lines.push(`${formatTime(cue.start)} - ${formatTime(cue.end)}`, text, "");
  }
  return `${lines.join("\n")}`;
}

export function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.slice("Dialogue:".length).trim().split(",");
    if (parts.length < 10) continue;
    const start = parseAssTime(parts[1] ?? "");
    const end = parseAssTime(parts[2] ?? "");
    const raw = parts.slice(9).join(",");
    const body = raw.replace(/\{[^}]*\}/g, "").replaceAll("\\N", "\n").replaceAll("\\n", "\n").trim();
    if (body.length === 0 || !(end > start)) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

function parseAssTime(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function parseTimedText(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    const timing = timingIndex === -1 ? undefined : lines[timingIndex];
    if (timing === undefined) continue;
    const [rawStart, rawEnd] = timing.split("-->");
    if (rawStart === undefined || rawEnd === undefined) continue;
    let start: number;
    let end: number;
    try {
      start = parseTime(rawStart.trim().split(/\s+/)[0] ?? "");
      end = parseTime(rawEnd.trim().split(/\s+/)[0] ?? "");
    } catch (error) {
      if (error instanceof CliError) continue;
      throw error;
    }
    const body = lines.slice(timingIndex + 1).join("\n").trim();
    if (!(end > start) || body.length === 0) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}
