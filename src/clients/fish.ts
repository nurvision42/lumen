import type { ModelBinding } from "../config.js";
import type { FishRequest } from "../catalog.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import {
  fetchOf,
  joinUrl,
  perform,
  publicResult,
  type HttpCall,
  type HttpResult,
  type SendOptions,
} from "../http.js";
import type { IO } from "../io.js";
import { contentTypeFor, isProbablyFile } from "../media.js";
import type { OutputFile } from "../runs.js";
import { asRecord, findString } from "../walk.js";
import { bytesFromResult, jsonCall } from "./wire.js";

function ttsValue(text: string, voiceId: string, alias: string | undefined): Record<string, unknown> {
  return {
    text,
    voiceId,
    format: "mp3",
    ...(alias === undefined ? {} : { modelId: alias }),
  };
}

export function planFish(request: FishRequest, binding: ModelBinding, runId: string): HttpCall[] {
  if (binding.provider !== "kitta") {
    throw new CliError(`provider ${binding.provider} has no voice client`);
  }
  const root = binding.baseUrl;
  if (request.operation === "design") {
    const body: Record<string, unknown> = {
      prompt: request.instruction,
      providers: ["fishaudio"],
    };
    if (request.text !== undefined) body.previewText = request.text;
    return [
      jsonCall("POST", joinUrl(root, "/api/open/v1/voice-designs"), { "Idempotency-Key": `lumen-${runId}-design` }, body),
      {
        method: "GET",
        url: joinUrl(root, "/api/open/v1/voice-designs/{{design_id}}/candidates/{{candidate_id}}/audio"),
        headers: {},
        body: { kind: "empty" },
      },
    ];
  }
  const text = request.text ?? "";
  const speak = (voiceId: string): HttpCall =>
    jsonCall("POST", joinUrl(root, "/api/open/v3/speech/tts"), {}, ttsValue(text, voiceId, binding.modelAlias));
  if (request.operation === "synth" || (request.voice !== undefined && !isProbablyFile(request.voice))) {
    return [speak(request.voice ?? "")];
  }
  const voice = request.voice ?? "";
  const create: HttpCall = {
    method: "POST",
    url: joinUrl(root, "/api/open/v1/voices"),
    headers: {},
    body: {
      kind: "multipart",
      parts: [
        { name: "name", text: request.title ?? `lumen-${runId}` },
        { name: "referenceText", text },
        { name: "audioFiles", filePath: voice, contentType: contentTypeFor(voice) },
      ],
    },
  };
  return [create, speak("{{voice_id}}")];
}

function candidateId(value: unknown): string | undefined {
  const record = asRecord(value);
  const nested = asRecord(record?.data);
  const lists = [record?.candidates, nested?.candidates, record?.previews];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const item = asRecord(list[0]);
    const id = item?.candidateId ?? item?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return findString(value, "candidateId");
}

function voiceIdOf(result: HttpResult): string | undefined {
  return findString(result.json, "voiceId") ?? findString(result.json, "id");
}

export async function runFish(
  request: FishRequest,
  binding: ModelBinding,
  mode: RunMode,
  io: IO,
  apiKey: string | undefined,
  runId: string,
  outFile: string,
): Promise<{ calls: HttpCall[]; response: unknown; files: OutputFile[] }> {
  if (mode === "execute" && request.operation === "clone" && request.voice !== undefined && isProbablyFile(request.voice)) {
    if (/^https?:\/\//i.test(request.voice)) {
      throw new CliError("kitta voice-clone from a sample needs a local file; a voice id skips voice creation");
    }
  }
  const planned = planFish(request, binding, runId);
  if (mode === "dry-run") return { calls: planned, response: null, files: [] };

  const opts: SendOptions = { mode, fetchImpl: fetchOf(io), ...(apiKey === undefined ? {} : { apiKey }) };
  const calls: HttpCall[] = [];
  const first = planned[0];
  if (first === undefined) throw new CliError("voice request has no call");

  if (request.operation === "design") {
    const created = await perform(calls, first, opts);
    const designId = findString(created.json, "designId");
    const chosen = candidateId(created.json);
    if (designId === undefined || chosen === undefined) {
      throw new CliError("kitta voice-design response has no designId or candidateId");
    }
    const audio = await perform(
      calls,
      {
        method: "GET",
        url: joinUrl(binding.baseUrl, `/api/open/v1/voice-designs/${encodeURIComponent(designId)}/candidates/${encodeURIComponent(chosen)}/audio`),
        headers: {},
        body: { kind: "empty" },
      },
      opts,
    );
    return finish(mode, outFile, calls, audio);
  }

  let last = await perform(calls, first, opts);
  if (first.url.endsWith("/voices")) {
    const id = voiceIdOf(last);
    if (id === undefined) throw new CliError("kitta create-voice response has no voiceId");
    const speak = planned[1];
    if (speak === undefined || speak.body.kind !== "json") throw new CliError("voice clone has no speech call");
    last = await perform(
      calls,
      {
        ...speak,
        body: { kind: "json", value: { ...(speak.body.value as Record<string, unknown>), voiceId: id } },
      },
      opts,
    );
  }
  return finish(mode, outFile, calls, last);
}

function finish(
  mode: RunMode,
  outFile: string,
  calls: HttpCall[],
  last: HttpResult,
): { calls: HttpCall[]; response: unknown; files: OutputFile[] } {
  const response = publicResult(last);
  const files: OutputFile[] = [];
  if (mode === "execute") {
    const bytes = bytesFromResult(last);
    if (bytes !== undefined) files.push({ path: outFile, bytes });
    else files.push({ path: outFile.replace(/\.[^.]+$/, "") + ".json", text: `${JSON.stringify(response, null, 2)}\n` });
  }
  return { calls, response, files };
}
