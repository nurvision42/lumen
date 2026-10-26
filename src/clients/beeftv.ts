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

function isLocal(source: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source);
}

function item(type: "image_url" | "video_url" | "audio_url", url: string, role: string): Record<string, unknown> {
  return { type, [type]: { url }, role };
}

function refs(list: MediaRef[], kind: MediaRef["kind"]): string[] {
  return list.filter((ref) => ref.kind === kind).map((ref) => ref.source);
}

/**
 * BeefTV has no upload endpoint. Its docs allow a data URL only for the top-level
 * single first-frame `image`; every `content` item must be a reachable https URL.
 */
export function checkBeeftvMedia(request: VideoRequest): void {
  const all = [request.firstFrame?.source, request.lastFrame?.source, ...request.references.map((ref) => ref.source)]
    .filter((s): s is string => s !== undefined);
  const soloFirst = request.firstFrame !== undefined && request.lastFrame === undefined && request.references.length === 0;
  for (const source of all) {
    if (/^https:\/\//i.test(source)) continue;
    if (soloFirst && source === request.firstFrame?.source && isLocal(source)) continue;
    throw new CliError(
      `beeftv has no upload endpoint; pass an https URL (a local file is only accepted as a lone --first-frame): ${source}`,
    );
  }
}

export function planBeeftvVideo(request: VideoRequest, binding: ModelBinding, firstFrameDataUrl?: string): HttpCall[] {
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
  if (firstFrameDataUrl !== undefined) {
    body.image = firstFrameDataUrl;
  } else {
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

const MAX_INLINE_BYTES = 30 * 1024 * 1024;

async function dataUrl(source: string, cwd: string): Promise<string> {
  const file = path.resolve(cwd, source);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(`local media not found: ${file}`);
  }
  if (bytes.byteLength >= MAX_INLINE_BYTES) throw new CliError(`beeftv first-frame image must be under 30 MB: ${file}`);
  return `data:${contentTypeFor(file)};base64,${bytes.toString("base64")}`;
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
  checkBeeftvMedia(request);
  const local = request.firstFrame !== undefined && isLocal(request.firstFrame.source) ? request.firstFrame.source : undefined;
  if (mode === "dry-run") {
    const placeholder = local === undefined ? undefined : `{{data-url:${path.resolve(io.cwd, local)}}}`;
    return {
      calls: planBeeftvVideo(request, binding, placeholder),
      response: local === undefined ? {} : { inlineFirstFrame: path.resolve(io.cwd, local) },
      files: [],
    };
  }
  const inline = local === undefined ? undefined : await dataUrl(local, io.cwd);
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const calls: HttpCall[] = [];
  const first = planBeeftvVideo(request, binding, inline)[0];
  if (first === undefined) throw new CliError("video request has no call");
  const audit = inline === undefined ? first : planBeeftvVideo(request, binding, `{{data-url:${path.resolve(io.cwd, local ?? "")}}}`)[0]!;
  let submitted: HttpResult;
  try {
    submitted = await perform(calls, first, opts);
  } finally {
    calls[0] = audit; // keep the inline image bytes out of the run record
  }
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
