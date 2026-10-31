import { rm } from "node:fs/promises";
import { CliError } from "../errors.js";
import { execText } from "../tools/run.js";

/** Fixed. Overlay opacity on luma only; chroma opacity stays 0. */
export const GRAIN_STRENGTH = 0.55;

export const BITRATE_FALLBACK_NOTE = "video stream bit_rate was missing; using format bit_rate";

export function evenSize(value: number): number {
  const whole = Math.trunc(value);
  const even = whole - (whole % 2);
  return even >= 2 ? even : 2;
}

export interface GrainGeometry {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly grainWidth: number;
  readonly grainHeight: number;
}

/** Grain is built at half the even frame size, then scaled back up. Both sizes stay even. */
export function grainGeometry(width: number, height: number): GrainGeometry {
  const frameWidth = evenSize(width);
  const frameHeight = evenSize(height);
  return {
    frameWidth,
    frameHeight,
    grainWidth: evenSize(Math.floor(frameWidth / 2)),
    grainHeight: evenSize(Math.floor(frameHeight / 2)),
  };
}

/**
 * Monochrome grain only. The proven graph for 2560×1440 is
 * split → scale to 1280×720 → gray mid-gray noise → slight blur → bicubic back → luma overlay at 0.55.
 */
export function grainFilter(width: number, height: number): string {
  const geometry = grainGeometry(width, height);
  const grain = [
    `scale=${geometry.grainWidth}:${geometry.grainHeight}`,
    "format=gray",
    "geq=lum=128",
    "noise=c0s=60:c0f=t+u",
    "gblur=sigma=0.6",
    `scale=${geometry.frameWidth}:${geometry.frameHeight}:flags=bicubic`,
    "format=yuv420p",
  ].join(",");
  const head = geometry.frameWidth === width && geometry.frameHeight === height
    ? "[0:v]split[base][n]"
    : `[0:v]scale=${geometry.frameWidth}:${geometry.frameHeight}[src];[src]split[base][n]`;
  return `${head};[n]${grain}[g];[base][g]blend=all_mode=overlay:c0_opacity=${GRAIN_STRENGTH}:c1_opacity=0:c2_opacity=0`;
}

export function bitrateToken(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps <= 0) throw new CliError("video bitrate must be a positive integer");
  if (bps % 1000 === 0) return `${bps / 1000}k`;
  return String(bps);
}

export interface BitrateChoice {
  readonly bps: number;
  readonly source: "stream" | "format";
}

function positiveBps(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Prefer v:0 bit_rate. Format bit_rate is the fallback when the stream value is missing. */
export function chooseBitrate(stream: unknown, format: unknown): BitrateChoice {
  const streamBps = positiveBps(stream);
  if (streamBps !== undefined) return { bps: streamBps, source: "stream" };
  const formatBps = positiveBps(format);
  if (formatBps !== undefined) return { bps: formatBps, source: "format" };
  throw new CliError("could not read a video bitrate (stream bit_rate and format bit_rate were missing)");
}

export interface GrainPlan {
  readonly width: number;
  readonly height: number;
  readonly grainWidth: number;
  readonly grainHeight: number;
  readonly filter: string;
  readonly bitrate: BitrateChoice;
  readonly rate: string;
  readonly bufsize: string;
}

export function planFromProbe(data: unknown): GrainPlan {
  const record = data as {
    streams?: { width?: unknown; height?: unknown; bit_rate?: unknown }[];
    format?: { bit_rate?: unknown };
  };
  const stream = record.streams?.[0];
  const width = typeof stream?.width === "number" ? stream.width : Number.NaN;
  const height = typeof stream?.height === "number" ? stream.height : Number.NaN;
  if (!(width > 0) || !(height > 0)) throw new CliError("could not read video size");
  const geometry = grainGeometry(width, height);
  const bitrate = chooseBitrate(stream?.bit_rate, record.format?.bit_rate);
  const doubled = bitrate.bps * 2;
  if (!Number.isSafeInteger(doubled)) throw new CliError("video bitrate is too large");
  return {
    width,
    height,
    grainWidth: geometry.grainWidth,
    grainHeight: geometry.grainHeight,
    filter: grainFilter(width, height),
    bitrate,
    rate: bitrateToken(bitrate.bps),
    bufsize: bitrateToken(doubled),
  };
}

export function grainFfmpegArgs(video: string, output: string, plan: GrainPlan): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    video,
    "-filter_complex",
    plan.filter,
    "-c:v",
    "libx264",
    "-b:v",
    plan.rate,
    "-maxrate",
    plan.rate,
    "-bufsize",
    plan.bufsize,
    "-tune",
    "grain",
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    output,
  ];
}

export async function probeGrainPlan(ffprobe: string, video: string): Promise<GrainPlan> {
  const { stdout } = await execText(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,bit_rate:format=bit_rate",
    "-of",
    "json",
    video,
  ]);
  let data: unknown;
  try {
    data = JSON.parse(stdout) as unknown;
  } catch {
    throw new CliError(`could not read video size and bitrate from ${video}`);
  }
  try {
    return planFromProbe(data);
  } catch (error) {
    if (error instanceof CliError && error.message.startsWith("could not read video size")) {
      throw new CliError(`could not read video size and bitrate from ${video}`);
    }
    throw error;
  }
}

/** Writes a grained mp4. Deletes a partial output if ffmpeg fails. */
export async function applyFilmGrain(input: {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly source: string;
  readonly output: string;
}): Promise<GrainPlan> {
  const plan = await probeGrainPlan(input.ffprobe, input.source);
  try {
    await execText(input.ffmpeg, grainFfmpegArgs(input.source, input.output, plan), { timeout: 30 * 60_000 });
  } catch (error) {
    await rm(input.output, { force: true });
    throw error;
  }
  return plan;
}
