import type { ModelBinding } from "../config.js";
import { assertImageProviderRules, type ImageRequest } from "../catalog.js";
import { CliError } from "../errors.js";
import { contentTypeFor } from "../media.js";
import { fetchOf, groupHeaders, joinUrl, perform, publicResult, type HttpCall, type HttpResult } from "../http.js";
import type { IO } from "../io.js";
import type { RunMode } from "../flags.js";
import type { OutputFile } from "../runs.js";
import { assertBeeftvImageRef, isLocalMedia, mapLocalMediaViaBeeftv, planBeeftvImage } from "./beeftv.js";
import { planVolcarkImage, seedreamSize, volcarkImageRef } from "./volcark.js";
import { assertHttps, bytesFromResult, httpUrlFromResult, imageSize, jsonCall, wireModel } from "./wire.js";

export function planImage(request: ImageRequest, binding: ModelBinding): HttpCall[] {
  if (binding.provider === "volcark") {
    throw new CliError("volcark image calls are built by planVolcarkImage");
  }
  if (binding.provider === "beeftv") {
    throw new CliError("beeftv image calls are built by planBeeftvImage");
  }
  const model = wireModel(request.modelId, binding.modelAlias);
  if (request.resolution === "1.5K") {
    throw new CliError("resolution 1.5K is only available on seedream");
  }
  const size = imageSize(request.aspectRatio, request.resolution);
  assertImageProviderRules(request, binding.provider);
  const editing = request.references.length > 0;

  if (binding.provider === "grsai") {
    const body: Record<string, unknown> = { model, prompt: request.prompt, size };
    if (request.background !== undefined) body.background = request.background;
    if (request.quality !== undefined) body.quality = request.quality;
    if (editing) body.image = request.references;
    return [jsonCall("POST", joinUrl(binding.baseUrl, "/v1/images/generations"), {}, body)];
  }

  if (binding.provider !== "yunqiao") {
    throw new CliError(`provider ${binding.provider} has no image client`);
  }

  const headers = groupHeaders(binding.provider, binding.group);
  const path = editing ? "/images/edits" : "/images/generations";
  const url = joinUrl(binding.baseUrl, path);
  if (!editing) {
    const body: Record<string, unknown> = { model, prompt: request.prompt, size, n: 1 };
    if (request.background !== undefined) body.background = request.background;
    if (request.quality !== undefined) body.quality = request.quality;
    return [jsonCall("POST", url, headers, body)];
  }

  const parts = [
    { name: "model", text: model },
    { name: "prompt", text: request.prompt },
    { name: "size", text: size },
    { name: "n", text: "1" },
    ...(request.background === undefined ? [] : [{ name: "background", text: request.background }]),
    ...(request.quality === undefined ? [] : [{ name: "quality", text: request.quality }]),
    ...request.references.map((ref) => ({
      name: "image",
      filePath: ref,
      contentType: contentTypeFor(ref),
    })),
  ];
  return [{ method: "POST", url, headers, body: { kind: "multipart", parts } }];
}

function checkExecute(request: ImageRequest, binding: ModelBinding): void {
  if (request.references.length === 0) return;
  if (binding.provider === "grsai") {
    for (const ref of request.references) assertHttps(ref, "grsai", "images");
    return;
  }
  for (const ref of request.references) {
    if (/^https?:\/\//i.test(ref)) throw new CliError("yunqiao image edits need a local file");
  }
}

export async function runImage(
  request: ImageRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  outFile: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  if (binding.provider === "volcark") return runVolcarkImage(request, binding, mode, io, apiKey, outFile);
  if (binding.provider === "beeftv") return runBeeftvImage(request, binding, mode, io, apiKey, outFile);
  const calls = planImage(request, binding);
  if (mode === "dry-run") return { calls, response: null, files: [] };
  if (mode === "execute") checkExecute(request, binding);
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const sent: HttpCall[] = [];
  const first = calls[0];
  if (first === undefined) throw new CliError("image request has no call");
  const result = await perform(sent, first, opts);
  const files: OutputFile[] = [];
  if (mode === "execute") {
    const saved = await saveImage(result, outFile, sent, opts);
    files.push(saved);
  }
  return { calls: sent, response: publicResult(result), files };
}

async function runVolcarkImage(
  request: ImageRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  outFile: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  const references = await Promise.all(request.references.map((ref) => volcarkImageRef(ref, io.cwd)));
  const planned = planVolcarkImage({ ...request, references }, binding);
  const calls: HttpCall[] = [];
  if (mode === "dry-run") return { calls: planned, response: null, files: [] };
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const first = planned[0];
  if (first === undefined) throw new CliError("image request has no call");
  const result = await perform(calls, first, opts);
  const files: OutputFile[] = [];
  if (mode === "execute") files.push(await saveImage(result, outFile, calls, opts));
  return { calls, response: publicResult(result), files };
}

async function runBeeftvImage(
  request: ImageRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  outFile: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  for (const ref of request.references) assertBeeftvImageRef(ref);
  const calls: HttpCall[] = [];
  let references = request.references;
  let plannedUploads: unknown[] = [];
  const locals = request.references.filter((ref) => isLocalMedia(ref));
  if (locals.length > 0) {
    const mapped = await mapLocalMediaViaBeeftv(
      locals.map((source) => ({ source, kind: "image" as const })),
      binding.baseUrl,
      mode,
      io,
      apiKey,
      calls,
    );
    references = request.references.map((ref) => mapped.urls.get(ref) ?? ref);
    plannedUploads = mapped.plannedUploads;
  }
  const planned = planBeeftvImage({ ...request, references }, binding, seedreamSize(request.aspectRatio, request.resolution));
  if (mode === "dry-run") {
    return {
      calls: [...calls, ...planned],
      response: plannedUploads.length > 0 ? { plannedUploads } : null,
      files: [],
    };
  }
  const opts = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const first = planned[0];
  if (first === undefined) throw new CliError("image request has no call");
  const result = await perform(calls, first, opts);
  const files: OutputFile[] = [];
  if (mode === "execute") files.push(await saveImage(result, outFile, calls, opts));
  return { calls, response: publicResult(result), files };
}

async function saveImage(
  result: HttpResult,
  outFile: string,
  calls: HttpCall[],
  opts: { mode: "execute" | "mock"; fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; apiKey?: string },
): Promise<OutputFile> {
  const bytes = bytesFromResult(result);
  if (bytes !== undefined) return { path: outFile, bytes };
  const url = httpUrlFromResult(result);
  if (url !== undefined) {
    const downloaded = await perform(calls, { method: "GET", url, headers: {}, body: { kind: "empty" } }, { ...opts, auth: false });
    const payload = bytesFromResult(downloaded) ?? downloaded.body;
    return { path: outFile, bytes: payload };
  }
  const receipt = outFile.replace(/\.[^.]+$/, "") + ".json";
  return { path: receipt, text: `${JSON.stringify(publicResult(result), null, 2)}\n` };
}
