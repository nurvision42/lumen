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
