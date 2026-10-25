import type { ModelBinding } from "../config.js";
import type { MediaRef, VideoRequest } from "../catalog.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import { fetchOf, joinUrl, perform, publicResult, TransportError, type HttpCall } from "../http.js";
import type { IO } from "../io.js";
import { redactValue } from "../redact.js";
import type { OutputFile } from "../runs.js";
import { awaitHaomaoTask } from "./jobs.js";
import { assertHttps, jsonCall, wireModel } from "./wire.js";

function sources(refs: MediaRef[], kind: MediaRef["kind"]): string[] {
  return refs.filter((ref) => ref.kind === kind).map((ref) => ref.source);
}

function checkRemote(request: VideoRequest, provider: string): void {
  const urls = [
    request.firstFrame?.source,
    request.lastFrame?.source,
    ...request.references.map((ref) => ref.source),
  ].filter((item): item is string => item !== undefined);
  for (const url of urls) assertHttps(url, provider, "seedance");
}

function contentItem(type: "image_url" | "video_url" | "audio_url", url: string, role: string): Record<string, unknown> {
  return { type, [type]: { url }, role };
}

export function planVideo(request: VideoRequest, binding: ModelBinding): HttpCall[] {
  if (binding.provider !== "haomao") {
    throw new CliError(`provider ${binding.provider} has no seedance client`);
  }
  if (request.webSearch) throw new CliError("haomao seedance does not accept web-search");
  const model = wireModel(request.modelId, binding.modelAlias);
  const content = [
    { type: "text", text: request.prompt },
    ...(request.firstFrame ? [contentItem("image_url", request.firstFrame.source, "first_frame")] : []),
    ...(request.lastFrame ? [contentItem("image_url", request.lastFrame.source, "last_frame")] : []),
    ...sources(request.references, "image").map((url) => contentItem("image_url", url, "reference_image")),
    ...sources(request.references, "video").map((url) => contentItem("video_url", url, "reference_video")),
    ...sources(request.references, "audio").map((url) => contentItem("audio_url", url, "reference_audio")),
  ];
  const body: Record<string, unknown> = {
    model,
    content,
    resolution: request.resolution,
    ratio: request.aspectRatio,
    duration: request.duration,
    generate_audio: request.generateAudio,
    ...(request.omniReferenceTaskType === undefined
      ? {}
      : { omni_reference_task_type: request.omniReferenceTaskType }),
  };
  const submit = jsonCall("POST", joinUrl(binding.baseUrl, "/contents/generations/tasks"), {}, body);
  return [
    submit,
    {
      method: "GET",
      url: joinUrl(binding.baseUrl, "/contents/generations/tasks/{{task_id}}"),
      headers: {},
      body: { kind: "empty" },
    },
    { method: "GET", url: "https://cdn.invalid/{{video_url}}", headers: {}, body: { kind: "empty" } },
  ];
}

export async function runVideo(
  request: VideoRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  videoFile: string,
  receipt: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  if (mode === "execute") checkRemote(request, binding.provider);
  const planned = planVideo(request, binding);
  if (mode === "dry-run") return { calls: planned, response: null, files: [] };
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const calls: HttpCall[] = [];
  const first = planned[0];
  if (first === undefined) throw new CliError("video request has no call");
  const submitted = await perform(calls, first, opts);
  const finished = await awaitHaomaoTask(calls, binding.baseUrl, {}, submitted, opts, io);
  const published = publicResult(finished.task);
  const response = redactValue(
    finished.videoUrl === undefined || published === null || typeof published !== "object" || Array.isArray(published)
      ? published
      : { ...published, videoUrl: finished.videoUrl },
    [],
  );
  const files: OutputFile[] = [];
  if (mode === "execute") {
    if (finished.videoUrl === undefined || !/^https?:\/\//i.test(finished.videoUrl)) {
      throw new TransportError("seedance result has no video url", calls, response);
    }
    const downloaded = await perform(
      calls,
      { method: "GET", url: finished.videoUrl, headers: {}, body: { kind: "empty" } },
      { ...opts, auth: false },
    );
    files.push({ path: videoFile, bytes: downloaded.body });
    files.push({ path: receipt, text: `${JSON.stringify(response, null, 2)}\n` });
  }
  return { calls, response, files };
}
