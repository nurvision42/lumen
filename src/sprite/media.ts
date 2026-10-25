import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { execText } from "../tools/run.js";
import type { Sample } from "./select.js";

/** ffprobe csv can leave a trailing comma on the first value. */
export function probeNumbers(stdout: string): number[] {
  const times: number[] = [];
  for (const token of stdout.split(/\s+/)) {
    const cleaned = token.replaceAll(",", "");
    if (cleaned.length === 0) continue;
    const value = Number(cleaned);
    if (Number.isFinite(value)) times.push(value);
  }
  return times;
}

export interface Cut {
  readonly time: number;
  readonly score: number;
}

export function parseSceneLog(text: string): Cut[] {
  const cuts: Cut[] = [];
  let pending: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const time = line.match(/pts_time:([0-9]+(?:\.[0-9]+)?)/);
    if (time?.[1] !== undefined) pending = Number(time[1]);
    const score = line.match(/lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/);
    if (score?.[1] !== undefined && pending !== undefined) {
      cuts.push({ time: pending, score: Number(score[1]) });
      pending = undefined;
    }
  }
  return cuts;
}

export async function probeDuration(ffprobe: string, video: string): Promise<number> {
  const { stdout } = await execText(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    video,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || !(duration > 0)) throw new CliError(`could not read a duration from ${video}`);
  return duration;
}

export async function listFrameTimes(ffprobe: string, video: string): Promise<number[]> {
  const { stdout } = await execText(ffprobe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    video,
  ]);
  return uniqueTimes(probeNumbers(stdout));
}

/** Keep each real timestamp. Only exact millisecond duplicates are dropped. */
export function uniqueTimes(times: readonly number[]): number[] {
  const seen = new Set<string>();
  const kept: number[] = [];
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    const key = time.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(time);
  }
  return kept;
}

export async function snapTime(ffprobe: string, video: string, time: number, end?: number): Promise<number> {
  const from = Math.max(0, time - 0.25);
  try {
    const { stdout } = await execText(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-read_intervals", `${from.toFixed(3)}%+#20`,
      "-show_entries", "frame=pts_time",
      "-of", "csv=p=0",
      video,
    ]);
    const times = probeNumbers(stdout);
    const eligible = end === undefined ? times : times.filter((value) => value < end - 1e-4);
    const pool = eligible.length > 0 ? eligible : times;
    if (pool.length === 0) return time;
    return pool.reduce((best, value) => Math.abs(value - time) < Math.abs(best - time) ? value : best);
  } catch {
    return time;
  }
}

export async function extractFrame(ffmpeg: string, video: string, time: number, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await execText(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", video,
    "-ss", time.toFixed(6),
    "-frames:v", "1",
    "-an",
    "-f", "image2",
    dest,
  ]);
}

export async function detectCuts(
  ffmpeg: string,
  video: string,
  threshold: number,
  sampleRate: number | undefined,
): Promise<Cut[]> {
  if (!(threshold >= 0) || !(threshold <= 1)) throw new CliError("--threshold must be from 0 to 1", 2);
  if (sampleRate !== undefined && !(sampleRate > 0)) throw new CliError("--sample-rate must be greater than 0", 2);
  const select = `select='gte(scene,${threshold})',metadata=print`;
  const filter = sampleRate === undefined ? select : `fps=${sampleRate},${select}`;
  try {
    const { stderr, stdout } = await execText(ffmpeg, [
      "-hide_banner",
      "-i", video,
      "-filter:v", filter,
      "-an",
      "-f", "null",
      "-",
    ]);
    return parseSceneLog(`${stdout}\n${stderr}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cuts = parseSceneLog(message);
    if (cuts.length > 0) return cuts;
    throw error;
  }
}

export async function snapSamples(
  ffprobe: string,
  video: string,
  samples: readonly Sample[],
): Promise<Sample[]> {
  const snapped: Sample[] = [];
  for (const sample of samples) {
    const time = await snapTime(ffprobe, video, sample.time);
    snapped.push({ ...sample, time });
  }
  const seen = new Set<string>();
  return snapped.filter((sample) => {
    const key = sample.time.toFixed(3);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
