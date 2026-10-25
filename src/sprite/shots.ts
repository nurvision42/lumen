import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { LAYOUT } from "../project.js";
import { asRecord } from "../walk.js";
import { parseTime, type Span } from "./select.js";

function textOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "transcript", "vo", "台词", "字幕/台词", "dialogue"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function idOf(record: Record<string, unknown>, index: number): string {
  for (const key of ["id", "#", "镜头序号", "shot"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return String(index + 1);
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return parseTime(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rangeFromText(value: string): { start: number; end: number } | undefined {
  const match = value.trim().match(/^([0-9:.,]+)\s*(?:-->|[-–—]|至|到)\s*([0-9:.,]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  try {
    return { start: parseTime(match[1]), end: parseTime(match[2]) };
  } catch {
    return undefined;
  }
}

function spanFromRecord(record: Record<string, unknown>, index: number): Span | undefined {
  const timecode = record["起止时间码"] ?? record.timecode ?? record.time;
  const parsed = typeof timecode === "string" ? rangeFromText(timecode) : undefined;
  const start = parsed?.start ?? numberOf(record.start ?? record.startSec ?? record.in);
  const end = parsed?.end ?? numberOf(record.end ?? record.endSec ?? record.out);
  const text = textOf(record);
  const frames = numberOf(record.frames);
  const every = numberOf(record.every);
  if (start !== undefined && end !== undefined && end > start) {
    return {
      id: idOf(record, index),
      start,
      end,
      ...(text === undefined ? {} : { text }),
      ...(frames === undefined ? {} : { frames }),
      ...(every === undefined ? {} : { every }),
    };
  }
  return undefined;
}

function spansFromDuration(rows: readonly Record<string, unknown>[]): Span[] | undefined {
  if (!rows.some((row) => numberOf(row.durationSec) !== undefined)) return undefined;
  let cursor = 0;
  const spans: Span[] = [];
  rows.forEach((row, index) => {
    const duration = numberOf(row.durationSec);
    if (duration === undefined || !(duration > 0)) return;
    const text = textOf(row);
    spans.push({
      id: idOf(row, index),
      start: cursor,
      end: cursor + duration,
      ...(text === undefined ? {} : { text }),
    });
    cursor += duration;
  });
  return spans.length > 0 ? spans : undefined;
}

function spansFromArray(value: unknown): Span[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows = value.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined);
  if (rows.length !== value.length) return undefined;
  const ranged = rows.map((row, index) => spanFromRecord(row, index));
  if (ranged.every((span) => span !== undefined)) return ranged as Span[];
  return spansFromDuration(rows);
}

export function spansFromText(text: string): Span[] | undefined {
  const blocks = text.split(/(?=镜头\s*\d+)/);
  const spans: Span[] = [];
  for (const block of blocks) {
    const id = block.match(/镜头\s*(\d+)/)?.[1];
    const time = block.match(/起止时间码\s*[:：]\s*([0-9:.,]+)\s*(?:-->|[-–—]|至|到)\s*([0-9:.,]+)/);
    if (id === undefined || time?.[1] === undefined || time[2] === undefined) continue;
    let start: number;
    let end: number;
    try {
      start = parseTime(time[1]);
      end = parseTime(time[2]);
    } catch {
      continue;
    }
    if (!(end > start)) continue;
    const dialogue = block.match(/(?:字幕\/台词|台词)\s*[:：]\s*(.+)/)?.[1]?.trim();
    spans.push({
      id,
      start,
      end,
      ...(dialogue === undefined || dialogue.length === 0 ? {} : { text: dialogue }),
    });
  }
  return spans.length > 0 ? spans : undefined;
}

export function spansFromValue(value: unknown, depth = 0): Span[] | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") return spansFromText(value);
  const direct = spansFromArray(value);
  if (direct !== undefined && direct.length > 0) return direct;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (Array.isArray(record.shots)) {
    const nested = spansFromArray(record.shots);
    if (nested !== undefined && nested.length > 0) return nested;
  }
  for (const key of ["result", "data", "contents", "output", "text"]) {
    const nested = spansFromValue(record[key], depth + 1);
    if (nested !== undefined && nested.length > 0) return nested;
  }
  return undefined;
}

export function parseSrt(text: string): Span[] {
  const spans: Span[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    const timing = timingIndex === -1 ? undefined : lines[timingIndex];
    if (timing === undefined) continue;
    const [rawStart, rawEnd] = timing.split("-->");
    if (rawStart === undefined || rawEnd === undefined) continue;
    const start = parseTime(rawStart.trim().split(/\s+/)[0] ?? "");
    const end = parseTime(rawEnd.trim().split(/\s+/)[0] ?? "");
    const cue = lines.slice(timingIndex + 1).join(" ").trim();
    if (!(end > start) || cue.length === 0) continue;
    spans.push({ start, end, text: cue });
  }
  return spans;
}

function spansFromMarkdown(text: string): Span[] | undefined {
  const lines = text.split(/\r?\n/);
  let header: string[] | undefined;
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (header === undefined) {
      header = cells;
      continue;
    }
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    rows.push(record);
  }
  return rows.length === 0 ? undefined : spansFromArray(rows);
}

export async function loadSpans(file: string): Promise<Span[]> {
  const text = await readFile(file, "utf8");
  const trimmed = text.trim();
  if (file.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new CliError(`${file}: not valid JSON`);
    }
    const spans = spansFromValue(data);
    if (spans === undefined || spans.length === 0) throw new CliError(`${file}: no shot times`);
    return spans;
  }
  const spans = spansFromText(text) ?? spansFromMarkdown(text) ?? (text.includes("-->") ? parseSrt(text) : undefined);
  if (spans === undefined || spans.length === 0) throw new CliError(`${file}: no shot times`);
  return spans;
}

export async function discoverShots(project: string): Promise<{ file: string; spans: Span[] } | undefined> {
  const refs = path.join(project, LAYOUT.refs);
  let names: string[] = [];
  try {
    names = await readdir(refs);
  } catch {
    names = [];
  }
  const understood = names.filter((name) => name.endsWith(".video-understand.json")).map((name) => path.join(refs, name));
  const ranked = await Promise.all(understood.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
  ranked.sort((a, b) => b.mtime - a.mtime);
  const candidates = [
    ...ranked.map((item) => item.file),
    path.join(project, LAYOUT.shotlistJson),
    path.join(project, LAYOUT.shotlistMd),
  ];
  for (const file of candidates) {
    if (!(await fileExists(file))) continue;
    try {
      const spans = await loadSpans(file);
      if (spans.length > 0) return { file, spans };
    } catch {
      // A template or unrelated file is not a breakdown.
    }
  }
  return undefined;
}

export function spansFromCuts(duration: number, cuts: readonly { time: number }[]): Span[] | undefined {
  const points = dedupeBounds([
    0,
    ...cuts.map((cut) => cut.time).filter((time) => time > 0.05 && time < duration - 0.05),
    duration,
  ]);
  if (points.length < 3) return undefined;
  const spans: Span[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] ?? 0;
    const end = points[index + 1] ?? start;
    if (end - start < 0.05) continue;
    spans.push({ id: String(spans.length + 1), start, end });
  }
  return spans.length >= 2 ? spans : undefined;
}

function dedupeBounds(times: readonly number[]): number[] {
  const kept: number[] = [];
  for (const time of [...times].sort((a, b) => a - b)) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || time - previous > 0.05) kept.push(time);
  }
  return kept;
}

export function parseRanges(text: string): Span[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("--ranges is not valid JSON", 2);
  }
  if (!Array.isArray(data)) throw new CliError("--ranges must be a JSON array", 2);
  const spans = data.map((item, index) => {
    const record = asRecord(item);
    if (record === undefined) throw new CliError(`--ranges[${index}] must be an object`, 2);
    const span = spanFromRecord(record, index);
    if (span === undefined) throw new CliError(`--ranges[${index}] needs start and end`, 2);
    return span;
  });
  if (spans.length === 0) throw new CliError("--ranges is empty", 2);
  return spans;
}
