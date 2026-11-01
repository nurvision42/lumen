import { SEEDREAM_FLASH_MODEL, SEEDREAM_PRO_MODEL } from "../catalog.js";
import { seedreamSize } from "../clients/volcark.js";
import { CliError } from "../errors.js";

/**
 * Two price tables.
 * volcark (火山方舟): Pro ≤1.5K 0.30, Pro 2K 0.60, Flash 0.12. Image only.
 * beeftv: Flash 0.04 at 1K/1.5K/2K, refs free.
 *   Pro image ≤2.61M px 0.09, above that (the 2K tier) 0.18.
 *   Pro refs: the first is free, each later one is under 0.01.
 * Layer output is not requested, so it is not estimated.
 */
export const SEEDREAM_PRO_YUAN_LE_1_5K = 0.3;
export const SEEDREAM_PRO_YUAN_2K = 0.6;
export const SEEDREAM_FLASH_YUAN = 0.12;
export const BEEFTV_FLASH_YUAN = 0.04;
export const BEEFTV_PRO_YUAN_LE = 0.09;
export const BEEFTV_PRO_YUAN_GT = 0.18;
/** 261万像素. At or under this, BeefTV Pro image generation is 0.09. */
export const BEEFTV_PIXEL_THRESHOLD = 2_610_000;

export interface SeedreamCostInput {
  modelId: string;
  resolution: string;
  provider: string;
  aspectRatio?: string;
  references?: number;
}

export interface SeedreamCost {
  readonly yuan: number;
  /** Known image-generation fee. Extra BeefTV Pro refs are an upper bound in `text`, not added here. */
  readonly text: string;
}

function beefProLarge(resolution: string, aspectRatio: string): boolean {
  if (resolution === "2K") return true;
  const size = seedreamSize(aspectRatio, resolution);
  if (!size.includes("x")) return false;
  const [width, height] = size.split("x").map(Number);
  return (width ?? 0) * (height ?? 0) > BEEFTV_PIXEL_THRESHOLD;
}

function money(yuan: number): string {
  return yuan.toFixed(2);
}

/** Printed before the request is sent, including dry-run. Provider selects the table. */
export function seedreamCost(input: SeedreamCostInput): SeedreamCost {
  const refs = input.references ?? 0;
  if (input.provider === "volcark") return volcarkCost(input.modelId, input.resolution);
  if (input.provider === "beeftv") return beeftvCost(input.modelId, input.resolution, input.aspectRatio ?? "auto", refs);
  throw new CliError(`no seedream price for provider ${input.provider}`);
}

function volcarkCost(modelId: string, resolution: string): SeedreamCost {
  if (modelId === SEEDREAM_FLASH_MODEL) {
    return {
      yuan: SEEDREAM_FLASH_YUAN,
      text: `estimate: ${money(SEEDREAM_FLASH_YUAN)} yuan (${modelId}, 1 image)`,
    };
  }
  if (modelId !== SEEDREAM_PRO_MODEL) throw new CliError(`no seedream price for ${modelId}`);
  const twoK = resolution === "2K";
  const yuan = twoK ? SEEDREAM_PRO_YUAN_2K : SEEDREAM_PRO_YUAN_LE_1_5K;
  const band = twoK ? "2K" : "≤1.5K";
  return {
    yuan,
    text: `estimate: ${money(yuan)} yuan (${modelId} ${band}, 1 image)`,
  };
}

function beeftvCost(modelId: string, resolution: string, aspectRatio: string, refs: number): SeedreamCost {
  if (modelId === SEEDREAM_FLASH_MODEL) {
    const refText = refs > 0 ? `, ${refs} refs free` : "";
    return {
      yuan: BEEFTV_FLASH_YUAN,
      text: `estimate: ${money(BEEFTV_FLASH_YUAN)} yuan (${modelId} beeftv, 1 image${refText})`,
    };
  }
  if (modelId !== SEEDREAM_PRO_MODEL) throw new CliError(`no seedream price for ${modelId}`);
  const large = beefProLarge(resolution, aspectRatio);
  const yuan = large ? BEEFTV_PRO_YUAN_GT : BEEFTV_PRO_YUAN_LE;
  const band = large ? ">2.61M px" : "≤2.61M px";
  const extra = Math.max(0, refs - 1);
  const refText = refs === 0
    ? ""
    : extra === 0
      ? ", 1 ref free"
      : ` + <0.01 yuan x ${extra} refs, ${refs} refs, first free`;
  return {
    yuan,
    text: `estimate: ${money(yuan)} yuan (${modelId} beeftv ${band}, 1 image${refText})`,
  };
}
