import { deflateSync } from "node:zlib";
import type { Rgba } from "./style.js";

export interface InkBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Signed distance of a pixel center to a rounded rectangle. Negative is inside. */
export function roundedDistance(x: number, y: number, width: number, height: number, radius: number): number {
  const px = x + 0.5;
  const py = y + 0.5;
  const qx = Math.abs(px - width / 2) - (width / 2 - radius);
  const qy = Math.abs(py - height / 2) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

export function roundedCoverage(x: number, y: number, width: number, height: number, radius: number): number {
  const dist = roundedDistance(x, y, width, height, radius);
  return 1 - Math.min(1, Math.max(0, dist + 0.5));
}

export function inkBounds(rgba: Buffer, width: number, height: number, threshold = 16): InkBox | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return undefined;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~crc) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface PillBitmap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

/**
 * Place the measured ink in the middle of a rounded translucent box.
 * Padding is equal on both sides of the ink, so CJK em-box bearings do not shift the glyphs.
 */
export function composePill(input: {
  readonly text: Buffer;
  readonly textWidth: number;
  readonly textHeight: number;
  readonly ink: InkBox;
  readonly fontSize: number;
  readonly background: Rgba;
  readonly radiusFactor: number;
  readonly padXFactor: number;
  readonly padYFactor: number;
}): PillBitmap {
  const padX = Math.max(1, Math.round(input.fontSize * input.padXFactor));
  const padY = Math.max(1, Math.round(input.fontSize * input.padYFactor));
  const width = input.ink.w + padX * 2;
  const height = input.ink.h + padY * 2;
  const radius = Math.min(
    Math.round(input.fontSize * input.radiusFactor),
    Math.floor(width / 2),
    Math.floor(height / 2),
  );
  const rgba = Buffer.alloc(width * height * 4);
  const { r, g, b, a } = input.background;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const coverage = roundedCoverage(x, y, width, height, radius);
      if (coverage <= 0) continue;
      const index = (y * width + x) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = Math.round(coverage * a * 255);
    }
  }
  for (let y = 0; y < input.ink.h; y += 1) {
    for (let x = 0; x < input.ink.w; x += 1) {
      const source = ((input.ink.y + y) * input.textWidth + (input.ink.x + x)) * 4;
      const textAlpha = (input.text[source + 3] ?? 0) / 255;
      if (textAlpha <= 0) continue;
      const destIndex = ((padY + y) * width + (padX + x)) * 4;
      const backAlpha = (rgba[destIndex + 3] ?? 0) / 255;
      const outAlpha = textAlpha + backAlpha * (1 - textAlpha);
      if (outAlpha <= 0) continue;
      const sr = input.text[source] ?? 0;
      const sg = input.text[source + 1] ?? 0;
      const sb = input.text[source + 2] ?? 0;
      rgba[destIndex] = Math.round((sr * textAlpha + (rgba[destIndex] ?? 0) * backAlpha * (1 - textAlpha)) / outAlpha);
      rgba[destIndex + 1] = Math.round((sg * textAlpha + (rgba[destIndex + 1] ?? 0) * backAlpha * (1 - textAlpha)) / outAlpha);
      rgba[destIndex + 2] = Math.round((sb * textAlpha + (rgba[destIndex + 2] ?? 0) * backAlpha * (1 - textAlpha)) / outAlpha);
      rgba[destIndex + 3] = Math.round(outAlpha * 255);
    }
  }
  return { width, height, rgba };
}
