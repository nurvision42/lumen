import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../errors.js";
import { execText } from "../tools/run.js";
import { composePill, encodePng, inkBounds } from "./png.js";
import { BACKGROUND_COLOR, PAD_X_FACTOR, PAD_Y_FACTOR, RADIUS_FACTOR, type Rgba } from "./style.js";

export interface PillStyle {
  readonly fontFile: string;
  readonly fontSize: number;
  readonly maxWidth: number;
  readonly color: Rgba;
  readonly background: Rgba;
  readonly radiusFactor: number;
  readonly padXFactor: number;
  readonly padYFactor: number;
}

export function filterArg(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll(" ", "\\ ");
}

function emWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 0.55;
  return 1;
}

/** Wrap on a rough em width. The real ink is measured after drawtext. */
export function wrapSubtitle(text: string, fontSize: number, maxWidth: number): string {
  const budget = Math.max(1, maxWidth / Math.max(1, fontSize));
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    let line = "";
    let width = 0;
    for (const ch of paragraph) {
      const size = emWidth(ch);
      if (line.length > 0 && width + size > budget) {
        lines.push(line);
        line = ch;
        width = size;
      } else {
        line += ch;
        width += size;
      }
    }
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

function canvasFor(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((line) => [...line].reduce((sum, ch) => sum + emWidth(ch), 0)));
  return {
    width: Math.min(4096, Math.max(32, Math.ceil(longest * fontSize + fontSize * 2))),
    height: Math.min(4096, Math.max(32, Math.ceil(lines.length * fontSize * 1.5 + fontSize))),
  };
}

async function drawText(
  ffmpeg: string,
  text: string,
  style: PillStyle,
  canvas: { width: number; height: number },
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-caption-"));
  const textFile = path.join(dir, "line.txt");
  const rawFile = path.join(dir, "ink.rgba");
  try {
    await writeFile(textFile, text.replaceAll("%", "%%"));
    const color = `0x${[style.color.r, style.color.g, style.color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    const filter = [
      `drawtext=fontfile=${filterArg(style.fontFile)}`,
      `textfile=${filterArg(textFile)}`,
      `fontsize=${style.fontSize}`,
      `fontcolor=${color}`,
      "x=8",
      "y=8",
      `line_spacing=${Math.max(0, Math.round(style.fontSize * 0.2))}`,
    ].join(":");
    await execText(ffmpeg, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `color=c=black@0.0:s=${canvas.width}x${canvas.height}:d=0.04,format=rgba`,
      "-vf", filter,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      rawFile,
    ]);
    const raw = await readFile(rawFile);
    if (raw.length !== canvas.width * canvas.height * 4) {
      throw new CliError("ffmpeg did not return the subtitle raster");
    }
    return raw;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Draw the line, measure the opaque pixels, then center that ink in the rounded box.
 * Anchoring the em box (ASS \\an5 / anchor=mm) leaves CJK glyphs high or low inside the fill.
 */
export async function renderPill(ffmpeg: string, text: string, style: PillStyle): Promise<{ png: Buffer; width: number; height: number }> {
  const wrapped = wrapSubtitle(text, style.fontSize, style.maxWidth);
  let canvas = canvasFor(wrapped, style.fontSize);
  let raw = await drawText(ffmpeg, wrapped, style, canvas);
  let ink = inkBounds(raw, canvas.width, canvas.height);
  if (ink !== undefined && (ink.x <= 1 || ink.y <= 1 || ink.x + ink.w >= canvas.width - 1 || ink.y + ink.h >= canvas.height - 1)) {
    canvas = {
      width: Math.min(4096, canvas.width * 2),
      height: Math.min(4096, canvas.height * 2),
    };
    raw = await drawText(ffmpeg, wrapped, style, canvas);
    ink = inkBounds(raw, canvas.width, canvas.height);
  }
  if (ink === undefined) {
    throw new CliError(`subtitle text did not render. Pass --font with a CJK font file. Missing face for: ${text}`);
  }
  const pill = composePill({
    text: raw,
    textWidth: canvas.width,
    textHeight: canvas.height,
    ink,
    fontSize: style.fontSize,
    background: style.background,
    radiusFactor: style.radiusFactor,
    padXFactor: style.padXFactor,
    padYFactor: style.padYFactor,
  });
  return { png: encodePng(pill.rgba, pill.width, pill.height), width: pill.width, height: pill.height };
}

export function defaultPillStyle(fontFile: string, fontSize: number, frameWidth: number, overrides: Partial<PillStyle> = {}): PillStyle {
  return {
    fontFile,
    fontSize,
    maxWidth: Math.max(fontSize * 2, Math.floor(frameWidth * 0.86)),
    color: overrides.color ?? { ...{ r: 255, g: 255, b: 255, a: 1 } },
    background: overrides.background ?? BACKGROUND_COLOR,
    radiusFactor: overrides.radiusFactor ?? RADIUS_FACTOR,
    padXFactor: overrides.padXFactor ?? PAD_X_FACTOR,
    padYFactor: overrides.padYFactor ?? PAD_Y_FACTOR,
  };
}
