import { CliError } from "../errors.js";

/**
 * YCY API prices captured 2026-11-01 from https://ycyapi.cn/api/pricing
 * (the same rows are listed on https://ycyapi.cn/pricing).
 *
 * `seedance2.5-A` is `billing_mode: per_second_resolution`, currency CNY, for
 * group `22-SD-2.5视频`. The published yuan/second figures are already that
 * group's price (group ratio 0.1). Bill output seconds only. Reference video
 * seconds are not added, and the gateway `model_price` of 10 is not a rate.
 *
 * Other `quota_type: 1` rows are one call: yuan = model_price × group_ratio,
 * and only for a group in that model's `enable_groups`.
 */
export const YCYAPI_PRICE_SOURCE = "https://ycyapi.cn/api/pricing";
export const YCYAPI_PRICE_PAGE = "https://ycyapi.cn/pricing";
export const YCYAPI_PRICE_CAPTURED = "2026-11-01";

/** `group_ratio` from the same payload. Product with `model_price` is CNY per call. */
export const YCYAPI_GROUP_RATIO: Readonly<Record<string, number>> = {
  "09-GPT-不定时拉闸": 0.06,
  "09-PLUS-限时特价": 0.08,
  "10-GPT-PRO-备用分组": 0.18,
  "10-GPT-PRO-性价比": 0.14,
  "11-GPT 官转KEY": 0.4,
  "11-GPT-不降智": 0.25,
  "12-GPT-PLUS-优惠分组": 0.1,
  "14-Claude-KIRO-特价": 0.06,
  "16-Claude-MAX-满血": 1.2,
  "17-Claude-满血-特惠": 0.9,
  "18-GROK-4.6-HEAVY": 0.15,
  "18-Gemini ultra": 0.3,
  "18-Gemini-谷歌": 0.3,
  "19-GPT-FREE-图片": 0.1,
  "20-GPT-图片": 0.1,
  "20-GPT-特价生图": 0.025,
  "21-国模-": 0.08,
  "21-国模-deep seek": 0.1,
  "22-SD-2.0视频": 0.1,
  "22-SD-2.5视频": 0.1,
  "23-minimax-H3": 0.1,
};

export const YCYAPI_SEEDANCE_25A = "seedance2.5-A";
export const YCYAPI_SEEDANCE_25A_GROUP = "22-SD-2.5视频";
/** Final CNY per output second in `YCYAPI_SEEDANCE_25A_GROUP`. */
export const YCYAPI_YUAN_PER_OUTPUT_SECOND: Readonly<Record<string, number>> = {
  "480p": 0.36,
  "720p": 0.62,
  "1080p": 0.95,
};

export interface YcyapiRequestPrice {
  /** `call` is one video submission. `image` is one picture. */
  readonly kind: "call" | "image";
  /** New API `model_price`. CNY per call is this times the group's ratio. */
  readonly modelPrice: number;
  readonly groups: readonly string[];
}

/** Per-call models from the same capture. Key is the upstream model id. */
export const YCYAPI_PER_CALL: Readonly<Record<string, YcyapiRequestPrice>> = {
  "ya-sd25-30s": { kind: "call", modelPrice: 20, groups: ["22-SD-2.5视频"] },
  "seedance-2.5": { kind: "call", modelPrice: 3.2, groups: ["22-SD-2.5视频"] },
  "seedance2.5": { kind: "call", modelPrice: 4, groups: ["22-SD-2.5视频"] },
  "seedance2.0-B": { kind: "call", modelPrice: 31, groups: ["22-SD-2.0视频"] },
  "seedance2.0-933-V": { kind: "call", modelPrice: 2, groups: ["22-SD-2.0视频"] },
  "seedance-2.0:i2v": { kind: "call", modelPrice: 25.9998, groups: ["22-SD-2.0视频"] },
  "gpt-image-2.5-flare": { kind: "image", modelPrice: 0.4, groups: ["20-GPT-特价生图"] },
  "gpt-image-2.5-sunburst": { kind: "image", modelPrice: 0.4, groups: ["20-GPT-特价生图"] },
  "gpt-image-2.5": { kind: "image", modelPrice: 0.4, groups: ["20-GPT-特价生图"] },
  "gpt-image-4K": { kind: "image", modelPrice: 1.2, groups: ["20-GPT-特价生图"] },
  "gpt-image-2": { kind: "image", modelPrice: 0.4, groups: ["20-GPT-图片", "20-GPT-特价生图"] },
  "gpt-image-2-2K": { kind: "image", modelPrice: 0.5, groups: ["20-GPT-图片"] },
  "gpt-image-2-4K": { kind: "image", modelPrice: 0.8, groups: ["20-GPT-图片"] },
  "gpt-image2-1k": { kind: "image", modelPrice: 0.4, groups: ["19-GPT-FREE-图片"] },
  "gpt-image2-2k": { kind: "image", modelPrice: 0.7, groups: ["19-GPT-FREE-图片"] },
  "gpt-image2-4k": { kind: "image", modelPrice: 0.9, groups: ["19-GPT-FREE-图片"] },
};

export interface YcyapiCostInput {
  /** Upstream model id (`modelAlias`, or `seedance2.5-A` when unset). */
  wireModel: string;
  resolution?: string;
  /** Output seconds. Reference video length is not part of this. */
  seconds?: number;
  group?: string;
  /** Count of video references. Present so callers can pass it; it is not billed. */
  referenceVideos?: number;
  /** Length of reference video, in seconds. Not billed. */
  referenceVideoSeconds?: number;
}

export interface YcyapiCost {
  readonly yuan?: number;
  readonly text: string;
}

export function roundYuan(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function formatYuan(yuan: number): string {
  const rounded = roundYuan(yuan);
  const [whole, frac = ""] = rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "").split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

function assertIgnoredVideoRefs(input: YcyapiCostInput): void {
  const videos = input.referenceVideos ?? 0;
  if (!Number.isInteger(videos) || videos < 0) {
    throw new CliError("referenceVideos must be a non-negative integer");
  }
  const refSeconds = input.referenceVideoSeconds ?? 0;
  if (!Number.isFinite(refSeconds) || refSeconds < 0) {
    throw new CliError("reference video seconds must be a non-negative finite number");
  }
}

function chosenGroup(model: string, groups: readonly string[], group: string | undefined, modelPrice?: number): string {
  const named = group?.trim() || undefined;
  if (named === undefined) {
    if (groups.length === 1) return groups[0]!;
    const choices = groups
      .map((name) => {
        const ratio = YCYAPI_GROUP_RATIO[name];
        const yuan = modelPrice === undefined || ratio === undefined ? "?" : formatYuan(roundYuan(modelPrice * ratio));
        return `${name} ${yuan} yuan`;
      })
      .join("; ");
    throw new CliError(`ycyapi price for ${model} needs --group (${choices})`);
  }
  if (!groups.includes(named)) {
    throw new CliError(`ycyapi model ${model} is not priced in group ${named}. Published groups: ${groups.join(", ")}`);
  }
  if (YCYAPI_GROUP_RATIO[named] === undefined) {
    throw new CliError(`ycyapi has no group ratio for ${named}`);
  }
  return named;
}

function perSecond(input: YcyapiCostInput): YcyapiCost {
  const group = chosenGroup(YCYAPI_SEEDANCE_25A, [YCYAPI_SEEDANCE_25A_GROUP], input.group);
  const resolution = input.resolution ?? "";
  const rate = YCYAPI_YUAN_PER_OUTPUT_SECOND[resolution];
  if (rate === undefined) {
    throw new CliError(
      `ycyapi ${YCYAPI_SEEDANCE_25A} has no price for resolution ${resolution || "(omitted)"}. Priced: 480p, 720p, 1080p`,
    );
  }
  const seconds = input.seconds;
  if (seconds === undefined || !Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`ycyapi ${YCYAPI_SEEDANCE_25A} needs a positive whole number of output seconds`);
  }
  const yuan = roundYuan(rate * seconds);
  return {
    yuan,
    text: `estimate: ${formatYuan(yuan)} yuan (${YCYAPI_SEEDANCE_25A} ${resolution}, ${seconds} output s × ${formatYuan(rate)} yuan/s, group ${group})`,
  };
}

function perCall(model: string, row: YcyapiRequestPrice, group: string | undefined): YcyapiCost {
  const chosen = chosenGroup(model, row.groups, group, row.modelPrice);
  const ratio = YCYAPI_GROUP_RATIO[chosen];
  if (ratio === undefined) throw new CliError(`ycyapi has no group ratio for ${chosen}`);
  const yuan = roundYuan(row.modelPrice * ratio);
  const unit = row.kind === "image" ? "1 image" : "1 call";
  return {
    yuan,
    text: `estimate: ${formatYuan(yuan)} yuan (${model}, ${unit}, group ${chosen})`,
  };
}

/**
 * Estimate printed before a ycyapi submit, including dry-run.
 * Video references do not change the result: per-second models bill output
 * seconds only, and per-call models bill one call.
 */
export function ycyapiCost(input: YcyapiCostInput): YcyapiCost {
  assertIgnoredVideoRefs(input);
  if (input.wireModel === YCYAPI_SEEDANCE_25A) return perSecond(input);
  const row = YCYAPI_PER_CALL[input.wireModel];
  if (row === undefined) {
    return { text: `estimate: no published ycyapi price for ${input.wireModel}` };
  }
  return perCall(input.wireModel, row, input.group);
}
