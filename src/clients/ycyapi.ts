import type { LumenConfig, ModelBinding } from "../config.js";
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
import { isLocalMedia, withMediaSources, type UploadKind } from "./beeftv.js";
import { mapLocalMediaViaTos } from "./tos.js";

/**
 * YCY API Seedance 2.5 (docs on https://ycyapi.cn via channel 22-SD-2.5视频).
 * POST {base}/v1/videos, GET {base}/v1/videos/{id}, GET|HEAD {base}/v1/videos/{id}/content.
 * Wire model seedance2.5-A. HTTPS refs pass through. Local image/video/audio refs upload only
 * through Volcengine TOS (presigned GET, private bucket). The https URLs go into `references`.
 */
export const YCYAPI_SEEDANCE_MODELS: Record<string, string> = {
  "seedance-2.5": "seedance2.5-A",
};

export function ycyapiWireModel(modelId: string, alias: string | undefined): string {
  return alias ?? YCYAPI_SEEDANCE_MODELS[modelId] ?? modelId;
}

const OK = new Set(["completed"]);
const FAIL = new Set(["failed", "expired", "cancelled", "canceled"]);

export function ycyapiTaskState(value: unknown): "pending" | "ok" | "fail" {
  const status = String(asRecord(value)?.status ?? "").toLowerCase();
  if (OK.has(status)) return "ok";
  if (FAIL.has(status)) return "fail";
  return "pending";
}

function isHttps(source: string): boolean {
  return /^https:\/\//i.test(source);
}

function assertMediaRefs(request: VideoRequest): void {
  for (const ref of request.references) {
    if (!isHttps(ref.source) && !isLocalMedia(ref.source)) {
      throw new CliError(`ycyapi media must be https:// or a local file (local files upload through TOS): ${ref.source}`);
    }
  }
}

function localRefs(request: VideoRequest): Array<{ source: string; kind: UploadKind }> {
  return request.references
    .filter((ref) => isLocalMedia(ref.source))
    .map((ref) => ({ source: ref.source, kind: ref.kind as UploadKind }));
}

function references(list: MediaRef[]): Array<{ type: string; role: string; source: string }> {
  return list.map((ref) => ({ type: ref.kind, role: "reference", source: ref.source }));
}

export function planYcyapiVideo(request: VideoRequest, binding: ModelBinding): HttpCall[] {
  const model = ycyapiWireModel(request.modelId, binding.modelAlias);
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    seconds: request.duration,
    resolution: request.resolution,
    aspect_ratio: request.aspectRatio,
  };
  const refs = references(request.references);
  if (refs.length > 0) body.references = refs;
  return [
    jsonCall("POST", joinUrl(binding.baseUrl, "/v1/videos"), {}, body),
    { method: "GET", url: joinUrl(binding.baseUrl, "/v1/videos/{{task_id}}"), headers: {}, body: { kind: "empty" } },
    { method: "GET", url: joinUrl(binding.baseUrl, "/v1/videos/{{task_id}}/content"), headers: {}, body: { kind: "empty" } },
  ];
}

export function missingYcyapiTos(): CliError {
  return new CliError(
    'ycyapi local media uploads only through Volcengine TOS. Add a tos block and set the keys:\n"tos": {}\nVOLC_ACCESSKEY and VOLC_SECRETKEY',
  );
}

export async function runYcyapiVideo(
  request: VideoRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  videoFile: string,
  receipt: string,
  config: LumenConfig,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  assertMediaRefs(request);
  const calls: HttpCall[] = [];
  const locals = localRefs(request);
  let wired = request;
  let plannedUploads: unknown[] = [];
  if (locals.length > 0) {
    if (config.tos === undefined) throw missingYcyapiTos();
    const mapped = await mapLocalMediaViaTos(locals, config.tos, mode, io, calls);
    wired = withMediaSources(request, mapped.urls);
    plannedUploads = mapped.plannedUploads;
  }
  const planned = planYcyapiVideo(wired, binding);
  if (mode === "dry-run") {
    return {
      calls: [...calls, ...planned],
      response: plannedUploads.length > 0 ? { plannedUploads } : {},
      files: [],
    };
  }
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const first = planned[0];
  if (first === undefined) throw new CliError("video request has no call");
  const submitted = await perform(calls, first, opts);
  return finishYcyapiVideo(calls, binding.baseUrl, submitted, opts, io, mode, videoFile, receipt);
}

function taskIdOf(value: unknown): string | undefined {
  const id = asRecord(value)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

const DELIVERY_RETRIES = 6;

export async function finishYcyapiVideo(
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
  if (id === undefined) throw new TransportError("ycyapi response has no task id", calls, publicResult(initial));
  const pollUrl = joinUrl(baseUrl, `/v1/videos/${encodeURIComponent(id)}`);
  const task = await awaitTask(calls, initial, pollUrl, {}, ycyapiTaskState, opts, io, `ycyapi task ${id}`, { provider: "ycyapi", taskId: id });
  const response = redactValue(publicResult(task), []);
  const files: OutputFile[] = [];
  if (mode === "execute") {
    const contentUrl = `${pollUrl}/content`;
    let downloaded: HttpResult | undefined;
    for (let attempt = 0; downloaded === undefined; attempt += 1) {
      try {
        downloaded = await perform(calls, { method: "GET", url: contentUrl, headers: {}, body: { kind: "empty" } }, opts);
      } catch (err) {
        const status = err instanceof TransportError ? asRecord(err.response)?.status : undefined;
        if (status !== 503 || attempt >= DELIVERY_RETRIES) throw err;
        await pause(io, 5_000);
      }
    }
    files.push({ path: videoFile, bytes: downloaded.body });
    files.push({ path: receipt, text: `${JSON.stringify(response, null, 2)}\n` });
  }
  return { calls, response, files };
}
