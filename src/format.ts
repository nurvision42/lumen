import path from "node:path";

export type MediaKind = "image" | "video" | "audio";

export interface SettleMediaOptions {
  kind: MediaKind;
  /** Used when bytes and Content-Type do not identify a format. Include the dot. */
  fallback: string;
  contentType?: string;
}

export interface SettledMediaPath {
  path: string;
  extension: string;
  /** Canonical extension that was detected, if any. */
  detected?: string;
  warning?: string;
}

const EXT_ALIASES: Record<string, string> = {
  ".jpeg": ".jpg",
  ".tiff": ".tif",
  ".mpg": ".mpeg",
};

const CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
  "image/tiff": ".tif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mpeg3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
  "application/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/aac": ".aac",
  "audio/x-aac": ".aac",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
};

const FORMAT_LABELS: Record<string, string> = {
  ".png": "PNG",
  ".jpg": "JPEG",
  ".webp": "WebP",
  ".gif": "GIF",
  ".bmp": "BMP",
  ".tif": "TIFF",
  ".avif": "AVIF",
  ".heic": "HEIC",
  ".mp4": "MP4",
  ".mov": "MOV",
  ".webm": "WebM",
  ".mkv": "Matroska",
  ".avi": "AVI",
  ".m4v": "M4V",
  ".mp3": "MP3",
  ".wav": "WAV",
  ".ogg": "OGG",
  ".flac": "FLAC",
  ".aac": "AAC",
  ".m4a": "M4A",
};

const RUN_ID = "\\d{8}T\\d{6}Z-[0-9a-f]{4}";

export function canonicalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  if (!lower.startsWith(".")) return EXT_ALIASES[`.${lower}`] ?? `.${lower}`;
  return EXT_ALIASES[lower] ?? lower;
}

export function formatLabel(ext: string): string {
  const canon = canonicalizeExtension(ext);
  return FORMAT_LABELS[canon] ?? canon.slice(1).toUpperCase();
}

/** Receipts and sidecars sit next to the media file, regardless of the final extension. */
export function withoutMediaExtension(file: string): string {
  const ext = path.extname(file);
  if (ext.length === 0) return file;
  return file.slice(0, -ext.length);
}

export function replaceExtension(file: string, ext: string): string {
  const suffix = canonicalizeExtension(ext);
  return `${withoutMediaExtension(file)}${suffix}`;
}

/**
 * Default generated names are `{runId}.{png|mp4|mp3}` or `enhance-{runId}.mp4`.
 * Those may be renamed to match the real bytes. Any other basename is treated
 * as an explicit `--out` path: keep the given extension and warn on a mismatch.
 */
export function isDefaultGeneratedName(file: string): boolean {
  const base = path.basename(file);
  return new RegExp(`^(?:enhance-)?${RUN_ID}\\.(?:png|mp4|mp3)$`, "i").test(base);
}

export function extensionForContentType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (type === undefined || type.length === 0) return undefined;
  if (type === "application/octet-stream" || type === "application/json" || type.startsWith("text/")) return undefined;
  return CONTENT_TYPES[type];
}

export function sniffMediaExtension(bytes: Uint8Array | undefined, kind: MediaKind): string | undefined {
  if (bytes === undefined || bytes.byteLength < 2) return undefined;
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && (bytes.byteLength < 3 || bytes[2] === 0xff)) return ".jpg";
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) && bytes.byteLength >= 6 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return ".gif";
  }
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.byteLength >= 12) {
    const form = latin(bytes, 8, 4);
    if (form === "WEBP") return ".webp";
    if (form === "WAVE") return ".wav";
    if (form === "AVI ") return ".avi";
  }
  if (latin(bytes, 0, 4) === "OggS") return ".ogg";
  if (latin(bytes, 0, 4) === "fLaC") return ".flac";
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ebmlExtension(bytes);
  if (latin(bytes, 0, 3) === "ID3") return ".mp3";
  if (bytes[0] === 0xff && bytes.byteLength >= 2) {
    const adts = (bytes[1]! & 0xf6) === 0xf0;
    if (adts) return ".aac";
    if ((bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) === 0x02) return ".mp3";
  }
  if (bytes.byteLength >= 12 && latin(bytes, 4, 4) === "ftyp") return ftypExtension(bytes, kind);
  if (kind === "image" && bytes[0] === 0x42 && bytes[1] === 0x4d) return ".bmp";
  return undefined;
}

export function detectMediaExtension(bytes: Uint8Array | undefined, options: SettleMediaOptions): string {
  return sniffMediaExtension(bytes, options.kind) ?? extensionForContentType(options.contentType) ?? canonicalizeExtension(options.fallback);
}

export function settleMediaPath(planned: string, bytes: Uint8Array | undefined, options: SettleMediaOptions): SettledMediaPath {
  const detected = sniffMediaExtension(bytes, options.kind) ?? extensionForContentType(options.contentType);
  const extension = detected ?? canonicalizeExtension(options.fallback);
  const current = path.extname(planned);
  const explicit = !isDefaultGeneratedName(planned);

  if (explicit && current.length > 1) {
    const warning =
      detected !== undefined && canonicalizeExtension(current) !== canonicalizeExtension(detected)
        ? `warning: --out 以 ${current.toLowerCase()} 结尾，但文件是 ${formatLabel(detected)}。已按你给的路径保存，没有改名。`
        : undefined;
    return { path: planned, extension: current, ...(detected === undefined ? {} : { detected }), ...(warning === undefined ? {} : { warning }) };
  }

  const next = current.length > 1 || current === "." || current.length === 0 ? replaceExtension(planned, extension) : `${planned}${extension}`;
  // `file.` has extname ".", replaceExtension already handles it via withoutMediaExtension.
  return { path: next, extension, ...(detected === undefined ? {} : { detected }) };
}

/** Attach bytes to the settled path so writers, `wrote:`, and record.json share one name. */
export function namedMediaFile(
  planned: string,
  bytes: Uint8Array,
  options: SettleMediaOptions,
): { path: string; bytes: Uint8Array; warning?: string } {
  const settled = settleMediaPath(planned, bytes, options);
  return { path: settled.path, bytes, ...(settled.warning === undefined ? {} : { warning: settled.warning }) };
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function latin(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function ftypExtension(bytes: Uint8Array, kind: MediaKind): string {
  const brands = ftypBrands(bytes);
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return ".avif";
  if (brands.some((brand) => brand === "heic" || brand === "heif" || brand === "mif1" || brand === "msf1")) {
    return kind === "image" ? ".heic" : kind === "audio" ? ".m4a" : ".mp4";
  }
  if (brands.some((brand) => brand === "M4A " || brand === "M4B " || brand === "M4P ")) {
    return kind === "video" ? ".mp4" : ".m4a";
  }
  if (brands.some((brand) => brand === "qt  ")) return kind === "audio" ? ".m4a" : ".mov";
  return kind === "audio" ? ".m4a" : ".mp4";
}

function ftypBrands(bytes: Uint8Array): string[] {
  const size = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  const brands = [latin(bytes, 8, 4)];
  const end = Math.min(bytes.byteLength, Number.isFinite(size) && size >= 16 ? size : bytes.byteLength);
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(latin(bytes, offset, 4));
  return brands;
}

function ebmlExtension(bytes: Uint8Array): string {
  const window = latin(bytes, 0, Math.min(bytes.byteLength, 128));
  if (window.includes("matroska")) return ".mkv";
  return ".webm";
}
