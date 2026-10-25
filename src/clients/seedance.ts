import type { ModelBinding } from "../config.js";
import type { MediaRef, VideoRequest } from "../catalog.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import { fetchOf, joinUrl, perform, publicResult, TransportError, type HttpCall } from "../http.js";
import type { IO } from "../io.js";
import { redactValue } from "../redact.js";
import type { OutputFile } from "../runs.js";
import { awaitHaomaoTask } from "./jobs.js";
import { jsonCall } from "./wire.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentTypeFor } from "../media.js";

/** haomao lists seedance 2.0 models with the ".0" suffix (GET /v1/models). */
export const HAOMAO_SEEDANCE_MODELS: Record<string, string> = {
  "seedance-2": "seedance-2.0",
  "seedance-2-fast": "seedance-2.0-fast",
  "seedance-2-mini": "seedance-2.0-mini",
  "seedance-2.5": "seedance-2.5",
};

export function haomaoWireModel(modelId: string, alias: string | undefined): string {
  return alias ?? HAOMAO_SEEDANCE_MODELS[modelId] ?? modelId;
}

export const HAOMAO_UPLOAD_TIMEOUT_MS = 300_000;

export interface PlannedUpload {
  source: string;
  path: string;
  size: number;
  sha256: string;
}

function isLocal(source: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source);
}

function localSources(request: VideoRequest): string[] {
  const all = [request.firstFrame?.source, request.lastFrame?.source, ...request.references.map((ref) => ref.source)]
    .filter((item): item is string => item !== undefined);
  for (const source of all) {
    if (!isLocal(source) && !/^(https|asset):\/\//i.test(source)) {
      throw new CliError(`seedance media must be https://, asset:// or a local file: ${source}`);
    }
  }
  return [...new Set(all.filter(isLocal))];
}

export function uploadCall(baseUrl: string, model: string, file: string): HttpCall {
  return {
    method: "POST",
    url: joinUrl(baseUrl, "/files/uploads"),
    headers: {},
    body: {
      kind: "multipart",
      parts: [
        { name: "model", text: model },
        { name: "purpose", text: "user_data" },
        { name: "file", filePath: file, filename: path.basename(file), contentType: contentTypeFor(file) },
      ],
    },
  };
}

async function describe(source: string, cwd: string): Promise<PlannedUpload> {
  const file = path.resolve(cwd, source);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(`local media not found: ${file}`);
  }
  return { source, path: file, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function withSources(request: VideoRequest, map: Map<string, string>): VideoRequest {
  const swap = (ref: MediaRef): MediaRef => ({ ...ref, source: map.get(ref.source) ?? ref.source });
  const out: VideoRequest = { ...request, references: request.references.map(swap) };
  if (request.firstFrame) out.firstFrame = swap(request.firstFrame);
  if (request.lastFrame) out.lastFrame = swap(request.lastFrame);
  return out;
}

function sources(refs: MediaRef[], kind: MediaRef["kind"]): string[] {
  return refs.filter((ref) => ref.kind === kind).map((ref) => ref.source);
}

function contentItem(type: "image_url" | "video_url" | "audio_url", url: string, role: string): Record<string, unknown> {
  return { type, [type]: { url }, role };
}

export function planVideo(request: VideoRequest, binding: ModelBinding): HttpCall[] {
  if (binding.provider !== "haomao") {
    throw new CliError(`provider ${binding.provider} has no seedance client`);
  }
  if (request.webSearch) throw new CliError("haomao seedance does not accept web-search");
  const model = haomaoWireModel(request.modelId, binding.modelAlias);
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
  const locals = localSources(request);
  const described = await Promise.all(locals.map((source) => describe(source, io.cwd)));
  const uploads = described.filter((item, index) => described.findIndex((other) => other.path === item.path) === index);
  const model = haomaoWireModel(request.modelId, binding.modelAlias);
  const uploadCalls = uploads.map((item) => uploadCall(binding.baseUrl, model, item.path));
  if (mode === "dry-run") {
    const placeholders = new Map(described.map((item) => [item.source, `{{upload:${item.path}}}`]));
    return {
      calls: [...uploadCalls, ...planVideo(withSources(request, placeholders), binding)],
      response: { plannedUploads: uploads },
      files: [],
    };
  }
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const calls: HttpCall[] = [];
  const urls = new Map<string, string>();
  for (const [index, item] of uploads.entries()) {
    const call = uploadCalls[index];
    if (call === undefined) continue;
    const result = await perform(calls, call, { ...opts, timeoutMs: HAOMAO_UPLOAD_TIMEOUT_MS });
    const json = result.json as { url?: unknown } | undefined;
    if (typeof json?.url !== "string" || !/^https?:\/\//i.test(json.url)) {
      throw new TransportError(`haomao upload of ${item.path} returned no url`, calls, publicResult(result));
    }
    for (const same of described) if (same.path === item.path) urls.set(same.source, json.url);
  }
  const planned = planVideo(withSources(request, urls), binding);
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
