import path from "node:path";

export function isRemoteMedia(source: string): boolean {
  return /^(https?:|mediakit:|vod:|tos:)/i.test(source);
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".m4v": "video/x-m4v",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
  };
  return types[ext] ?? "application/octet-stream";
}

export function isProbablyFile(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /\.(wav|mp3|flac|ogg|m4a|bin)$/i.test(value);
}
