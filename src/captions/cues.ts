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

/** Below this, a known script is kept for review and is not written onto the cues. */
export const SCRIPT_FIT_MIN = 0.55;

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

interface NormCue {
  start: number;
  end: number;
  normStart: number;
  normEnd: number;
  parts: string[];
  speaker?: string;
}

function scriptPieces(text: string): { chars: string[]; pieces: string[] } {
  const chars: string[] = [];
  const pieces: string[] = [];
  let pending = "";
  for (const ch of text) {
    if (/[\s\p{P}\p{S}]/u.test(ch)) {
      pending += ch;
      continue;
    }
    pending += ch;
    chars.push(ch.toLowerCase());
    pieces.push(pending);
    pending = "";
  }
  if (pending.length > 0) {
    if (pieces.length === 0) pieces.push(pending);
    else pieces[pieces.length - 1] = `${pieces[pieces.length - 1] ?? ""}${pending}`;
  }
  return { chars, pieces };
}

function give(pieces: readonly string[], targets: { cue: NormCue; weight: number }[]): void {
  if (targets.length === 0 || pieces.length === 0) return;
  const total = targets.reduce((sum, target) => sum + target.weight, 0);
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
}

function placeInsert(pieces: readonly string[], at: number, cues: NormCue[], duration: number): void {
  if (pieces.length === 0) return;
  const internal = cues.find((cue) => at > cue.normStart && at < cue.normEnd);
  if (internal !== undefined) {
    internal.parts.push(...pieces);
    return;
  }
  const previous = [...cues].reverse().find((cue) => cue.normEnd <= at && cue.normEnd >= 0);
  const next = cues.find((cue) => cue.normStart >= at);
  const gapStart = previous?.end ?? 0;
  const gapEnd = next?.start ?? duration;
  const words = pieces.join("").replace(/[\s\p{P}\p{S}]/gu, "");
  if (words.length >= 2 && gapEnd - gapStart >= 0.35) {
    cues.push({
      start: gapStart,
      end: gapEnd,
      normStart: -1,
      normEnd: -1,
      parts: [...pieces],
    });
    return;
  }
  if (previous !== undefined) previous.parts.push(...pieces);
  else if (next !== undefined) next.parts.unshift(...pieces);
  else if (duration > 0) {
    cues.push({ start: 0, end: duration, normStart: -1, normEnd: -1, parts: [...pieces] });
  }
}

/** Keep ASR timing. Replace the words with the script where the two line up, and fill long gaps. */
export function alignUntimed(asr: readonly Cue[], script: string, duration: number): Cue[] {
  const { chars, pieces } = scriptPieces(script);
  if (chars.length === 0) return asr.map((cue) => ({ ...cue }));
  const cues: NormCue[] = [];
  let cursor = 0;
  for (const cue of asr) {
    const norm = normalizeCaption(cue.text);
    cues.push({
      start: cue.start,
      end: cue.end,
      normStart: cursor,
      normEnd: cursor + norm.length,
      parts: [],
      ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
    });
    cursor += norm.length;
  }
  if (cues.length === 0) return [];
  const flat: string[] = [];
  for (const cue of asr) flat.push(...normalizeCaption(cue.text));
  const blocks = matchingBlocks(flat, chars);
  let i = 0;
  let j = 0;
  for (const block of blocks) {
    if (i < block.i && j < block.j) {
      const targets = cues
        .map((cue) => {
          const lo = Math.max(cue.normStart, i);
          const hi = Math.min(cue.normEnd, block.i);
          return { cue, weight: Math.max(0, hi - lo) };
        })
        .filter((target) => target.weight > 0);
      give(pieces.slice(j, block.j), targets);
    } else if (j < block.j) {
      placeInsert(pieces.slice(j, block.j), i, cues, duration);
    }
    if (block.size > 0) {
      const targets = cues
        .map((cue) => {
          const lo = Math.max(cue.normStart, block.i);
          const hi = Math.min(cue.normEnd, block.i + block.size);
          return { cue, weight: Math.max(0, hi - lo) };
        })
        .filter((target) => target.weight > 0);
      give(pieces.slice(block.j, block.j + block.size), targets);
    }
    i = block.i + block.size;
    j = block.j + block.size;
  }
  return cues
    .map((cue) => {
      const text = cue.parts.join("").trim();
      return {
        start: roundTime(cue.start),
        end: roundTime(cue.end),
        text,
        ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
      };
    })
    .filter((cue) => cue.text.length > 0 && cue.end > cue.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function applyTimedScript(asr: readonly Cue[], lines: readonly ScriptLine[]): Cue[] {
  const cues: Cue[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0 || line.start === undefined || line.end === undefined || !(line.end > line.start)) continue;
    const overlap = asr.filter((cue) => cue.end > line.start! && cue.start < line.end!);
    let start = line.start;
    let end = line.end;
    if (overlap.length > 0) {
      start = Math.max(line.start, Math.min(...overlap.map((cue) => cue.start)));
      end = Math.min(line.end, Math.max(...overlap.map((cue) => cue.end)));
      if (!(end > start)) {
        start = line.start;
        end = line.end;
      }
    }
    const speakers = [...new Set(overlap.map((cue) => cue.speaker).filter((speaker): speaker is string => speaker !== undefined))];
    cues.push({
      start: roundTime(start),
      end: roundTime(end),
      text,
      ...(speakers.length === 1 && speakers[0] !== undefined ? { speaker: speakers[0] } : {}),
    });
  }
  return cues;
}

export function reconcileCaptions(input: {
  asr: readonly Cue[];
  script?: { source: ScriptNote["source"]; file: string; timed: boolean; lines: readonly ScriptLine[]; text: string };
  duration: number;
}): { cues: Cue[]; clamped: boolean; confirmed: boolean; script: ScriptNote | null } {
  const script = input.script;
  const fit = script === undefined ? undefined : fitRatio(input.asr.map((cue) => cue.text).join(""), script.text);
  const apply = script !== undefined && fit !== undefined && fit >= SCRIPT_FIT_MIN;
  let chosen: Cue[] = input.asr.map((cue) => ({ ...cue }));
  let applied = false;
  if (apply && script !== undefined) {
    const aligned = script.timed ? applyTimedScript(input.asr, script.lines) : alignUntimed(input.asr, script.text, input.duration);
    if (aligned.length > 0) {
      chosen = aligned;
      applied = true;
    }
  } else if (script?.timed === true && input.asr.length === 0) {
    const filled = applyTimedScript([], script.lines);
    if (filled.length > 0) {
      chosen = filled;
      applied = true;
    }
  }
  const clamped = clampCues(chosen, input.duration);
  const confirmed = apply && applied && clamped.cues.length > 0;
  return {
    cues: clamped.cues,
    clamped: clamped.clamped,
    confirmed,
    script: script === undefined || fit === undefined
      ? null
      : {
          source: script.source,
          file: script.file,
          fit: Math.round(fit * 1000) / 1000,
          applied,
        },
  };
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
