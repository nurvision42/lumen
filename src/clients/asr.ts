import type { ModelBinding } from "../config.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import {
  fetchOf,
  joinUrl,
  perform,
  publicResult,
  TransportError,
  type HttpCall,
  type SendOptions,
} from "../http.js";
import type { IO } from "../io.js";
import { contentTypeFor, isRemoteMedia } from "../media.js";
import { findString } from "../walk.js";
import { mediaUri, pollMediakitTask, taskState, uploadHeaders } from "./mediakit.js";
import { jsonCall } from "./wire.js";

/** Languages the asr-subtitles tool accepts. Omitted means the service detects one. */
export const ASR_LANGUAGES = ["cmn-Hans-CN", "eng-US", "spa-ES", "ind-ID"] as const;
export type AsrLanguage = (typeof ASR_LANGUAGES)[number];

export interface AsrOptions {
  language?: AsrLanguage;
  speaker: boolean;
}

export function assertAsrLanguage(value: string | undefined): AsrLanguage | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const language = value.trim();
  if (!(ASR_LANGUAGES as readonly string[]).includes(language)) {
    throw new CliError(`language must be one of ${ASR_LANGUAGES.join(", ")}`, 2);
  }
  return language as AsrLanguage;
}

export function asrBody(
  videoUrl: string,
  runId: string,
  group: string | undefined,
  options: AsrOptions,
): Record<string, unknown> {
  return {
    video_url: videoUrl,
    client_token: runId,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.speaker ? { enable_speaker_info: true } : {}),
    ...(group === undefined ? {} : { queue_id: group }),
  };
}

/** Planned calls match the other MediaKit tools: upload, PUT, submit, poll. */
export function planAsr(binding: ModelBinding, video: string, runId: string, options: AsrOptions): HttpCall[] {
  const remote = isRemoteMedia(video);
  const videoUrl = remote ? video : "mediakit://{{file_id}}";
  const submit = jsonCall(
    "POST",
    joinUrl(binding.baseUrl, "/api/v1/tools/asr-subtitles"),
    {},
    asrBody(videoUrl, runId, binding.group, options),
  );
  const poll: HttpCall = {
    method: "GET",
    url: joinUrl(binding.baseUrl, "/api/v1/tasks/{{task_id}}"),
    headers: {},
    body: { kind: "empty" },
  };
  if (remote) return [submit, poll];
  const upload = jsonCall("POST", joinUrl(binding.baseUrl, "/api/v1/tools-sync/request-media-upload-url"), {}, {});
  const put: HttpCall = {
    method: "PUT",
    url: "https://upload.invalid/{{upload_url}}",
    headers: { "Content-Type": contentTypeFor(video) },
    body: { kind: "file", path: video, contentType: contentTypeFor(video) },
  };
  return [upload, put, submit, poll];
}

export async function runAsr(
  binding: ModelBinding,
  video: string,
  runId: string,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  options: AsrOptions,
): Promise<{ calls: HttpCall[]; response: unknown; task?: unknown }> {
  const planned = planAsr(binding, video, runId, options);
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
    joinUrl(binding.baseUrl, "/api/v1/tools/asr-subtitles"),
    {},
    asrBody(videoUrl, runId, binding.group, options),
  );
  let last = await perform(calls, submit, opts);
  if (taskState(last.json) === "fail") throw new TransportError("MediaKit task failed", calls, publicResult(last));
  if (taskState(last.json) !== "ok") {
    const taskId = findString(last.json, "task_id");
    if (taskId === undefined) throw new TransportError("MediaKit response has no task_id", calls, publicResult(last));
    last = await pollMediakitTask(calls, binding.baseUrl, taskId, opts, io);
  }
  return { calls, response: publicResult(last), task: last.json };
}
