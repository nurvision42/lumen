import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ModelBinding } from "../config.js";
import { SEEDREAM_55_MODEL, assertImageProviderRules, type ImageRequest } from "../catalog.js";
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
import { contentTypeFor } from "../media.js";
import { redactValue } from "../redact.js";
import type { OutputFile } from "../runs.js";
import { asRecord } from "../walk.js";
import { isLocalMedia } from "./beeftv.js";
import { awaitTask } from "./jobs.js";
import { jsonCall } from "./wire.js";
import { namedMediaFile } from "../format.js";

/**
 * Yir Standard async image API (https://yir.ai/docs/guides/image-generation).
 * POST {base}/v1/images/generations with Idempotency-Key, poll GET {base}/v1/jobs/{id}/status,
 * then GET {base}/v1/jobs/{id} for result.files[].url.
 * Local refs go through the Files API; public https URLs pass through. Data URIs are not accepted.
 */
export const YIR_IMAGE_PATH = "/v1/images/generations";
export const YIR_FILES_PATH = "/v1/files";
export const YIR_SEEDREAM_WIRE: Record<string, string> = {
  [SEEDREAM_55_MODEL]: "bytedance/seedream-5.5",
};
export const YIR_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function yirImageWireModel(modelId: string, alias: string | undefined): string {
  return alias ?? YIR_SEEDREAM_WIRE[modelId] ?? modelId;
}

const OK = new Set(["succeeded"]);
const FAIL = new Set(["failed", "cancelled"]);

export function yirTaskState(value: unknown): "pending" | "ok" | "fail" {
  const status = String(asRecord(value)?.status ?? "").toLowerCase();
  if (OK.has(status)) return "ok";
  if (FAIL.has(status)) return "fail";
  return "pending";
}

export function yirJobId(value: unknown): string | undefined {
  const id = asRecord(value)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function yirResultUrl(value: unknown): string | undefined {
  const files = asRecord(asRecord(value)?.result)?.files;
  if (!Array.isArray(files)) return undefined;
  for (const item of files) {
    const url = asRecord(item)?.url;
    if (typeof url === "string" && /^https:\/\//i.test(url)) return url;
  }
  return undefined;
}

export function yirFailureDetail(value: unknown): string | undefined {
  const err = asRecord(asRecord(value)?.error);
  if (err === undefined) return undefined;
  const code = typeof err.code === "string" ? err.code : undefined;
  const message = typeof err.message === "string" ? err.message : undefined;
  const provider = asRecord(err.provider_error)?.message;
  const parts = [code, message, typeof provider === "string" ? provider : undefined].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(": ");
}

export type YirImageRef = { role: "reference_image"; url: string } | { role: "reference_image"; file_id: string };

export interface PlannedYirUpload {
  source: string;
  path: string;
  name: string;
  mediaType: string;
  bytes: number;
}

function isHttps(source: string): boolean {
  return /^https:\/\//i.test(source);
}

export function assertYirImageRef(source: string): void {
  if (isHttps(source) || isLocalMedia(source)) return;
  throw new CliError(`yir image reference must be https:// or a local file (data URIs are not accepted): ${source}`);
}

export function yirMediaType(file: string): string {
  const type = contentTypeFor(file);
  if (!YIR_IMAGE_MEDIA_TYPES.has(type)) {
    throw new CliError(`yir local references must be jpeg, png, or webp: ${file}`);
  }
  return type;
}

export async function describeYirUpload(source: string, cwd: string): Promise<PlannedYirUpload> {
  const resolved = path.isAbsolute(source) ? source : path.resolve(cwd, source);
  const info = await stat(resolved);
  return {
    source,
    path: resolved,
    name: path.basename(resolved),
    mediaType: yirMediaType(resolved),
    bytes: info.size,
  };
}

function newIdempotencyKey(): string {
  return randomUUID();
}

export function planYirImage(
  request: ImageRequest,
  binding: ModelBinding,
  refs: YirImageRef[],
  idempotencyKey: string,
): HttpCall[] {
  assertImageProviderRules(request, binding.provider);
  const model = yirImageWireModel(request.modelId, binding.modelAlias);
  const input =
    refs.length === 0
      ? { type: "text", prompt: request.prompt }
      : { type: "image", prompt: request.prompt, references: refs };
  const body = {
    model,
    input,
    parameters: {
      resolution: request.resolution,
      aspect_ratio: request.aspectRatio,
      n: 1,
    },
  };
  return [
    jsonCall(
      "POST",
      joinUrl(binding.baseUrl, YIR_IMAGE_PATH),
      { "Idempotency-Key": idempotencyKey },
      body,
    ),
  ];
}

function planCreateFiles(baseUrl: string, uploads: PlannedYirUpload[], idempotencyKey: string): HttpCall {
  return jsonCall(
    "POST",
    joinUrl(baseUrl, YIR_FILES_PATH),
    { "Idempotency-Key": idempotencyKey },
    {
      files: uploads.map((up) => ({
        name: up.name,
        media_type: up.mediaType,
        size: up.bytes,
      })),
    },
  );
}

function planFileCalls(baseUrl: string, fileId: string, parts: Array<{ url: string; path: string; mediaType: string }>): HttpCall[] {
  const calls: HttpCall[] = parts.map((part) => ({
    method: "PUT" as const,
    url: part.url,
    headers: {},
    body: { kind: "file" as const, path: part.path, contentType: part.mediaType },
  }));
  calls.push(jsonCall("POST", joinUrl(baseUrl, `${YIR_FILES_PATH}/${encodeURIComponent(fileId)}/complete`), {}, {}));
  calls.push({ method: "GET", url: joinUrl(baseUrl, `${YIR_FILES_PATH}/${encodeURIComponent(fileId)}`), headers: {}, body: { kind: "empty" } });
  return calls;
}

async function waitFileReady(
  calls: HttpCall[],
  baseUrl: string,
  fileId: string,
  initial: HttpResult,
  opts: SendOptions,
  io: IO,
): Promise<void> {
  const url = joinUrl(baseUrl, `${YIR_FILES_PATH}/${encodeURIComponent(fileId)}`);
  let current = initial;
  for (let i = 0; i < 30; i += 1) {
    const status = String(asRecord(current.json)?.status ?? "");
    if (status === "ready") return;
    if (status === "failed" || status === "expired") {
      throw new TransportError(`yir file ${fileId} ${status}`, calls, publicResult(current));
    }
    await pause(io, opts.mode === "mock" ? 0 : 1_000);
    current = await perform(calls, { method: "GET", url, headers: {}, body: { kind: "empty" } }, opts);
  }
  throw new TransportError(`yir file ${fileId} not ready`, calls, publicResult(current));
}

async function uploadYirOne(
  calls: HttpCall[],
  baseUrl: string,
  fileId: string,
  parts: Array<{ part_number?: unknown; size?: unknown; url?: unknown }>,
  up: PlannedYirUpload,
  opts: SendOptions,
  io: IO,
): Promise<string> {
  if (parts.length !== 1) {
    throw new CliError(`yir reference ${up.name} needs a single upload part (files over 64 MiB are not supported)`);
  }
  const url = parts[0]?.url;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    throw new TransportError(`yir upload for ${up.path} returned no part url`, calls, null);
  }
  await perform(
    calls,
    { method: "PUT", url, headers: {}, body: { kind: "file", path: up.path, contentType: up.mediaType } },
    { ...opts, auth: false },
  );
  const completed = await perform(
    calls,
    jsonCall("POST", joinUrl(baseUrl, `${YIR_FILES_PATH}/${encodeURIComponent(fileId)}/complete`), {}, {}),
    opts,
  );
  await waitFileReady(calls, baseUrl, fileId, completed, opts, io);
  return fileId;
}

export async function mapLocalImagesViaYir(
  locals: string[],
  baseUrl: string,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  calls: HttpCall[],
): Promise<{ refs: Map<string, string>; plannedUploads: PlannedYirUpload[] }> {
  const plannedUploads = await Promise.all(locals.map((source) => describeYirUpload(source, io.cwd)));
  const unique: PlannedYirUpload[] = [];
  const byPath = new Map<string, PlannedYirUpload>();
  for (const up of plannedUploads) {
    if (byPath.has(up.path)) continue;
    byPath.set(up.path, up);
    unique.push(up);
  }
  const create = planCreateFiles(baseUrl, unique, newIdempotencyKey());
  if (mode === "dry-run") {
    calls.push(create);
    for (const up of unique) {
      calls.push(...planFileCalls(baseUrl, "file_pending", [{ url: "https://upload.example/part", path: up.path, mediaType: up.mediaType }]));
    }
    const refs = new Map<string, string>();
    for (const up of plannedUploads) refs.set(up.source, "file_pending");
    return { refs, plannedUploads };
  }
  const opts: SendOptions = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const created = await perform(calls, create, opts);
  const files = asRecord(created.json)?.files;
  if (!Array.isArray(files) || files.length !== unique.length) {
    throw new TransportError("yir file create did not return one plan per file", calls, publicResult(created));
  }
  const ids = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 1) {
    const up = unique[i]!;
    const entry = asRecord(files[i]);
    const fileId = typeof entry?.id === "string" ? entry.id : undefined;
    const upload = asRecord(entry?.upload);
    const parts = Array.isArray(upload?.parts) ? upload.parts : [];
    if (fileId === undefined) {
      throw new TransportError(`yir file create for ${up.path} returned no id`, calls, publicResult(created));
    }
    await uploadYirOne(calls, baseUrl, fileId, parts as Array<{ part_number?: unknown; size?: unknown; url?: unknown }>, up, opts, io);
    ids.set(up.path, fileId);
  }
  const refs = new Map<string, string>();
  for (const up of plannedUploads) {
    const id = ids.get(up.path);
    if (id !== undefined) refs.set(up.source, id);
  }
  return { refs, plannedUploads };
}

function wiredRefs(request: ImageRequest, fileIds: Map<string, string>): YirImageRef[] {
  return request.references.map((source) => {
    const fileId = fileIds.get(source);
    if (fileId !== undefined) return { role: "reference_image", file_id: fileId };
    return { role: "reference_image", url: source };
  });
}

export async function runYirImage(
  request: ImageRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  outFile: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  for (const ref of request.references) assertYirImageRef(ref);
  const calls: HttpCall[] = [];
  const locals = request.references.filter((ref) => isLocalMedia(ref));
  let fileIds = new Map<string, string>();
  let plannedUploads: PlannedYirUpload[] = [];
  if (locals.length > 0) {
    const mapped = await mapLocalImagesViaYir(locals, binding.baseUrl, mode, io, apiKey, calls);
    fileIds = mapped.refs;
    plannedUploads = mapped.plannedUploads;
  }
  const planned = planYirImage(request, binding, wiredRefs(request, fileIds), newIdempotencyKey());
  if (mode === "dry-run") {
    return {
      calls: [...calls, ...planned],
      response: plannedUploads.length > 0 ? { plannedUploads } : null,
      files: [],
    };
  }
  const opts: SendOptions = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const first = planned[0];
  if (first === undefined) throw new CliError("image request has no call");
  const submitted = await perform(calls, first, opts);
  return finishYirImage(calls, binding.baseUrl, submitted, opts, io, mode, outFile);
}

export async function finishYirImage(
  calls: HttpCall[],
  baseUrl: string,
  initial: HttpResult,
  opts: SendOptions,
  io: IO,
  mode: RunMode,
  outFile: string,
  knownId?: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  const id = yirJobId(initial.json) ?? knownId;
  if (id === undefined) throw new TransportError("yir response has no job id", calls, publicResult(initial));
  const statusUrl = joinUrl(baseUrl, `/v1/jobs/${encodeURIComponent(id)}/status`);
  if (io.noteImageResult !== undefined) {
    await io.noteImageResult({
      provider: "yir",
      outFile,
      received: true,
      response: publicResult(initial),
      taskId: id,
    });
  }
  const status = await awaitTask(
    calls,
    initial,
    statusUrl,
    {},
    yirTaskState,
    opts,
    io,
    `yir job ${id}`,
    { provider: "yir", taskId: id, pollUrl: statusUrl },
    undefined,
    yirFailureDetail,
  );
  let job = status;
  if (yirResultUrl(job.json) === undefined) {
    job = await perform(
      calls,
      { method: "GET", url: joinUrl(baseUrl, `/v1/jobs/${encodeURIComponent(id)}`), headers: {}, body: { kind: "empty" } },
      opts,
    );
  }
  const response = redactValue(publicResult(job), []);
  const files: OutputFile[] = [];
  if (mode === "execute") {
    const url = yirResultUrl(job.json);
    if (url === undefined) throw new TransportError("yir job has no result url", calls, response);
    if (io.noteImageResult !== undefined) {
      await io.noteImageResult({
        provider: "yir",
        outFile,
        received: true,
        response,
        taskId: id,
        url,
      });
    }
    const downloaded = await perform(
      calls,
      { method: "GET", url, headers: {}, body: { kind: "empty" } },
      { ...opts, auth: false },
    );
    files.push(namedMediaFile(outFile, downloaded.body, { kind: "image", fallback: ".png", contentType: downloaded.contentType }));
  }
  return { calls, response, files };
}
