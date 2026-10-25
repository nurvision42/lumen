import { CliError } from "../errors.js";

export interface Sample {
  readonly time: number;
  readonly id?: string;
  readonly text?: string;
}

export interface Span {
  readonly id?: string;
  readonly start: number;
  readonly end: number;
  readonly text?: string;
  readonly frames?: number;
  readonly every?: number;
}

const EPSILON = 0.04;

export function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") + `.${String(milli).padStart(3, "0")}`;
}

export function parseTime(value: string): number {
  const text = value.trim().replace(",", ".");
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":");
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((part) => Number(part));
    if (nums.every((num) => Number.isFinite(num) && num >= 0)) {
      if (parts.length === 2) return (nums[0] ?? 0) * 60 + (nums[1] ?? 0);
      return (nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0);
    }
  }
  throw new CliError(`not a time: ${value}`, 2);
}

export function dedupeTimes(times: readonly number[]): number[] {
  const sorted = times.filter((time) => Number.isFinite(time)).map(roundTime).sort((a, b) => a - b);
  const kept: number[] = [];
  for (const time of sorted) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || time - previous > EPSILON) kept.push(time);
  }
  return kept;
}

/** N equal slices; the sample is the midpoint of each slice. */
export function midpointTimes(start: number, end: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new CliError("frames must be a positive integer", 2);
  if (!(end > start)) throw new CliError("range end must be after start");
  const width = (end - start) / count;
  return Array.from({ length: count }, (_, index) => roundTime(start + (index + 0.5) * width));
}

/** Samples at start, start+every, ... while still inside the range. */
export function everyTimes(start: number, end: number, every: number): number[] {
  if (!(every > 0)) throw new CliError("every must be greater than 0", 2);
  if (!(end > start)) throw new CliError("range end must be after start");
  const times: number[] = [];
  for (let time = start; time < end - 1e-6; time += every) times.push(roundTime(time));
  return times.length > 0 ? dedupeTimes(times) : [roundTime(start)];
}

/**
 * Head, middle, and tail. A shot longer than 3 seconds also gets one frame
 * on each whole second inside the shot.
 */
export function shotTimes(start: number, end: number): number[] {
  const duration = end - start;
  if (!(duration > 0)) return [];
  const inset = Math.min(1 / 30, duration / 2);
  const times = [start, start + duration / 2, end - inset];
  if (duration > 3) {
    for (let time = Math.ceil(start + 1e-6); time < end; time += 1) {
      if (time > start && time < end) times.push(time);
    }
  }
  return dedupeTimes(times).filter((time) => time >= start && time < end);
}

export function samplesForSpan(span: Span): Sample[] {
  const times = span.every !== undefined
    ? everyTimes(span.start, span.end, span.every)
    : span.frames !== undefined
      ? midpointTimes(span.start, span.end, span.frames)
      : shotTimes(span.start, span.end);
  return times.map((time) => ({
    time,
    ...(span.id === undefined ? {} : { id: span.id }),
    ...(span.text === undefined || span.text.length === 0 ? {} : { text: span.text }),
  }));
}

export function clipSpan(span: Span, start: number | undefined, end: number | undefined): Span | undefined {
  const nextStart = Math.max(span.start, start ?? span.start);
  const nextEnd = Math.min(span.end, end ?? span.end);
  if (!(nextEnd > nextStart)) return undefined;
  return { ...span, start: nextStart, end: nextEnd };
}

/** Fixed interval used when a video has no breakdown and no scene cuts. */
export const FALLBACK_EVERY = 1;
