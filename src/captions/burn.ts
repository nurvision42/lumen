import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../errors.js";
import { execText } from "../tools/run.js";
import type { Cue } from "./cues.js";
import { findSubtitleFont } from "./font.js";
import { defaultPillStyle, renderPill, type PillStyle } from "./render.js";
import {
  defaultPosition,
  edgeMarginPx,
  fontSizeFor,
  parseColor,
  pillLeft,
  pillTop,
  type CaptionPosition,
  type Rgba,
} from "./style.js";

export interface BurnStyle {
  readonly position?: CaptionPosition;
  readonly fontSize?: number;
  readonly margin?: number;
  readonly fontFile?: string;
  readonly color?: Rgba;
  readonly background?: Rgba;
  readonly radiusFactor?: number;
  readonly padXFactor?: number;
  readonly padYFactor?: number;
}

export interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

export async function probeVideo(ffprobe: string, video: string): Promise<VideoInfo> {
  const { stdout } = await execText(ffprobe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    video,
  ]);
  let data: { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
  try {
    data = JSON.parse(stdout) as typeof data;
  } catch {
    throw new CliError(`could not read video size and duration from ${video}`);
  }
  const stream = data.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  const duration = Number(data.format?.duration);
  if (width === undefined || height === undefined || !(width > 0) || !(height > 0) || !(duration > 0)) {
    throw new CliError(`could not read video size and duration from ${video}`);
  }
  return { width, height, duration };
}

export interface OverlayItem {
  readonly x: number;
  readonly y: number;
  readonly start: number;
  readonly end: number;
}

export function overlayGraph(items: readonly OverlayItem[], options?: { readonly even?: boolean }): string {
  const parts: string[] = [];
  let previous = "0:v";
  if (options?.even === true) {
    parts.push("[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[base]");
    previous = "base";
  }
  items.forEach((item, index) => {
    const out = index === items.length - 1 ? "vout" : `v${index + 1}`;
    parts.push(`[${index + 1}:v]format=rgba[p${index}]`);
    parts.push(
      `[${previous}][p${index}]overlay=x=${item.x}:y=${item.y}:enable='between(t\\,${item.start.toFixed(3)}\\,${item.end.toFixed(3)})'[${out}]`,
    );
    previous = out;
  });
  return parts.join(";");
}

export interface BurnPlan {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly position: CaptionPosition;
  readonly fontSize: number;
  readonly margin: number;
  readonly fontFile: string;
  readonly cues: number;
}

function cuesInside(cues: readonly Cue[], duration: number): Cue[] {
  return cues.flatMap((cue) => {
    const start = Math.max(0, cue.start);
    const end = Math.min(duration, cue.end);
    const text = cue.text.trim();
    if (text.length === 0 || !(end > start) || start >= duration) return [];
    return [{ ...cue, start, end, text }];
  });
}

export async function resolveBurnPlan(info: VideoInfo, cues: readonly Cue[], style: BurnStyle): Promise<BurnPlan & { visible: Cue[] }> {
  const position = style.position ?? defaultPosition(info.width, info.height);
  const fontSize = fontSizeFor(info.width, info.height, style.fontSize);
  const fontFile = style.fontFile ?? await findSubtitleFont();
  if (fontFile === undefined) {
    throw new CliError("no CJK font found. Install Noto Sans CJK or WenQuanYi Micro Hei, or pass --font <file>");
  }
  const visible = cuesInside(cues, info.duration);
  if (visible.length === 0) throw new CliError("no captions fall inside the video");
  return {
    width: info.width,
    height: info.height,
    duration: info.duration,
    position,
    fontSize,
    margin: edgeMarginPx(info.height, position, style.margin),
    fontFile,
    cues: visible.length,
    visible,
  };
}

export async function burnCaptions(input: {
  readonly ffmpeg: string;
  readonly video: string;
  readonly info: VideoInfo;
  readonly cues: readonly Cue[];
  readonly output: string;
  readonly style: BurnStyle;
}): Promise<BurnPlan> {
  const even = input.info.width % 2 !== 0 || input.info.height % 2 !== 0;
  const frame = even
    ? {
        width: input.info.width - (input.info.width % 2),
        height: input.info.height - (input.info.height % 2),
        duration: input.info.duration,
      }
    : input.info;
  const plan = await resolveBurnPlan(frame, input.cues, input.style);
  const { fontFile, fontSize, position, visible } = plan;
  const style: PillStyle = defaultPillStyle(fontFile, fontSize, frame.width, {
    ...(input.style.color === undefined ? {} : { color: input.style.color }),
    ...(input.style.background === undefined ? {} : { background: input.style.background }),
    ...(input.style.radiusFactor === undefined ? {} : { radiusFactor: input.style.radiusFactor }),
    ...(input.style.padXFactor === undefined ? {} : { padXFactor: input.style.padXFactor }),
    ...(input.style.padYFactor === undefined ? {} : { padYFactor: input.style.padYFactor }),
  });
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-burn-"));
  try {
    const items: OverlayItem[] = [];
    const inputs: string[] = [];
    for (let index = 0; index < visible.length; index += 1) {
      const cue = visible[index];
      if (cue === undefined) continue;
      const pill = await renderPill(input.ffmpeg, cue.text, style);
      const file = path.join(dir, `${String(index).padStart(4, "0")}.png`);
      await writeFile(file, pill.png);
      inputs.push(file);
      items.push({
        x: pillLeft(frame.width, pill.width),
        y: pillTop(frame.height, pill.height, position, input.style.margin),
        start: cue.start,
        end: cue.end,
      });
    }
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.video];
    for (const file of inputs) args.push("-i", file);
    args.push(
      "-filter_complex", overlayGraph(items, { even }),
      "-map", "[vout]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      input.output,
    );
    try {
      await execText(input.ffmpeg, args, { timeout: 600_000 });
    } catch (error) {
      await rm(input.output, { force: true });
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return plan;
}

export function parseBurnColor(value: string | undefined, label: string, fallback: Rgba): Rgba {
  if (value === undefined) return fallback;
  return parseColor(value, label);
}
