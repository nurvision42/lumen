import { pause, perform, publicResult, TransportError, type HttpCall, type HttpResult, type SendOptions } from "../http.js";
import type { IO } from "../io.js";
import { asRecord } from "../walk.js";

export function jobPollLimits(env: NodeJS.ProcessEnv): { max: number; ms: number } {
  const max = Number(env.SEEDANCE_MAX_POLLS ?? 180);
  const ms = Number(env.SEEDANCE_POLL_MS ?? 10_000);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 180,
    ms: Number.isFinite(ms) && ms >= 0 ? ms : 10_000,
  };
}

export function haomaoTaskId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (typeof record.id === "string" && record.id.length > 0) return record.id;
  if (typeof record.task_id === "string" && record.task_id.length > 0) return record.task_id;
  const data = asRecord(record.data);
  if (typeof data?.id === "string" && data.id.length > 0) return data.id;
  return undefined;
}

const HAOMAO_OK = new Set(["succeeded", "completed", "success"]);
const HAOMAO_FAIL = new Set(["failed", "error", "canceled", "cancelled", "expired"]);
const HAOMAO_PENDING = new Set(["queued", "running", "pending", ""]);

export function haomaoVideoUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  const content = asRecord(record?.content);
  const candidates = [content?.video_url, record?.video_url, content?.url];
  for (const item of candidates) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
  }
  return undefined;
}

export function haomaoTaskState(value: unknown): "pending" | "ok" | "fail" {
  const status = String(asRecord(value)?.status ?? "").toLowerCase();
  if (HAOMAO_OK.has(status)) return "ok";
  if (HAOMAO_FAIL.has(status)) return "fail";
  if (HAOMAO_PENDING.has(status)) return "pending";
  if (haomaoVideoUrl(value) !== undefined) return "ok";
  return "fail";
}

async function until(
  calls: HttpCall[],
  initial: HttpResult,
  nextUrl: string,
  headers: Record<string, string>,
  stateOf: (value: unknown) => "pending" | "ok" | "fail",
  opts: SendOptions,
  io: IO,
  label: string,
): Promise<HttpResult> {
  const limits = jobPollLimits(io.env);
  let current = initial;
  let state = stateOf(current.json);
  let polls = 0;
  while (state === "pending") {
    if (polls >= limits.max) {
      throw new TransportError(`${label} did not finish`, calls, publicResult(current));
    }
    if (polls > 0) await pause(io, limits.ms);
    current = await perform(calls, { method: "GET", url: nextUrl, headers, body: { kind: "empty" } }, opts);
    state = stateOf(current.json);
    polls += 1;
  }
  if (state === "fail") {
    const status = String(asRecord(current.json)?.status ?? "failed");
    throw new TransportError(`${label} ${status}`, calls, publicResult(current));
  }
  return current;
}

export async function awaitHaomaoTask(
  calls: HttpCall[],
  baseUrl: string,
  headers: Record<string, string>,
  initial: HttpResult,
  opts: SendOptions,
  io: IO,
): Promise<{ task: HttpResult; videoUrl?: string }> {
  const id = haomaoTaskId(initial.json);
  if (id === undefined) throw new TransportError("haomao response has no task id", calls, publicResult(initial));
  const root = baseUrl.replace(/\/$/, "");
  const task = await until(
    calls,
    initial,
    `${root}/contents/generations/tasks/${encodeURIComponent(id)}`,
    headers,
    haomaoTaskState,
    opts,
    io,
    `haomao task ${id}`,
  );
  return { task, videoUrl: haomaoVideoUrl(task.json) };
}
