import type { ModelBinding } from "../config.js";
import type { MediaRef, VideoRequest } from "../catalog.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import { fetchOf, joinUrl, pause, perform, publicResult, TransportError, type HttpCall, type HttpResult, type SendOptions } from "../http.js";
import type { IO } from "../io.js";
import { redactValue } from "../redact.js";
import type { OutputFile } from "../runs.js";
import { asRecord } from "../walk.js";
import { awaitTask } from "./jobs.js";
import { jsonCall } from "./wire.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { contentTypeFor } from "../media.js";

/**
 * BeefTV enterprise video API (docs.enterprise.beefapi.com/docs/seedance).
 * POST {base}/v1/videos, GET {base}/v1/videos/{id}, GET {base}/v1/videos/{id}/content.
 */
export const BEEFTV_SEEDANCE_MODELS: Record<string, string> = {
  "seedance-2-fast": "seedance-2.0-fast",
};

export function beeftvWireModel(modelId: string, alias: string | undefined): string {
  return alias ?? BEEFTV_SEEDANCE_MODELS[modelId] ?? modelId;
}

const OK = new Set(["completed"]);
const FAIL = new Set(["failed", "expired", "cancelled", "canceled"]);

export function beeftvTaskState(value: unknown): "pending" | "ok" | "fail" {
  const status = String(asRecord(value)?.status ?? "").toLowerCase();
  if (OK.has(status)) return "ok";
  if (FAIL.has(status)) return "fail";
  // queued, in_progress, unknown or unrecognised: keep polling, never treat as success
  return "pending";
}

export function beeftvVideoUrl(value: unknown): string | undefined {
  const url = asRecord(asRecord(value)?.metadata)?.url;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : undefined;
}

export function isLocalMedia(source: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source);
}

function item(type: "image_url" | "video_url" | "audio_url", url: string, role: string): Record<string, unknown> {
  return { type, [type]: { url }, role };
}

function refs(list: MediaRef[], kind: MediaRef["kind"]): string[] {
  return list.filter((ref) => ref.kind === kind).map((ref) => ref.source);
}

export type UploadKind = "image" | "video" | "audio";

export interface PlannedBeeftvUpload {
  source: string;
  path: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  sha256: string;
}

/** Every media source with its kind; https passes through, local files are uploaded. */
function mediaSources(request: VideoRequest): Array<{ source: string; kind: UploadKind }> {
  const out: Array<{ source: string; kind: UploadKind }> = [];
  if (request.firstFrame) out.push({ source: request.firstFrame.source, kind: "image" });
  if (request.lastFrame) out.push({ source: request.lastFrame.source, kind: "image" });
  for (const ref of request.references) out.push({ source: ref.source, kind: ref.kind as UploadKind });
  for (const item of out) {
    if (!isLocalMedia(item.source) && !/^https:\/\//i.test(item.source)) {
      throw new CliError(`beeftv media must be https:// or a local file: ${item.source}`);
    }
  }
  return out.filter((item) => isLocalMedia(item.source));
}

export function planBeeftvVideo(request: VideoRequest, binding: ModelBinding): HttpCall[] {
  const model = beeftvWireModel(request.modelId, binding.modelAlias);
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    duration: request.duration,
    resolution: request.resolution,
    metadata: {
      ratio: request.aspectRatio,
      generate_audio: request.generateAudio,
      ...(request.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    },
  };
  {
    const content = [
      ...(request.firstFrame ? [item("image_url", request.firstFrame.source, "first_frame")] : []),
      ...(request.lastFrame ? [item("image_url", request.lastFrame.source, "last_frame")] : []),
      ...refs(request.references, "image").map((u) => item("image_url", u, "reference_image")),
      ...refs(request.references, "video").map((u) => item("video_url", u, "reference_video")),
      ...refs(request.references, "audio").map((u) => item("audio_url", u, "reference_audio")),
    ];
    if (content.length > 0) body.content = content;
  }
  return [
    jsonCall("POST", joinUrl(binding.baseUrl, "/v1/videos"), {}, body),
    { method: "GET", url: joinUrl(binding.baseUrl, "/v1/videos/{{task_id}}"), headers: {}, body: { kind: "empty" } },
    { method: "GET", url: joinUrl(binding.baseUrl, "/v1/videos/{{task_id}}/content"), headers: {}, body: { kind: "empty" } },
  ];
}

export const BEEFTV_UPLOAD_TIMEOUT_MS = 300_000;
const UPLOAD_RETRIES = 4;

export async function describeBeeftvUpload(source: string, kind: UploadKind, cwd: string): Promise<PlannedBeeftvUpload> {
  const file = path.resolve(cwd, source);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(`local media not found: ${file}`);
  }
  return { source, path: file, kind, mime: contentTypeFor(file), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function beeftvUploadStartCall(baseUrl: string, up: PlannedBeeftvUpload): HttpCall {
  return jsonCall("POST", joinUrl(baseUrl, "/v1/video-references/uploads"), {}, {
    bytes: up.bytes, kind: up.kind, mime: up.mime, sha256: up.sha256, resumable: true,
  });
}

function beeftvUploadCompleteCall(baseUrl: string, ticket: string): HttpCall {
  return jsonCall("POST", joinUrl(baseUrl, "/v1/video-references/uploads/complete"), {}, { ticket });
}

function retriable(err: unknown): boolean {
  if (!(err instanceof TransportError)) return true;
  const status = asRecord(err.response)?.status;
  return typeof status !== "number" || status === 408 || status === 429 || status >= 500;
}

async function withRetry<T>(io: IO, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!retriable(err) || attempt >= UPLOAD_RETRIES) throw err;
      const ms = Number(io.env.SEEDANCE_POLL_MS ?? 2_000);
      await pause(io, Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 2_000) * (attempt + 1) : 2_000);
    }
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : `${url.slice(0, i)}?<signed>`;
}

/** start -> PUT presigned (no Authorization) -> complete; returns the https url. */
export async function uploadBeeftvOne(calls: HttpCall[], baseUrl: string, up: PlannedBeeftvUpload, opts: SendOptions, io: IO): Promise<string> {
  const timed = { ...opts, timeoutMs: BEEFTV_UPLOAD_TIMEOUT_MS };
  const started = await withRetry(io, () => perform(calls, beeftvUploadStartCall(baseUrl, up), opts));
  const s = asRecord(started.json);
  const ticket = s?.ticket;
  const uploadUrl = s?.upload_url;
  if (typeof ticket !== "string" || typeof uploadUrl !== "string" || !/^https?:\/\//i.test(uploadUrl)) {
    throw new TransportError(`beeftv upload start for ${up.path} returned no ticket/upload_url`, calls, publicResult(started));
  }
  const method = String(s?.upload_method ?? "PUT").toUpperCase();
  if (method !== "PUT") throw new TransportError(`beeftv upload_method ${method} is not supported`, calls, publicResult(started));
  const required = asRecord(s?.required_headers) ?? {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(required)) {
    // fetch computes Content-Length from the body itself
    if (k.toLowerCase() !== "content-length" && typeof v === "string") headers[k] = v;
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = up.mime;
  const put: HttpCall = { method: "PUT", url: uploadUrl, headers, body: { kind: "file", path: up.path, contentType: up.mime } };
  await withRetry(io, async () => {
    const at = calls.length;
    try {
      return await perform(calls, put, { ...timed, auth: false });
    } finally {
      const c = calls[at];
      if (c !== undefined) calls[at] = { ...c, url: stripQuery(c.url) }; // keep the signature out of the record
    }
  });
  const done = await withRetry(io, () => perform(calls, beeftvUploadCompleteCall(baseUrl, ticket), opts));
  const url = asRecord(done.json)?.url;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    throw new TransportError(`beeftv upload complete for ${up.path} returned no url`, calls, publicResult(done));
  }
  return url;
}

/**
 * Upload distinct local files via BeefTV video-references.
 * Dry-run appends start calls and maps sources to {{upload:sha256}} placeholders.
 * Execute: start → PUT presigned → complete; same sha256 uploads once per run.
 */
export async function mapLocalMediaViaBeeftv(
  locals: Array<{ source: string; kind: UploadKind }>,
  baseUrl: string,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  calls: HttpCall[],
): Promise<{ urls: Map<string, string>; plannedUploads: PlannedBeeftvUpload[] }> {
  const described = await Promise.all(locals.map((item) => describeBeeftvUpload(item.source, item.kind, io.cwd)));
  const plannedUploads = described.filter((item, index) => described.findIndex((other) => other.sha256 === item.sha256) === index);
  if (mode === "dry-run") {
    for (const up of plannedUploads) calls.push(beeftvUploadStartCall(baseUrl, up));
    return {
      urls: new Map(described.map((item) => [item.source, `{{upload:${item.sha256}}}`])),
      plannedUploads,
    };
  }
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const bySha = new Map<string, string>();
  for (const up of plannedUploads) bySha.set(up.sha256, await uploadBeeftvOne(calls, baseUrl, up, opts, io));
  return {
    urls: new Map(described.map((item) => [item.source, bySha.get(item.sha256)!])),
    plannedUploads,
  };
}

export function withMediaSources(request: VideoRequest, map: Map<string, string>): VideoRequest {
  const swap = (ref: MediaRef): MediaRef => ({ ...ref, source: map.get(ref.source) ?? ref.source });
  const out: VideoRequest = { ...request, references: request.references.map(swap) };
  if (request.firstFrame) out.firstFrame = swap(request.firstFrame);
  if (request.lastFrame) out.lastFrame = swap(request.lastFrame);
  return out;
}

export async function runBeeftvVideo(
  request: VideoRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  videoFile: string,
  receipt: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  const calls: HttpCall[] = [];
  const mapped = await mapLocalMediaViaBeeftv(mediaSources(request), binding.baseUrl, mode, io, apiKey, calls);
  const wired = withMediaSources(request, mapped.urls);
  if (mode === "dry-run") {
    return {
      calls: [...calls, ...planBeeftvVideo(wired, binding)],
      response: { plannedUploads: mapped.plannedUploads },
      files: [],
    };
  }
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const first = planBeeftvVideo(wired, binding)[0];
  if (first === undefined) throw new CliError("video request has no call");
  const submitted = await perform(calls, first, opts);
  return finishBeeftvVideo(calls, binding.baseUrl, submitted, opts, io, mode, videoFile, receipt);
}

function taskIdOf(value: unknown): string | undefined {
  const id = asRecord(value)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

const DELIVERY_RETRIES = 6;

export async function finishBeeftvVideo(
  calls: HttpCall[],
  baseUrl: string,
  initial: HttpResult,
  opts: SendOptions,
  io: IO,
  mode: RunMode,
  videoFile: string,
  receipt: string,
  knownId?: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  const id = taskIdOf(initial.json) ?? knownId;
  if (id === undefined) throw new TransportError("beeftv response has no task id", calls, publicResult(initial));
  const pollUrl = joinUrl(baseUrl, `/v1/videos/${encodeURIComponent(id)}`);
  const task = await awaitTask(calls, initial, pollUrl, {}, beeftvTaskState, opts, io, `beeftv task ${id}`, { provider: "beeftv", taskId: id });
  const response = redactValue(publicResult(task), []);
  const files: OutputFile[] = [];
  if (mode === "execute") {
    // The authenticated /content endpoint may 302 to a temporary host; fetch drops
    // Authorization on cross-origin redirects, so the key never leaves the API domain.
    const contentUrl = `${pollUrl}/content`;
    let downloaded: HttpResult | undefined;
    for (let attempt = 0; downloaded === undefined; attempt += 1) {
      try {
        downloaded = await perform(calls, { method: "GET", url: contentUrl, headers: {}, body: { kind: "empty" } }, opts);
      } catch (err) {
        const status = err instanceof TransportError ? asRecord(err.response)?.status : undefined;
        if (status !== 503 || attempt >= DELIVERY_RETRIES) throw err; // 503 video_delivery_pending
        await pause(io, 5_000);
      }
    }
    files.push({ path: videoFile, bytes: downloaded.body });
    files.push({ path: receipt, text: `${JSON.stringify(response, null, 2)}\n` });
  }
  return { calls, response, files };
}
