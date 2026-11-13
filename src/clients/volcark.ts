import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelBinding } from "../config.js";
import {
  SEEDREAM_RESOLUTIONS,
  assertImageProviderRules,
  assertSeedream55VolcarkOutput,
  isSeedream55Model,
  type ImageRequest,
} from "../catalog.js";
import { CliError } from "../errors.js";
import { joinUrl, type HttpCall } from "../http.js";
import { isLocalMedia } from "./beeftv.js";
import { jsonCall } from "./wire.js";

/**
 * Volcengine Ark (火山方舟) OpenAI-compatible image generation.
 * POST {base}/images/generations
 * Docs: https://www.volcengine.com/docs/82379/1541523
 *
 * Seedream 5.0 Pro, Flash, and 5.5 generate one image. They do not accept
 * sequential_image_generation, stream, or web search. 5.5 also has no fast
 * prompt-optimize mode. watermark defaults to true on the API; lumen always
 * sends false.
 *
 * Seedream 5.5's Ark model id is doubao-seedream-5-5-261028. --model-alias
 * replaces it. output_format defaults to png. background transparent requires png.
 *
 * size is either a tier (1K, 1.5K, 2K) or 宽x高. Total pixels for 宽x高 must
 * sit in [1280x720 = 921600, 2048x2048x1.1025 = 4624220], aspect in [1/16, 16].
 * The pixel table below is the official mapping for common aspects.
 */
export const VOLCARK_IMAGE_PATH = "/images/generations";
/** Ark model id for Seedream 5.5. 5.0 Pro and Flash use the lumen id. */
export const VOLCARK_SEEDREAM_55_WIRE = "doubao-seedream-5-5-261028";

/** Alias wins. Seedream 5.5 otherwise sends the Ark id; 5.0 sends the lumen id. */
export function volcarkImageWireModel(modelId: string, alias: string | undefined): string {
  if (alias !== undefined) return alias;
  if (isSeedream55Model(modelId)) return VOLCARK_SEEDREAM_55_WIRE;
  return modelId;
}

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

const DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** Official image subtypes. The data URI uses the lowercase name, so .jpg is jpeg. */
const IMAGE_FORMATS: Record<string, string> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".bmp": "bmp",
  ".tif": "tiff",
  ".tiff": "tiff",
  ".gif": "gif",
  ".heic": "heic",
  ".heif": "heif",
};

export function assertVolcarkReference(source: string): void {
  if (/^https:\/\//i.test(source)) return;
  if (DATA_URI.test(source)) return;
  if (isLocalMedia(source)) return;
  throw new CliError(`火山方舟参考图只接受 https://、data:image/...;base64,... 或本地文件：${source}`);
}

/**
 * https and an existing data URI pass through. A local file is read and sent as
 * data:image/<format>;base64,... . Volcark does not upload to TOS.
 */
export async function volcarkImageRef(source: string, cwd: string): Promise<string> {
  assertVolcarkReference(source);
  if (/^https:\/\//i.test(source) || DATA_URI.test(source)) return source;
  const file = path.resolve(cwd, source);
  const format = IMAGE_FORMATS[path.extname(file).toLowerCase()];
  if (format === undefined) {
    throw new CliError(`火山方舟参考图格式不支持：${file}。可用 jpeg、png、webp、bmp、tiff、gif、heic、heif。`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(`本地参考图不存在：${file}`);
  }
  return `data:image/${format};base64,${bytes.toString("base64")}`;
}

/** JSON body for one image. References must already be https or data URIs. */
export function planVolcarkImage(request: ImageRequest, binding: ModelBinding): HttpCall[] {
  assertImageProviderRules(request, binding.provider);
  const model = volcarkImageWireModel(request.modelId, binding.modelAlias);
  const size = seedreamSize(request.aspectRatio, request.resolution);
  const outputFormat = isSeedream55Model(request.modelId)
    ? assertSeedream55VolcarkOutput(request.background, request.outputFormat)
    : "png";
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    size,
    response_format: "url",
    output_format: outputFormat,
    watermark: false,
  };
  if (request.background !== undefined) body.background = request.background;
  if (request.references.length === 1) body.image = request.references[0];
  else if (request.references.length > 1) body.image = request.references;
  return [jsonCall("POST", joinUrl(binding.baseUrl, VOLCARK_IMAGE_PATH), {}, body)];
}
