import type { ModelBinding } from "../config.js";
import {
  SEEDREAM_RESOLUTIONS,
  assertImageProviderRules,
  type ImageRequest,
} from "../catalog.js";
import { CliError } from "../errors.js";
import { joinUrl, type HttpCall } from "../http.js";
import { isLocalMedia } from "./beeftv.js";
import { jsonCall, wireModel } from "./wire.js";

/**
 * Volcengine Ark (火山方舟) OpenAI-compatible image generation.
 * POST {base}/images/generations
 * Docs: https://www.volcengine.com/docs/82379/1541523
 *
 * Seedream 5.0 Pro and Flash generate one image. They do not accept
 * sequential_image_generation, stream, or web search. watermark defaults to
 * true on the API; lumen always sends false.
 *
 * size is either a tier (1K, 1.5K, 2K) or 宽x高. Total pixels for 宽x高 must
 * sit in [1280x720 = 921600, 2048x2048x1.1025 = 4624220], aspect in [1/16, 16].
 * The pixel table below is the official mapping for common aspects.
 */
export const VOLCARK_IMAGE_PATH = "/images/generations";
export const SEEDREAM_MIN_PIXELS = 1280 * 720;
export const SEEDREAM_MAX_PIXELS = Math.floor(2048 * 2048 * 1.1025);

const OFFICIAL_PIXELS: Record<(typeof SEEDREAM_RESOLUTIONS)[number], Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1424x800",
    "9:16": "800x1424",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1568x672",
  },
  "1.5K": {
    "1:1": "1536x1536",
    "4:3": "1792x1344",
    "3:4": "1344x1792",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "1872x1248",
    "2:3": "1248x1872",
    "21:9": "2352x1008",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2368x1776",
    "3:4": "1776x2368",
    "16:9": "2816x1584",
    "9:16": "1584x2816",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
};

/** 1:1 area of each tier. Used only for aspects the official table does not list. */
const TIER_AREA: Record<(typeof SEEDREAM_RESOLUTIONS)[number], number> = {
  "1K": 1024 * 1024,
  "1.5K": 1536 * 1536,
  "2K": 2048 * 2048,
};

function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

function assertSeedreamPixels(size: string): void {
  const [width, height] = size.split("x").map(Number);
  const pixels = width !== undefined && height !== undefined ? width * height : 0;
  const ratio = width !== undefined && height !== undefined && Math.min(width, height) > 0
    ? Math.max(width, height) / Math.min(width, height)
    : Number.POSITIVE_INFINITY;
  if (
    width === undefined || height === undefined ||
    width % 16 !== 0 || height % 16 !== 0 ||
    pixels < SEEDREAM_MIN_PIXELS || pixels > SEEDREAM_MAX_PIXELS ||
    ratio > 16
  ) {
    throw new CliError(
      `size ${size} is outside Seedream 5.0 limits (multiple of 16, ${SEEDREAM_MIN_PIXELS}-${SEEDREAM_MAX_PIXELS} pixels, ratio <= 16)`,
    );
  }
}

function pixelsFor(aspect: string, area: number): string {
  const [wRaw, hRaw] = aspect.split(":").map(Number);
  if (wRaw === undefined || hRaw === undefined || !(wRaw > 0) || !(hRaw > 0)) {
    throw new CliError(`aspect-ratio ${aspect} has no seedream size`);
  }
  const width = snap16(Math.sqrt((area * wRaw) / hRaw));
  const height = snap16(Math.sqrt((area * hRaw) / wRaw));
  return `${width}x${height}`;
}

/**
 * `auto` sends the tier (`1K` / `1.5K` / `2K`) and lets the model read shape from the prompt.
 * A concrete aspect sends official 宽x高 so the flag is honored.
 */
export function seedreamSize(aspect: string, resolution: string): string {
  if (!(SEEDREAM_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new CliError(`resolution must be one of ${SEEDREAM_RESOLUTIONS.join(", ")}`);
  }
  const tier = resolution as (typeof SEEDREAM_RESOLUTIONS)[number];
  if (aspect === "auto") return tier;
  const official = OFFICIAL_PIXELS[tier][aspect];
  if (official !== undefined) return official;
  const size = pixelsFor(aspect, TIER_AREA[tier]);
  assertSeedreamPixels(size);
  return size;
}

export function missingVolcarkKey(envName: string): CliError {
  const named = envName === "ARK_API_KEY"
    ? "请设置环境变量 ARK_API_KEY 后再执行。"
    : `请设置环境变量 ${envName} 后再执行。火山方舟的官方变量名是 ARK_API_KEY。`;
  return new CliError(`缺少火山方舟 API Key。${named}不要把密钥写进命令、配置或对话。`);
}

export function missingVolcarkTos(): CliError {
  return new CliError(
    '火山方舟的本地参考图要上传到火山引擎 TOS（默认私有桶 lumen42，预签名 GET）。请在配置里加上 "tos": {}，并设置 VOLC_ACCESSKEY 和 VOLC_SECRETKEY。公网 https:// 或 data:image/...;base64,... 不必上传。',
  );
}

export function assertVolcarkReference(source: string): void {
  if (/^https:\/\//i.test(source)) return;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) return;
  if (isLocalMedia(source)) return;
  throw new CliError(`火山方舟参考图只接受 https://、data:image/...;base64,... 或本地文件：${source}`);
}

/** JSON body for one image. References must already be https or data URIs. */
export function planVolcarkImage(request: ImageRequest, binding: ModelBinding): HttpCall[] {
  assertImageProviderRules(request, binding.provider);
  const model = wireModel(request.modelId, binding.modelAlias);
  const size = seedreamSize(request.aspectRatio, request.resolution);
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    size,
    response_format: "url",
    output_format: "png",
    watermark: false,
  };
  if (request.background !== undefined) body.background = request.background;
  if (request.references.length === 1) body.image = request.references[0];
  else if (request.references.length > 1) body.image = request.references;
  return [jsonCall("POST", joinUrl(binding.baseUrl, VOLCARK_IMAGE_PATH), {}, body)];
}
