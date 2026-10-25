import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { SharpModule } from "../tools/resolve.js";
import { formatTime, type Sample } from "./select.js";

const exec = promisify(execFile);

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\msyh.ttf",
];

const FAMILIES = "WenQuanYi Micro Hei, Droid Sans Fallback, Noto Sans CJK SC, Noto Sans SC, Source Han Sans SC, PingFang SC, Microsoft YaHei, sans-serif";

export async function findCjkFont(): Promise<string | undefined> {
  for (const file of FONT_CANDIDATES) {
    try {
      await access(file, constants.R_OK);
      return file;
    } catch {
      // try the next face
    }
  }
  try {
    const result = await exec("fc-list", [":lang=zh", "file"], { timeout: 5000 });
    const line = String(result.stdout ?? "").split(/\r?\n/).map((item) => item.split(":")[0]?.trim()).find((item) => item !== undefined && item.length > 0);
    return line;
  } catch {
    return undefined;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipText(value: string, max = 42): string {
  const chars = [...value];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max - 1).join("")}…`;
}

function labelLines(sample: Sample): string[] {
  const time = formatTime(sample.time);
  const head = sample.id === undefined ? time : `${time}  镜头 ${sample.id}`;
  return sample.text === undefined ? [head] : [head, clipText(sample.text)];
}

function labelSvg(width: number, lines: readonly string[], fontFile: string | undefined): Buffer {
  const height = 16 + lines.length * 22;
  const face = fontFile === undefined
    ? ""
    : `@font-face { font-family: "Lumen CJK"; src: url("file://${encodeURI(fontFile.replaceAll("\\", "/"))}"); }`;
  const family = fontFile === undefined ? FAMILIES : `"Lumen CJK", ${FAMILIES}`;
  const text = lines.map((line, index) => {
    const y = 22 + index * 22;
    return `<text x="8" y="${y}" fill="#f4f4f4" font-size="16" font-family="${family}">${escapeXml(line)}</text>`;
  }).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>${face}</style><rect width="100%" height="100%" fill="#161616"/>${text}</svg>`,
  );
}

export function pagePaths(to: string, count: number): string[] {
  if (count <= 1) return [to];
  const ext = path.extname(to);
  const base = ext.length > 0 ? to.slice(0, -ext.length) : to;
  const suffix = ext.length > 0 ? ext : ".png";
  return Array.from({ length: count }, (_, index) => index === 0 ? to : `${base}-${index + 1}${suffix}`);
}

export async function renderPages(
  sharp: SharpModule,
  frames: readonly { file: string; sample: Sample }[],
  options: { readonly columns: number; readonly rows: number; readonly cell: number; readonly fontFile?: string },
): Promise<Buffer[]> {
  const first = frames[0];
  if (first === undefined) return [];
  const meta = await sharp(first.file).metadata();
  const imageHeight = Math.max(1, Math.round(options.cell * (meta.height ?? 9) / (meta.width ?? 16)));
  const labelHeight = 16 + Math.max(...frames.map((frame) => labelLines(frame.sample).length)) * 22;
  const cellHeight = imageHeight + labelHeight;
  const prepared = [];
  for (const frame of frames) {
    const image = await sharp(frame.file).resize(options.cell, imageHeight, { fit: "fill" }).png().toBuffer();
    let label = labelSvg(options.cell, labelLines(frame.sample), options.fontFile);
    let cell: Buffer;
    try {
      cell = await sharp({
        create: { width: options.cell, height: cellHeight, channels: 3, background: "#161616" },
      }).composite([
        { input: image, left: 0, top: 0 },
        { input: label, left: 0, top: imageHeight },
      ]).png().toBuffer();
    } catch {
      label = labelSvg(options.cell, labelLines(frame.sample), undefined);
      cell = await sharp({
        create: { width: options.cell, height: cellHeight, channels: 3, background: "#161616" },
      }).composite([
        { input: image, left: 0, top: 0 },
        { input: label, left: 0, top: imageHeight },
      ]).png().toBuffer();
    }
    prepared.push(cell);
  }
  const perPage = options.columns * options.rows;
  const pad = 8;
  const margin = 12;
  const pageWidth = margin * 2 + options.columns * options.cell + (options.columns - 1) * pad;
  const pageHeight = margin * 2 + options.rows * cellHeight + (options.rows - 1) * pad;
  const pages: Buffer[] = [];
  for (let offset = 0; offset < prepared.length; offset += perPage) {
    const slice = prepared.slice(offset, offset + perPage);
    const composites = slice.map((input, index) => {
      const column = index % options.columns;
      const row = Math.floor(index / options.columns);
      return {
        input,
        left: margin + column * (options.cell + pad),
        top: margin + row * (cellHeight + pad),
      };
    });
    pages.push(await sharp({
      create: { width: pageWidth, height: pageHeight, channels: 3, background: "#0e0e0e" },
    }).composite(composites).png().toBuffer());
  }
  return pages;
}
