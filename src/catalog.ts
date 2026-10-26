import { CliError } from "./errors.js";

export const IMAGE_MODELS = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export const SEEDANCE_MODELS = ["seedance-2", "seedance-2-fast", "seedance-2-mini", "seedance-2.5"] as const;
export const FISH_MODELS = ["voice-clone", "voice-design-1", "voice-synthesis"] as const;
export const MEDIAKIT_MODELS = ["video-understand-router", "enhance-video-generative"] as const;

export const IMAGE_ASPECTS = [
  "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16",
  "2:1", "1:2", "3:1", "1:3", "21:9", "9:21", "5:4", "4:5",
] as const;
export const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
export const IMAGE_QUALITIES_2 = ["auto", "low", "medium", "high"] as const;
export const IMAGE_QUALITIES_25 = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const IMAGE_QUALITIES = IMAGE_QUALITIES_25;

export const SEEDANCE_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"] as const;
export const VIDEO_SHAPES = ["text", "frame", "reference"] as const;
/** Official Seedance 2.5 omni-reference subtasks. `auto` is the default when `--task-type` is omitted. */
export const OMNI_TASK_TYPES = ["auto", "reference", "edit", "extend"] as const;

export const PROVIDERS = ["yunqiao", "grsai", "haomao", "kitta", "mediakit", "beeftv"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/**
 * Official API base each built-in provider uses when a binding sets no baseUrl.
 * A user-set baseUrl (config or `providers set --base-url`) always wins.
 */
export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  yunqiao: "https://api.yunqiao.me/v1",
  grsai: "https://grsaiapi.com",
  haomao: "https://haomaotoken.com/api/v3",
  kitta: "https://fishaudio.org",
  mediakit: "https://mediakit.cn-beijing.volces.com",
  beeftv: "https://enterprise.beefapi.com",
};

/**
 * Pixel tiers a provider will accept. The model map still computes every tier;
 * a provider that cannot take one fails here, not by changing the model id.
 */
export const IMAGE_PROVIDER_RESOLUTIONS: Partial<Record<ProviderId, readonly (typeof IMAGE_RESOLUTIONS)[number][]>> = {
  yunqiao: ["1K", "2K"],
  grsai: ["1K", "2K", "4K"],
};

export const BREAKDOWN_PROMPT_PLACEHOLDER =
  "[lumen] breakdown prompt is deferred; set breakdown.prompt, breakdown.promptFile, or --prompt-file";

/** Sent when breakdown is run without --prompt, --prompt-file, or a configured prompt. */
export const BREAKDOWN_DEFAULT_PROMPT = `请对这个视频做逐镜头拉片分析，不要生成任何创作/生成用提示词。
按镜头输出表格，字段：
镜头序号｜起止时间码｜时长(秒)｜概述｜叙事作用｜景别｜画面元素｜镜头运动｜转场/剪辑｜字幕/台词｜声音/音乐｜情绪/节奏｜视觉风格｜备注/置信度
口径：
- 概述：只写画面事实和主要动作，不写长篇评论。
- 叙事作用：说明该镜头在注意力、信息推进、情绪、信任、卖点展示、转场中的作用。
- 景别：远景/全景/中景/中近景/近景/特写/大特写/屏幕录制/混合 选一。
- 镜头运动：固定、推近、拉远、横移、跟拍、环绕、摇镜、快速切换、屏幕滚动等。
- 转场/剪辑：硬切、跳切、闪白、叠化、缩放转场、字幕承接、动作承接、音频承接。
- 声音/音乐：口播、BGM、环境音、音效、停顿、重音；听不清标“未识别”。
短视频逐镜头完整分析。`;

/** Sent as prefer_models for scene=editing when breakdown.preferModels is unset. */
export const BREAKDOWN_PREFER_MODELS = ["doubao-seed-2-1-lite-260915"] as const;
/** Highest MediaKit understand level. Used when breakdown.level is unset. */
export const BREAKDOWN_LEVEL = "Quality";
/** Sent as manual_option.need_audio when breakdown.needAudio is unset. */
export const BREAKDOWN_NEED_AUDIO = true;

export type ImageModel = (typeof IMAGE_MODELS)[number];
export type SeedanceModel = (typeof SEEDANCE_MODELS)[number];
export type FishModel = (typeof FISH_MODELS)[number];
export type MediakitModel = (typeof MEDIAKIT_MODELS)[number];
export type ModelId = ImageModel | SeedanceModel | FishModel | MediakitModel;
export type VideoShape = (typeof VIDEO_SHAPES)[number];
export type OmniTaskType = (typeof OMNI_TASK_TYPES)[number];

export interface ModelInfo {
  id: ModelId;
  kind: "image" | "video" | "voice" | "mediakit";
  summary: string;
  providers: readonly ProviderId[];
}

export const MODELS: readonly ModelInfo[] = [
  ...IMAGE_MODELS.map((id) => ({
    id,
    kind: "image" as const,
    summary: "GPT Image generate, or edit when reference images are attached",
    providers: ["yunqiao", "grsai"] as const,
  })),
  ...SEEDANCE_MODELS.map((id) => ({
    id,
    kind: "video" as const,
    summary: "Seedance TextVideo, FrameVideo, and ReferenceVideo",
    providers: (id === "seedance-2-fast" ? ["haomao", "beeftv"] : ["haomao"]) as readonly ProviderId[],
  })),
  {
    id: "voice-design-1",
    kind: "voice",
    summary: "Kitta VoiceDesign: a voice from a natural-language description",
    providers: ["kitta"],
  },
  {
    id: "voice-clone",
    kind: "voice",
    summary: "Kitta VoiceClone: speak text in a reference voice",
    providers: ["kitta"],
  },
  {
    id: "voice-synthesis",
    kind: "voice",
    summary: "Kitta VoiceSynthesis: speak text with an existing voice id",
    providers: ["kitta"],
  },
  {
    id: "video-understand-router",
    kind: "mediakit",
    summary: "MediaKit video-understand-router, scene=editing, level=Quality, need_audio, prefer_models doubao-seed-2-1-lite-260915",
    providers: ["mediakit"],
  },
  {
    id: "enhance-video-generative",
    kind: "mediakit",
    summary: "MediaKit enhance-video-generative",
    providers: ["mediakit"],
  },
];

const byId = new Map(MODELS.map((model) => [model.id, model]));

const MODEL_ALIASES: Record<string, ModelId> = {
  standard: "seedance-2",
  fast: "seedance-2-fast",
  mini: "seedance-2-mini",
  "2.5": "seedance-2.5",
};

/** Aliases `standard`, `fast`, `mini`, and `2.5` map to lumen model ids. */
export function canonicalModel(id: string): string {
  return MODEL_ALIASES[id] ?? MODEL_ALIASES[id.toLowerCase()] ?? id;
}

export function normalizeShape(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toLowerCase().replace(/_/g, "-");
  const shapes: Record<string, VideoShape> = {
    text: "text",
    "text-video": "text",
    textvideo: "text",
    frame: "frame",
    "frame-video": "frame",
    framevideo: "frame",
    reference: "reference",
    "reference-video": "reference",
    referencevideo: "reference",
  };
  return shapes[key] ?? value;
}

export function modelInfo(id: string): ModelInfo | undefined {
  return byId.get(canonicalModel(id) as ModelId);
}

export function providersFor(id: string): readonly ProviderId[] {
  return modelInfo(id)?.providers ?? [];
}

export function assertProviderServes(provider: string, modelId: string): void {
  const info = modelInfo(modelId);
  if (info === undefined) throw new CliError(`unknown model ${modelId}`);
  if (!(info.providers as readonly string[]).includes(provider)) {
    throw new CliError(
      `provider ${provider} cannot serve ${modelId}. This model accepts: ${info.providers.join(", ")}`,
    );
  }
}

export interface ImageRequest {
  modelId: ImageModel;
  prompt: string;
  aspectRatio: (typeof IMAGE_ASPECTS)[number];
  resolution: (typeof IMAGE_RESOLUTIONS)[number];
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  /** Always set. `gpt-image-2` defaults to `high`; both 2.5 models default to `max`. */
  quality: (typeof IMAGE_QUALITIES_2)[number] | (typeof IMAGE_QUALITIES_25)[number];
  references: string[];
}

export interface MediaRef {
  kind: "image" | "video" | "audio";
  source: string;
  personReference?: boolean;
}

export interface VideoRequest {
  modelId: SeedanceModel;
  shape: VideoShape;
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  generateAudio: boolean;
  webSearch: boolean;
  firstFrame?: MediaRef;
  lastFrame?: MediaRef;
  references: MediaRef[];
  /** Set only for seedance-2.5 reference. Omitted flag resolves to `auto`. */
  omniReferenceTaskType?: OmniTaskType;
  /** True when the user passed `--task-type`, including an explicit `auto`. */
  omniTaskTypeSpecified?: boolean;
}

export interface FishRequest {
  modelId: FishModel;
  operation: "design" | "clone" | "synth";
  instruction?: string;
  text?: string;
  voice?: string;
  title?: string;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new CliError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function validateImage(input: {
  modelId: string;
  prompt: string;
  aspectRatio: string | undefined;
  resolution: string | undefined;
  background: string | undefined;
  quality: string | undefined;
  references: string[];
}): ImageRequest {
  if (!(IMAGE_MODELS as readonly string[]).includes(input.modelId)) {
    throw new CliError(`unknown image model ${input.modelId}`);
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new CliError("image prompt is empty");
  if (prompt.length > 20_000) throw new CliError("prompt is longer than 20000 characters");
  const aspectRatio = oneOf(input.aspectRatio, IMAGE_ASPECTS, "aspect-ratio");
  const resolution = oneOf(input.resolution, IMAGE_RESOLUTIONS, "resolution");
  const background = input.background === undefined ? undefined : oneOf(input.background, IMAGE_BACKGROUNDS, "background");
  const classic = input.modelId === "gpt-image-2";
  const quality = input.quality === undefined
    ? (classic ? "high" : "max")
    : oneOf(input.quality, classic ? IMAGE_QUALITIES_2 : IMAGE_QUALITIES_25, "quality");
  if (input.references.length > 16) throw new CliError("image references are limited to 16");
  return {
    modelId: input.modelId as ImageModel,
    prompt,
    aspectRatio,
    resolution,
    ...(background === undefined ? {} : { background }),
    quality,
    references: input.references,
  };
}

export function assertImageProviderRules(request: ImageRequest, provider: string): void {
  const allowed = IMAGE_PROVIDER_RESOLUTIONS[provider as ProviderId];
  if (allowed !== undefined && !allowed.includes(request.resolution)) {
    throw new CliError(`provider ${provider} does not support resolution ${request.resolution}. It accepts: ${allowed.join(", ")}`);
  }
}

function resolutionAllowed(model: SeedanceModel, resolution: string): boolean {
  if (model === "seedance-2") return ["480p", "720p", "1080p", "4k"].includes(resolution);
  if (model === "seedance-2.5") return ["480p", "720p", "1080p"].includes(resolution);
  return ["480p", "720p"].includes(resolution);
}

export function parseMediaRef(raw: string): MediaRef {
  const [kind, source, person, extra] = raw.split("|");
  if (extra !== undefined || (kind !== "image" && kind !== "video" && kind !== "audio") || source === undefined || source.length === 0) {
    throw new CliError("--ref must look like image|path|true, video|path|false, or audio|path");
  }
  if (kind === "audio") {
    if (person !== undefined) throw new CliError("audio references omit person-reference");
    if (/\.m4a$/i.test(source) || /\.mp4$/i.test(source)) {
      throw new CliError("Seedance reference audio does not accept m4a; use wav or mp3");
    }
    return { kind, source };
  }
  if (person !== "true" && person !== "false") {
    throw new CliError(`${kind} references need person-reference true or false`);
  }
  return { kind, source, personReference: person === "true" };
}

export function validateVideo(input: {
  modelId: string;
  shape: string | undefined;
  prompt: string;
  duration: string | undefined;
  resolution: string | undefined;
  aspectRatio: string | undefined;
  generateAudio: boolean;
  webSearch: boolean;
  firstFrame: string | undefined;
  firstPerson: string | undefined;
  lastFrame: string | undefined;
  lastPerson: string | undefined;
  references: MediaRef[];
  taskType: string | undefined;
}): VideoRequest {
  if (!(SEEDANCE_MODELS as readonly string[]).includes(input.modelId)) {
    throw new CliError(`unknown video model ${input.modelId}`);
  }
  const modelId = input.modelId as SeedanceModel;
  const shape = oneOf(normalizeShape(input.shape), VIDEO_SHAPES, "shape");
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new CliError("video prompt is empty");
  const promptMax = modelId === "seedance-2.5" ? 30_000 : 20_000;
  if (prompt.length > promptMax) throw new CliError(`prompt is longer than ${promptMax} characters`);
  if (input.duration === undefined) throw new CliError("duration is required");
  if (!/^-?\d+$/.test(input.duration)) throw new CliError("duration must be a whole number of seconds");
  const duration = Number(input.duration);
  if (modelId === "seedance-2.5") {
    if (!(duration === -1 || (duration >= 4 && duration <= 30))) {
      throw new CliError("seedance-2.5 duration is -1 or a whole number from 4 to 30");
    }
  } else if (duration < 4 || duration > 15) {
    throw new CliError(`${modelId} duration is a whole number from 4 to 15`);
  }
  const resolution = input.resolution ?? "720p";
  if (!resolutionAllowed(modelId, resolution)) throw new CliError(`${modelId} does not offer resolution ${resolution}`);
  const aspectRatio = input.aspectRatio ?? "9:16";
  if (!(SEEDANCE_ASPECTS as readonly string[]).includes(aspectRatio)) {
    throw new CliError(`aspect-ratio must be one of ${SEEDANCE_ASPECTS.join(", ")}`);
  }
  if (shape !== "text" && input.webSearch) throw new CliError("web-search is only available on shape text");

  const frame = (source: string | undefined, person: string | undefined, label: string): MediaRef | undefined => {
    if (source === undefined) return undefined;
    if (person !== "true" && person !== "false") throw new CliError(`${label} needs person-reference true or false`);
    return { kind: "image", source, personReference: person === "true" };
  };
  const firstFrame = frame(input.firstFrame, input.firstPerson, "first-frame");
  const lastFrame = frame(input.lastFrame, input.lastPerson, "last-frame");
  if (lastFrame && !firstFrame) throw new CliError("last-frame requires first-frame");

  if (shape === "text" && (firstFrame || lastFrame || input.references.length > 0)) {
    throw new CliError("shape text accepts a prompt only");
  }
  if (shape === "frame") {
    if (!firstFrame) throw new CliError("shape frame needs --first-frame");
    if (input.references.length > 0) throw new CliError("shape frame does not take --ref");
  }
  if (shape === "reference") {
    if (firstFrame || lastFrame) throw new CliError("shape reference does not take first-frame or last-frame");
    if (input.references.length === 0) throw new CliError("shape reference needs at least one --ref");
  }

  const images = input.references.filter((ref) => ref.kind === "image").length;
  const videos = input.references.filter((ref) => ref.kind === "video").length;
  const audios = input.references.filter((ref) => ref.kind === "audio").length;
  const is25 = modelId === "seedance-2.5";
  if (images > (is25 ? 30 : 9)) throw new CliError(`${modelId} allows at most ${is25 ? 30 : 9} reference images`);
  if (videos > (is25 ? 10 : 3)) throw new CliError(`${modelId} allows at most ${is25 ? 10 : 3} reference videos`);
  if (audios > (is25 ? 10 : 3)) throw new CliError(`${modelId} allows at most ${is25 ? 10 : 3} reference audios`);
  if (!is25 && audios > 0 && images + videos === 0) {
    throw new CliError("reference audio needs an image or video reference");
  }
  if (!is25 && images + videos + audios > 12) throw new CliError(`${modelId} allows at most 12 references in total`);

  const omni = omniTask(modelId, shape, input.taskType, videos, aspectRatio, duration);

  return {
    modelId,
    shape,
    prompt,
    duration,
    resolution,
    aspectRatio,
    generateAudio: input.generateAudio,
    webSearch: shape === "text" ? input.webSearch : false,
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
    references: shape === "reference" ? input.references : [],
    ...omni,
  };
}

function omniTask(
  modelId: SeedanceModel,
  shape: VideoShape,
  taskType: string | undefined,
  videos: number,
  aspectRatio: string,
  duration: number,
): { omniReferenceTaskType: OmniTaskType; omniTaskTypeSpecified: boolean } | Record<string, never> {
  const raw = taskType?.trim().toLowerCase();
  const specified = raw !== undefined && raw.length > 0;
  if (!specified && !(modelId === "seedance-2.5" && shape === "reference")) return {};
  if (specified && !(OMNI_TASK_TYPES as readonly string[]).includes(raw)) {
    throw new CliError(`task-type must be one of ${OMNI_TASK_TYPES.join(", ")}`);
  }
  if (modelId !== "seedance-2.5" || shape !== "reference") {
    throw new CliError("task-type belongs to seedance-2.5 shape reference; text and frame stay those shapes");
  }
  const omniReferenceTaskType = (specified ? raw : "auto") as OmniTaskType;
  if (omniReferenceTaskType === "edit" || omniReferenceTaskType === "extend") {
    if (videos < 1) {
      throw new CliError(`task-type ${omniReferenceTaskType} needs at least one video reference`);
    }
    if (aspectRatio !== "adaptive") {
      throw new CliError(`task-type ${omniReferenceTaskType} requires aspect-ratio adaptive`);
    }
  }
  if (omniReferenceTaskType === "edit" && duration !== -1) {
    throw new CliError("task-type edit requires duration -1");
  }
  return { omniReferenceTaskType, omniTaskTypeSpecified: specified };
}

export function assertVideoProviderRules(request: VideoRequest, provider: string): void {
  if (provider === "haomao" && request.webSearch) {
    throw new CliError("haomao seedance does not accept web-search");
  }
  if (provider === "haomao" && request.modelId === "seedance-2.5" && request.shape === "frame" && request.aspectRatio !== "adaptive") {
    throw new CliError("haomao seedance-2.5 frame mode takes only aspect-ratio adaptive");
  }
}

export function validateFish(input: {
  modelId: string;
  instruction: string | undefined;
  text: string | undefined;
  voice: string | undefined;
  title: string | undefined;
}): FishRequest {
  if (!(FISH_MODELS as readonly string[]).includes(input.modelId)) {
    throw new CliError(`unknown voice model ${input.modelId}`);
  }
  const modelId = input.modelId as FishModel;
  const text = input.text?.trim();
  const instruction = input.instruction?.trim();
  if (modelId === "voice-design-1") {
    if (instruction === undefined || instruction.length === 0) throw new CliError("voice-design-1 needs --instruction");
    if (instruction.length > 2000) throw new CliError("instruction is longer than 2000 characters");
    if (text !== undefined && text.length > 150) throw new CliError("voice-design reference text is longer than 150 characters");
    return {
      modelId,
      operation: "design",
      instruction,
      ...(text === undefined || text.length === 0 ? {} : { text }),
      ...(input.title === undefined ? {} : { title: input.title }),
    };
  }
  if (text === undefined || text.length === 0) throw new CliError(`${modelId} needs --text`);
  if (input.voice === undefined || input.voice.length === 0) throw new CliError(`${modelId} needs --voice`);
  return {
    modelId,
    operation: modelId === "voice-clone" ? "clone" : "synth",
    text,
    voice: input.voice,
    ...(input.title === undefined ? {} : { title: input.title }),
  };
}

export function isDeferredPrompt(prompt: string): boolean {
  return prompt.trim().length === 0 || prompt === BREAKDOWN_PROMPT_PLACEHOLDER;
}
