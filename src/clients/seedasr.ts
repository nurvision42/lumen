import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PAUSE_GAP_SEC, segmentWords, type TimedWord } from "../captions/words.js";
import { clampCues, toReadable, type CaptionFile, type Cue } from "../captions/cues.js";
import type { ModelBinding, TosConfig } from "../config.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import {
  fetchOf,
  joinUrl,
  pause,
  perform,
  publicResult,
  type HttpCall,
  type HttpResult,
  type SendOptions,
} from "../http.js";
import type { IO } from "../io.js";
import { execText } from "../tools/run.js";
import { asRecord } from "../walk.js";
import { PendingTaskError, flushRemoteTask } from "./jobs.js";
import { mapLocalMediaViaTos, requireTosCredentials } from "./tos.js";
import { jsonCall } from "./wire.js";

export const SEED_ASR_RESOURCE = "volc.seedasr.auc";
export const SEED_ASR_MODEL = "bigmodel";
export const SEED_SUBMIT_PATH = "/api/v3/auc/bigmodel/submit";
export const SEED_QUERY_PATH = "/api/v3/auc/bigmodel/query";
export const SEED_ASR_OK = "20000000";
const SEED_ASR_PENDING = new Set(["20000001", "20000002"]);

const LANGUAGE_TO_SEED: Record<string, string> = {
  "cmn-Hans-CN": "zh-CN",
  "zh-CN": "zh-CN",
  "eng-US": "en-US",
  "en-US": "en-US",
  "spa-ES": "es-MX",
  "es-MX": "es-MX",
  "ind-ID": "id-ID",
  "id-ID": "id-ID",
};

export function seedLanguage(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const mapped = LANGUAGE_TO_SEED[value.trim()];
  if (mapped === undefined) {
    throw new CliError(`seed-asr language must be one of ${Object.keys(LANGUAGE_TO_SEED).join(", ")}`, 2);
  }
  return mapped;
}

export function seedPollLimits(env: NodeJS.ProcessEnv): { max: number; ms: number } {
  const max = Number(env.SEED_ASR_MAX_POLLS ?? 180);
  const ms = Number(env.SEED_ASR_POLL_MS ?? 10_000);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 180,
    ms: Number.isFinite(ms) && ms >= 0 ? ms : 10_000,
  };
}

export function seedStatus(result: HttpResult): { code: string; message: string } {
  return {
    code: result.headers?.["x-api-status-code"] ?? "",
    message: result.headers?.["x-api-message"] ?? "",
  };
}

function secondsOf(record: Record<string, unknown>): { start: number; end: number } | undefined {
  const startMs = record.start_time;
  const endMs = record.end_time;
  if (typeof startMs === "number" && typeof endMs === "number" && Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return { start: startMs / 1000, end: endMs / 1000 };
  }
  const start = record.start;
  const end = record.end;
  if (typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end)) {
    return { start, end };
  }
  return undefined;
}

/** Word timings from a Seed ASR query body. Utterance text is ignored. */
export function wordsFromSeedResult(json: unknown): TimedWord[] {
  const root = asRecord(json);
  const result = asRecord(root?.result) ?? root;
  const collected: TimedWord[] = [];
  const take = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const record = asRecord(item);
      if (record === undefined || typeof record.text !== "string") continue;
      const span = secondsOf(record);
      if (span === undefined || !(span.end > span.start)) continue;
      collected.push({ text: record.text, start: span.start, end: span.end });
    }
  };
  const utterances = result?.utterances;
  if (Array.isArray(utterances)) {
    for (const utterance of utterances) {
      const record = asRecord(utterance);
      if (Array.isArray(record?.words) && record.words.length > 0) take(record.words);
    }
  }
  if (collected.length === 0) take(result?.words);
  return collected;
}

export function seedSubmitBody(audioUrl: string, language: string | undefined, speaker: boolean): Record<string, unknown> {
  return {
    audio: {
      url: audioUrl,
      format: "wav",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: SEED_ASR_MODEL,
      show_utterances: true,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      enable_speaker_info: speaker,
      ...(language === undefined ? {} : { language }),
    },
  };
}

function seedHeaders(taskId: string, apiKey: string | undefined, sequence: boolean): Record<string, string> {
  return {
    "X-Api-Resource-Id": SEED_ASR_RESOURCE,
    "X-Api-Request-Id": taskId,
    ...(sequence ? { "X-Api-Sequence": "-1" } : {}),
    ...(apiKey === undefined ? {} : { "X-Api-Key": apiKey }),
  };
}

export function planSeedAsr(baseUrl: string, speaker: boolean, language: string | undefined): HttpCall[] {
  const submit = jsonCall(
    "POST",
    joinUrl(baseUrl, SEED_SUBMIT_PATH),
    { "X-Api-Resource-Id": SEED_ASR_RESOURCE, "X-Api-Request-Id": "{{task_id}}", "X-Api-Sequence": "-1" },
    seedSubmitBody("{{tos-presigned-get}}", language, speaker),
  );
  const query = jsonCall(
    "POST",
    joinUrl(baseUrl, SEED_QUERY_PATH),
    { "X-Api-Resource-Id": SEED_ASR_RESOURCE, "X-Api-Request-Id": "{{task_id}}" },
    {},
  );
  return [submit, query];
}

export async function extractSpeechWav(ffmpeg: string, video: string, dest: string): Promise<void> {
  await execText(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest], {
    timeout: 180_000,
  });
}

function failStatus(code: string, message: string): CliError {
  const detail = message.length > 0 ? ` ${message}` : "";
  if (code.length === 0) return new CliError("Seed ASR response has no X-Api-Status-Code");
  return new CliError(`Seed ASR ${code}${detail}`.trim());
}

export async function pollSeedAsr(
  calls: HttpCall[],
  baseUrl: string,
  taskId: string,
  apiKey: string,
  opts: SendOptions,
  io: IO,
): Promise<{ result: HttpResult; words: TimedWord[] }> {
  const pollUrl = joinUrl(baseUrl, SEED_QUERY_PATH);
  const limits = seedPollLimits(io.env);
  await flushRemoteTask(io, calls, {
    status: 0,
    contentType: "application/json",
    bytes: 0,
    body: new Uint8Array(),
    json: { task_id: taskId, status: "submitted" },
  }, pollUrl, { provider: "openspeech", taskId, pollUrl });
  let polls = 0;
  let last: HttpResult | undefined;
  while (polls < limits.max) {
    if (polls > 0) await pause(io, limits.ms);
    polls += 1;
    last = await perform(
      calls,
      jsonCall("POST", pollUrl, seedHeaders(taskId, apiKey, false), {}),
      { ...opts, auth: false },
    );
    const status = seedStatus(last);
    if (SEED_ASR_PENDING.has(status.code)) continue;
    if (status.code === SEED_ASR_OK) {
      const words = wordsFromSeedResult(last.json);
      if (words.length === 0) {
        throw new CliError("Seed ASR returned no word timings. Refusing to guess cue times.");
      }
      return { result: last, words };
    }
    throw failStatus(status.code, status.message);
  }
  throw new PendingTaskError(
    `Seed ASR ${taskId} still pending after ${polls} polls`,
    calls,
    last === undefined ? null : publicResult(last),
    "openspeech",
    taskId,
    "pending",
    pollUrl,
  );
}

export interface SeedDraft {
  captions: CaptionFile & { engine: "seed-asr"; pauseGapSec: number; words: TimedWord[]; cues: Array<Cue & { wordFrom: number; wordTo: number }> };
  asr: { engine: "seed-asr"; resource: string; taskId: string; response: unknown; words: TimedWord[] };
  readable: string;
}

/** Clamp cue ends to the picture. Word timings in the sidecar stay as returned. */
export function draftFromWords(input: {
  words: readonly TimedWord[];
  duration: number;
  video: string;
  taskId: string;
  response: unknown;
}): SeedDraft {
  const segmented = segmentWords(input.words);
  const clamped = clampCues(segmented, input.duration);
  if (clamped.cues.length === 0) throw new CliError("no captions left after clamping word cues to the video duration");
  const attached = clamped.cues.map((cue) => {
    const source = segmented.find((item) => item.start === cue.start && item.text === cue.text);
    return { ...cue, wordFrom: source?.wordFrom ?? 0, wordTo: source?.wordTo ?? 0 };
  });
  const captions = {
    format: "lumen.captions@1" as const,
    engine: "seed-asr" as const,
    video: input.video,
    duration: input.duration,
    clamped: clamped.clamped,
    confirmed: false as const,
    script: null,
    pauseGapSec: PAUSE_GAP_SEC,
    words: input.words.map((word) => ({ ...word })),
    cues: attached,
  };
  return {
    captions,
    asr: {
      engine: "seed-asr",
      resource: SEED_ASR_RESOURCE,
      taskId: input.taskId,
      response: input.response,
      words: input.words.map((word) => ({ ...word })),
    },
    readable: toReadable(captions),
  };
}

export async function runSeedAsr(input: {
  binding: ModelBinding;
  video: string;
  ffmpeg: string;
  tos: TosConfig;
  mode: RunMode;
  io: IO;
  apiKey: string | undefined;
  speaker: boolean;
  language: string | undefined;
  duration: number;
}): Promise<{ calls: HttpCall[]; draft?: SeedDraft; taskId?: string }> {
  const language = seedLanguage(input.language);
  const planned = planSeedAsr(input.binding.baseUrl, input.speaker, language);
  requireTosCredentials(input.tos, input.io.env);
  if (input.mode === "dry-run") return { calls: planned };
  if (input.apiKey === undefined || input.apiKey.length === 0) throw new CliError("missing DOUBAO_SPEECH_API_KEY");
  const opts: SendOptions = { mode: "execute", fetchImpl: fetchOf(input.io), auth: false };
  const calls: HttpCall[] = [];
  const taskId = randomUUID();
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-seed-asr-"));
  const wav = path.join(dir, "speech.wav");
  try {
    await extractSpeechWav(input.ffmpeg, input.video, wav);
    const uploaded = await mapLocalMediaViaTos([{ source: wav, kind: "audio" }], input.tos, "execute", input.io, calls);
    const audioUrl = uploaded.urls.get(wav);
    if (audioUrl === undefined) throw new CliError("tos upload did not return an audio url");
    const submitted = await perform(
      calls,
      jsonCall("POST", joinUrl(input.binding.baseUrl, SEED_SUBMIT_PATH), seedHeaders(taskId, input.apiKey, true), seedSubmitBody(audioUrl, language, input.speaker)),
      opts,
    );
    const submitStatus = seedStatus(submitted);
    if (submitStatus.code !== SEED_ASR_OK) throw failStatus(submitStatus.code, submitStatus.message);
    const polled = await pollSeedAsr(calls, input.binding.baseUrl, taskId, input.apiKey, opts, input.io);
    const draft = draftFromWords({
      words: polled.words,
      duration: input.duration,
      video: input.video,
      taskId,
      response: polled.result.json,
    });
    return { calls, draft, taskId };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function resumeSeedAsr(input: {
  binding: ModelBinding;
  taskId: string;
  apiKey: string;
  io: IO;
  calls: HttpCall[];
  duration: number;
  video: string;
}): Promise<SeedDraft> {
  const opts: SendOptions = { mode: "execute", fetchImpl: fetchOf(input.io), auth: false };
  const polled = await pollSeedAsr(input.calls, input.binding.baseUrl, input.taskId, input.apiKey, opts, input.io);
  return draftFromWords({
    words: polled.words,
    duration: input.duration,
    video: input.video,
    taskId: input.taskId,
    response: polled.result.json,
  });
}
