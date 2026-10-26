import {
  BREAKDOWN_LEVEL,
  BREAKDOWN_NEED_AUDIO,
  BREAKDOWN_PREFER_MODELS,
  ENHANCE_BITRATE_LEVEL,
  ENHANCE_FPS,
  ENHANCE_GENERATIVE_RESOLUTION,
  ENHANCE_GENERATIVE_RESOLUTIONS,
  ENHANCE_RESOLUTION,
  ENHANCE_SCENE,
  ENHANCE_STYLE,
  ENHANCE_TOOL_VERSION,
  ENHANCE_VIDEO_RESOLUTIONS,
} from "../catalog.js";
import type { ModelBinding } from "../config.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import {
  fetchOf,
  joinUrl,
  pause,
  perform,
  publicResult,
  TransportError,
  type HttpCall,
  type HttpResult,
  type SendOptions,
} from "../http.js";
import type { IO } from "../io.js";
import { contentTypeFor, isRemoteMedia } from "../media.js";
import { findString } from "../walk.js";
import { jsonCall } from "./wire.js";

export type MediakitTool = "video-understand-router" | "enhance-video" | "enhance-video-generative";
export type EnhanceTool = "enhance-video" | "enhance-video-generative";

export interface EnhanceOptions {
  toolVersion?: string;
  scene?: string;
  resolution?: string;
  enhanceStyle?: string;
  fps?: number;
  bitrateLevel?: string;
}

export interface ResolvedEnhance {
  toolVersion?: string;
  scene?: string;
  resolution: string;
  enhanceStyle?: string;
  fps?: number;
  bitrateLevel?: string;
}

function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed;
}

export function enhanceResolutionChoices(tool: EnhanceTool): readonly string[] {
  return tool === "enhance-video-generative" ? ENHANCE_GENERATIVE_RESOLUTIONS : ENHANCE_VIDEO_RESOLUTIONS;
}

/** Rejects a tier the chosen product does not offer. Returns the lowercase wire value. */
export function assertEnhanceResolution(tool: EnhanceTool, toolVersion: string | undefined, resolution: string): string {
  const normalized = resolution.trim().toLowerCase();
  const allowed = enhanceResolutionChoices(tool);
  if (!(allowed as readonly string[]).includes(normalized)) {
    const who = tool === "enhance-video-generative" ? tool : `${tool} ${toolVersion ?? ENHANCE_TOOL_VERSION}`;
    throw new CliError(`${who} does not accept resolution ${resolution}. It accepts: ${allowed.join(", ")}`, 2);
  }
  return normalized;
}

/** Defaults are 标准版 on enhance-video. `scene` is only applied for tool_version standard unless the caller set one. */
export function resolveEnhance(input: EnhanceOptions | undefined, tool: EnhanceTool = "enhance-video"): ResolvedEnhance {
  if (tool === "enhance-video-generative") {
    if (filled(input?.toolVersion) !== undefined || filled(input?.scene) !== undefined || filled(input?.enhanceStyle) !== undefined) {
      throw new CliError("enhance-video-generative does not take --tool-version, --scene, or --enhance-style", 2);
    }
    const resolution = assertEnhanceResolution(tool, undefined, filled(input?.resolution) ?? ENHANCE_GENERATIVE_RESOLUTION);
    const bitrateLevel = filled(input?.bitrateLevel);
    return {
      resolution,
      ...(input?.fps === undefined ? {} : { fps: input.fps }),
      ...(bitrateLevel === undefined ? {} : { bitrateLevel }),
    };
  }
  const toolVersion = filled(input?.toolVersion) ?? ENHANCE_TOOL_VERSION;
  const explicitScene = filled(input?.scene);
  const scene = explicitScene ?? (toolVersion === ENHANCE_TOOL_VERSION ? ENHANCE_SCENE : undefined);
  const resolution = assertEnhanceResolution(tool, toolVersion, filled(input?.resolution) ?? ENHANCE_RESOLUTION);
  return {
    toolVersion,
    ...(scene === undefined ? {} : { scene }),
    resolution,
    enhanceStyle: filled(input?.enhanceStyle) ?? ENHANCE_STYLE,
    fps: input?.fps ?? ENHANCE_FPS,
    bitrateLevel: filled(input?.bitrateLevel) ?? ENHANCE_BITRATE_LEVEL,
  };
}

export interface UnderstandOptions {
  preferModels?: readonly string[];
  level?: string;
  needAudio?: boolean;
}

const SUCCESS = new Set(["completed", "succeeded", "success"]);
const FAILURE = new Set(["failed", "error", "canceled", "cancelled"]);

function pollLimits(env: NodeJS.ProcessEnv): { max: number; ms: number } {
  const max = Number(env.MEDIAKIT_MAX_POLLS ?? 90);
  const ms = Number(env.MEDIAKIT_POLL_MS ?? 2000);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 90,
    ms: Number.isFinite(ms) && ms >= 0 ? ms : 2000,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function taskState(value: unknown): "pending" | "ok" | "fail" {
  const record = asRecord(value);
  const status = typeof record?.status === "string" ? record.status.toLowerCase() : undefined;
  if (status !== undefined && FAILURE.has(status)) return "fail";
  if (status !== undefined && SUCCESS.has(status)) return "ok";
  if (record?.success === false) return "fail";
  return "pending";
}

export function mediaUri(fileId: string): string {
  if (/^(mediakit:|vod:|tos:|https?:)/i.test(fileId)) return fileId;
  return `mediakit://${fileId}`;
}

function uploadHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const raw = record?.upload_headers ?? asRecord(record?.result)?.upload_headers;
  if (!Array.isArray(raw)) return {};
  const headers: Record<string, string> = {};
  for (const item of raw) {
    const row = asRecord(item);
    if (row && typeof row.key === "string" && typeof row.value === "string") headers[row.key] = row.value;
  }
  return headers;
}

function toolBody(
  tool: MediakitTool,
  video: string,
  runId: string,
  group: string | undefined,
  prompt: string | undefined,
  enhance: EnhanceOptions | undefined,
  understand: UnderstandOptions | undefined,
): Record<string, unknown> {
  const queue = group === undefined ? {} : { queue_id: group };
  if (tool === "video-understand-router") {
    const listed = understand?.preferModels;
    const models = listed !== undefined && listed.length > 0 ? [...listed] : [...BREAKDOWN_PREFER_MODELS];
    const level = understand?.level?.trim() ? understand.level.trim() : BREAKDOWN_LEVEL;
    const needAudio = understand?.needAudio ?? BREAKDOWN_NEED_AUDIO;
    return {
      video_urls: [video],
      prompt,
      scene: "editing",
      level,
      prefer_models: models,
      manual_option: { need_audio: needAudio },
      client_token: runId,
      ...queue,
    };
  }
  const resolved = resolveEnhance(enhance, tool);
  if (tool === "enhance-video-generative") {
    return {
      video_url: video,
      client_token: runId,
      resolution: resolved.resolution,
      ...(resolved.fps === undefined ? {} : { fps: resolved.fps }),
      ...(resolved.bitrateLevel === undefined ? {} : { bitrate_level: resolved.bitrateLevel }),
      ...queue,
    };
  }
  return {
    video_url: video,
    client_token: runId,
    tool_version: resolved.toolVersion,
    ...(resolved.scene === undefined ? {} : { scene: resolved.scene }),
    resolution: resolved.resolution,
    fps: resolved.fps,
    bitrate_level: resolved.bitrateLevel,
    enhance_style: resolved.enhanceStyle,
    ...queue,
  };
}

export function planMediakit(
  tool: MediakitTool,
  binding: ModelBinding,
  video: string,
  runId: string,
  prompt: string | undefined,
  enhance: EnhanceOptions | undefined,
  understand?: UnderstandOptions,
): HttpCall[] {
  const remote = isRemoteMedia(video);
  const videoUrl = remote ? video : "mediakit://{{file_id}}";
  const submit = jsonCall(
    "POST",
    joinUrl(binding.baseUrl, `/api/v1/tools/${tool}`),
    {},
    toolBody(tool, videoUrl, runId, binding.group, prompt, enhance, understand),
  );
  const poll: HttpCall = {
    method: "GET",
    url: joinUrl(binding.baseUrl, "/api/v1/tasks/{{task_id}}"),
    headers: {},
    body: { kind: "empty" },
  };
  if (remote) return [submit, poll];
  // Docs list no body fields, but the example is `-d '{}'` with Content-Type application/json.
  // An omitted body is rejected: 400 invalid empty request body.
  const upload = jsonCall("POST", joinUrl(binding.baseUrl, "/api/v1/tools-sync/request-media-upload-url"), {}, {});
  const put: HttpCall = {
    method: "PUT",
    url: "https://upload.invalid/{{upload_url}}",
    headers: { "Content-Type": contentTypeFor(video) },
    body: { kind: "file", path: video, contentType: contentTypeFor(video) },
  };
  return [upload, put, submit, poll];
}

async function pollTask(
  calls: HttpCall[],
  base: string,
  taskId: string,
  opts: SendOptions,
  io: IO,
): Promise<HttpResult> {
  const limits = pollLimits(io.env);
  let last: HttpResult | undefined;
  for (let i = 0; i < limits.max; i++) {
    const call: HttpCall = {
      method: "GET",
      url: joinUrl(base, `/api/v1/tasks/${encodeURIComponent(taskId)}`),
      headers: {},
      body: { kind: "empty" },
    };
    last = await perform(calls, call, opts);
    const state = taskState(last.json);
    if (state === "ok") return last;
    if (state === "fail") throw new TransportError(`MediaKit task ${taskId} failed`, calls, publicResult(last));
    if (i < limits.max - 1) await pause(io, limits.ms);
  }
  throw new TransportError(`MediaKit task ${taskId} did not finish`, calls, last === undefined ? null : publicResult(last));
}

export async function runMediakit(
  tool: MediakitTool,
  binding: ModelBinding,
  video: string,
  runId: string,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  prompt: string | undefined,
  enhance: EnhanceOptions | undefined,
  understand?: UnderstandOptions,
): Promise<{ calls: HttpCall[]; response: unknown; task?: unknown; videoUrl?: string }> {
  const planned = planMediakit(tool, binding, video, runId, prompt, enhance, understand);
  if (mode === "dry-run") return { calls: planned, response: null };
  const opts: SendOptions = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const calls: HttpCall[] = [];
  let videoUrl = isRemoteMedia(video) ? video : "";

  if (!isRemoteMedia(video)) {
    const request = planned.find((call) => call.url.includes("request-media-upload-url"));
    if (request === undefined) throw new CliError("upload request is missing");
    const uploaded = await perform(calls, request, opts);
    const fileId = findString(uploaded.json, "file_id");
    const putUrl = findString(uploaded.json, "upload_url");
    if (fileId === undefined || putUrl === undefined) {
      throw new TransportError("MediaKit upload response has no file_id or upload_url", calls, publicResult(uploaded));
    }
    videoUrl = mediaUri(fileId);
    const headers = { "Content-Type": contentTypeFor(video), ...uploadHeaders(uploaded.json) };
    await perform(
      calls,
      { method: "PUT", url: putUrl, headers, body: { kind: "file", path: video, contentType: contentTypeFor(video) } },
      { ...opts, auth: false },
    );
  }

  const submit = jsonCall(
    "POST",
    joinUrl(binding.baseUrl, `/api/v1/tools/${tool}`),
    {},
    toolBody(tool, videoUrl, runId, binding.group, prompt, enhance, understand),
  );
  let last = await perform(calls, submit, opts);
  if (taskState(last.json) === "fail") throw new TransportError("MediaKit task failed", calls, publicResult(last));
  if (taskState(last.json) !== "ok") {
    const taskId = findString(last.json, "task_id");
    if (taskId === undefined) throw new TransportError("MediaKit response has no task_id", calls, publicResult(last));
    last = await pollTask(calls, binding.baseUrl, taskId, opts, io);
  }
  const videoUrlOut = findString(last.json, "video_url");
  return {
    calls,
    response: publicResult(last),
    task: last.json,
    ...(videoUrlOut === undefined ? {} : { videoUrl: videoUrlOut }),
  };
}
