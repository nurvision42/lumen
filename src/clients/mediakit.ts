import { BREAKDOWN_LEVEL, BREAKDOWN_NEED_AUDIO, BREAKDOWN_PREFER_MODELS } from "../catalog.js";
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

export interface EnhanceOptions {
  toolVersion?: string;
  scene?: string;
  resolution?: string;
  enhanceStyle?: string;
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
  tool: "video-understand-router" | "enhance-video-generative",
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
  return {
    video_url: video,
    client_token: runId,
    ...queue,
    ...(enhance?.toolVersion === undefined ? {} : { tool_version: enhance.toolVersion }),
    ...(enhance?.scene === undefined ? {} : { scene: enhance.scene }),
    ...(enhance?.resolution === undefined ? {} : { resolution: enhance.resolution }),
    ...(enhance?.enhanceStyle === undefined ? {} : { enhance_style: enhance.enhanceStyle }),
  };
}

export function planMediakit(
  tool: "video-understand-router" | "enhance-video-generative",
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
  const upload: HttpCall = {
    method: "POST",
    url: joinUrl(binding.baseUrl, "/api/v1/tools-sync/request-media-upload-url"),
    headers: {},
    body: { kind: "empty" },
  };
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
  tool: "video-understand-router" | "enhance-video-generative",
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
