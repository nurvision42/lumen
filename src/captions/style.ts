import { CliError } from "../errors.js";

/** Short side × this ratio. 1440 × 0.039 rounds to 56. */
export const FONT_SIZE_RATIO = 0.039;
/** 317px on a 1440×2560 frame: about 11.4% plus a buffer, as a fraction of height. */
export const PORTRAIT_TOP_MARGIN = 317 / 2560;
/** 225px on a 2560×1440 frame: about 14% plus a buffer, as a fraction of height. */
export const LANDSCAPE_BOTTOM_MARGIN = 225 / 1440;
/** Corner radius = font size × this. */
export const RADIUS_FACTOR = 0.45;
/** Horizontal padding = font size × this, outside the ink. */
export const PAD_X_FACTOR = 0.55;
/** Vertical padding = font size × this, outside the ink, equal above and below. */
export const PAD_Y_FACTOR = 0.38;

export const TEXT_COLOR = { r: 255, g: 255, b: 255, a: 1 };
export const BACKGROUND_COLOR = { r: 70, g: 70, b: 70, a: 0.51 };

export type CaptionPosition = "top_center" | "bottom_center" | "center";

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export function defaultPosition(width: number, height: number): CaptionPosition {
  return height > width ? "top_center" : "bottom_center";
}

export function fontSizeFor(width: number, height: number, override?: number): number {
  if (override !== undefined) return override;
  return Math.max(8, Math.round(Math.min(width, height) * FONT_SIZE_RATIO));
}

export function marginRatioFor(position: CaptionPosition, override?: number): number {
  if (override !== undefined) return override;
  if (position === "top_center") return PORTRAIT_TOP_MARGIN;
  if (position === "bottom_center") return LANDSCAPE_BOTTOM_MARGIN;
  return 0;
}

/** Pixels from the chosen edge to the pill. Center ignores this and uses the frame midpoint. */
export function edgeMarginPx(height: number, position: CaptionPosition, override?: number): number {
  return Math.round(height * marginRatioFor(position, override));
}

export function pillLeft(frameWidth: number, pillWidth: number): number {
  return Math.max(0, Math.round((frameWidth - pillWidth) / 2));
}

/** Top of the pill. Bottom alignment keeps a constant gap under the pill at any resolution. */
export function pillTop(
  frameHeight: number,
  pillHeight: number,
  position: CaptionPosition,
  marginRatio?: number,
): number {
  if (position === "center") return Math.max(0, Math.round((frameHeight - pillHeight) / 2));
  const margin = edgeMarginPx(frameHeight, position, marginRatio);
  const top = position === "top_center" ? margin : frameHeight - margin - pillHeight;
  const maxTop = Math.max(0, frameHeight - pillHeight);
  return Math.min(Math.max(0, top), maxTop);
}

export function parsePosition(value: string | undefined): CaptionPosition | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toLowerCase().replaceAll("-", "_");
  if (key === "top_center" || key === "bottom_center" || key === "center") return key;
  throw new CliError("position must be top_center, bottom_center, or center", 2);
}

export function parseFontSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError("--font-size must be a positive integer", 2);
  const parsed = Number(value);
  if (parsed < 1) throw new CliError("--font-size must be a positive integer", 2);
  return parsed;
}

export function parseMargin(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.45) {
    throw new CliError("--margin must be a ratio from 0 to 0.45", 2);
  }
  return parsed;
}

export function parseFactor(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new CliError(`${name} must be a number from 0 to 2`, 2);
  }
  return parsed;
}

export function parseColor(value: string, label: string): Rgba {
  const hex = value.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex?.[1] !== undefined) {
    const body = hex[1];
    const alpha = hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255;
    return {
      r: Number.parseInt(body.slice(0, 2), 16),
      g: Number.parseInt(body.slice(2, 4), 16),
      b: Number.parseInt(body.slice(4, 6), 16),
      a: alpha,
    };
  }
  const rgba = value.trim().match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
  if (rgba?.[1] !== undefined && rgba[2] !== undefined && rgba[3] !== undefined) {
    const channels = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new CliError(`${label} channels must be 0 to 255`, 2);
    }
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new CliError(`${label} alpha must be from 0 to 1`, 2);
    return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: alpha };
  }
  throw new CliError(`${label} must be #RRGGBB or rgba(r,g,b,a)`, 2);
}
