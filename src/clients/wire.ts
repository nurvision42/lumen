import { CliError } from "../errors.js";
import { findBase64, findHttpUrl } from "../walk.js";
import type { HttpCall, HttpResult } from "../http.js";

export function wireModel(modelId: string, alias: string | undefined): string {
  return alias ?? modelId;
}

export function assertHttps(source: string, provider: string, what: string): void {
  if (!/^https:\/\//i.test(source)) {
    throw new CliError(`provider ${provider} does not upload local media for ${what}; pass an https URL`);
  }
}

export function jsonCall(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  value?: unknown,
): HttpCall {
  return {
    method,
    url,
    headers,
    body: value === undefined ? { kind: "empty" } : { kind: "json", value },
  };
}

const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;

/** 1K bases. 2K scales by √2 and 4K by 2, then both edges snap to a multiple of 16. */
const IMAGE_SIZE_BASE: Record<string, readonly [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1216, 912],
  "3:4": [912, 1216],
  "3:2": [1344, 896],
  "2:3": [896, 1344],
  "21:9": [1536, 656],
  "9:21": [656, 1536],
  "5:4": [1152, 921],
  "4:5": [921, 1152],
  "2:1": [1536, 768],
  "1:2": [768, 1536],
  "3:1": [1504, 512],
  "1:3": [512, 1504],
};

function snap16(n: number): number {
  return Math.round(n / 16) * 16;
}

function assertOpenAiSize(aspect: string, resolution: string, size: string): void {
  const [width, height] = size.split("x").map(Number);
  const pixels = width !== undefined && height !== undefined ? width * height : 0;
  const ratio = width !== undefined && height !== undefined && Math.min(width, height) > 0
    ? Math.max(width, height) / Math.min(width, height)
    : Number.POSITIVE_INFINITY;
  if (
    width === undefined || height === undefined ||
    width > MAX_EDGE || height > MAX_EDGE ||
    width % 16 !== 0 || height % 16 !== 0 ||
    pixels < MIN_PIXELS || pixels > MAX_PIXELS ||
    ratio > 3
  ) {
    throw new CliError(
      `size ${size} for ${aspect} ${resolution} is outside image limits (edge <= 3840, multiple of 16, 655360-8294400 pixels, ratio <= 3)`,
    );
  }
}

/** Shared gpt-image size. `auto` is only a 1K size; 2K and 4K need a concrete aspect. */
export function imageSize(aspect: string, resolution: "1K" | "2K" | "4K"): string {
  if (aspect === "auto") {
    if (resolution !== "1K") {
      throw new CliError("aspect-ratio auto cannot be combined with resolution 2K or 4K");
    }
    return "auto";
  }
  const base = IMAGE_SIZE_BASE[aspect];
  if (base === undefined) throw new CliError(`aspect-ratio ${aspect} has no image size`);
  const scale = resolution === "1K" ? 1 : resolution === "4K" ? 2 : Math.SQRT2;
  const size = `${snap16(base[0] * scale)}x${snap16(base[1] * scale)}`;
  assertOpenAiSize(aspect, resolution, size);
  return size;
}

export function bytesFromResult(result: HttpResult): Uint8Array | undefined {
  const type = result.contentType.toLowerCase();
  if ((type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) && result.body.byteLength > 0) {
    return result.body;
  }
  const b64 = findBase64(result.json);
  if (b64 === undefined) return undefined;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function httpUrlFromResult(result: HttpResult): string | undefined {
  return findHttpUrl(result.json);
}
