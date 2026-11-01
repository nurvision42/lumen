import { SEEDREAM_FLASH_MODEL, SEEDREAM_PRO_MODEL } from "../catalog.js";
import { CliError } from "../errors.js";

/**
 * Volcengine Ark Seedream 5.0 list prices, yuan per generated image.
 * Pro: ≤1.5K (1K and 1.5K are the same price) 0.30, 2K 0.60.
 * Flash: 0.12 at every size.
 * Official note: 1.5K matches 1K on price and looks better.
 */
export const SEEDREAM_PRO_YUAN_LE_1_5K = 0.3;
export const SEEDREAM_PRO_YUAN_2K = 0.6;
export const SEEDREAM_FLASH_YUAN = 0.12;

export interface SeedreamCost {
  readonly yuan: number;
  readonly text: string;
}

/** One image. Printed before the request is sent, including dry-run. */
export function seedreamCost(modelId: string, resolution: string): SeedreamCost {
  if (modelId === SEEDREAM_FLASH_MODEL) {
    return {
      yuan: SEEDREAM_FLASH_YUAN,
      text: `estimate: ${SEEDREAM_FLASH_YUAN.toFixed(2)} yuan (${modelId}, 1 image)`,
    };
  }
  if (modelId !== SEEDREAM_PRO_MODEL) throw new CliError(`no seedream price for ${modelId}`);
  const twoK = resolution === "2K";
  const yuan = twoK ? SEEDREAM_PRO_YUAN_2K : SEEDREAM_PRO_YUAN_LE_1_5K;
  const band = twoK ? "2K" : "≤1.5K";
  return {
    yuan,
    text: `estimate: ${yuan.toFixed(2)} yuan (${modelId} ${band}, 1 image)`,
  };
}
