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

/** Default window is 180 x 10s = 30 min; overrides are floored to 10 min unless polling is instant (tests). */
function effectiveMaxPolls(limits: { max: number; ms: number }): number {
  if (limits.ms <= 0) return limits.max;
  return Math.max(limits.max, Math.ceil(MIN_POLL_WINDOW_MS / limits.ms));
}

function transient(err: unknown): boolean {
  if (!(err instanceof TransportError)) return true;
  const status = asRecord(err.response)?.status;
  if (typeof status !== "number") return true; // network error / timeout
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
export const MIN_POLL_WINDOW_MS = 10 * 60_000;
const TRANSIENT_RETRIES = 6;

/** Thrown when a remote task is still running after the poll window. Not a failure. */
export class PendingTaskError extends TransportError {
  readonly taskId: string;
  readonly provider: string;
  readonly lastStatus: string;
  readonly pollUrl?: string;
  constructor(
    message: string,
    calls: HttpCall[],
    response: unknown,
    provider: string,
    taskId: string,
    lastStatus: string,
    pollUrl?: string,
  ) {
    super(message, calls, response);
    this.name = "PendingTaskError";
    this.provider = provider;
    this.taskId = taskId;
    this.lastStatus = lastStatus;
    this.pollUrl = pollUrl;
  }
}

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
  if (haomaoVideoUrl(value) !== undefined) return "ok";
  // queued, pending, running, processing, in_progress, submitted, unknown: keep polling
  return "pending";
}

export async function awaitTask(
  calls: HttpCall[],
  initial: HttpResult,
  nextUrl: string,
  headers: Record<string, string>,
  stateOf: (value: unknown) => "pending" | "ok" | "fail",
  opts: SendOptions,
  io: IO,
  label: string,
  pending: { provider: string; taskId: string; pollUrl?: string },
  /** When set, these limits are used as-is. Callers that need a minimum window apply it first. */
  budget?: { max: number; ms: number },
): Promise<HttpResult> {
  const limits = budget ?? jobPollLimits(io.env);
  const max = budget === undefined ? effectiveMaxPolls(limits) : limits.max;
  let current = initial;
  let state = stateOf(current.json);
  let polls = 0;
  let failures = 0;
  // The provider has already accepted the task (and may have charged). Flush the id
  // before any poll or download so a kill mid-wait still leaves a resumable record.
  await flushRemoteTask(io, calls, initial, nextUrl, pending);
  while (state === "pending") {
    if (polls >= max) {
      const last = String(asRecord(current.json)?.status ?? "unknown");
      throw new PendingTaskError(
        `${label} still ${last} after ${polls} polls`,
        calls,
        publicResult(current),
        pending.provider,
        pending.taskId,
        last,
        pending.pollUrl ?? nextUrl,
      );
    }
    if (polls > 0) await pause(io, limits.ms);
    polls += 1;
    try {
      current = await perform(calls, { method: "GET", url: nextUrl, headers, body: { kind: "empty" } }, opts);
      failures = 0;
    } catch (err) {
      if (!transient(err) || failures >= TRANSIENT_RETRIES) throw err;
      failures += 1;
      continue;
    }
    state = stateOf(current.json);
  }
  if (state === "fail") {
    const status = String(asRecord(current.json)?.status ?? "failed");
    throw new TransportError(`${label} ${status}`, calls, publicResult(current));
  }
  return current;
}

function notedStatus(value: unknown): string {
  const status = asRecord(value)?.status;
  return typeof status === "string" && status.length > 0 ? status : "submitted";
}

/** Persist the remote id before the poll loop. No-op when no run recorder is installed (resume). */
export async function flushRemoteTask(
  io: IO,
  calls: HttpCall[],
  initial: HttpResult,
  nextUrl: string,
  pending: { provider: string; taskId: string; pollUrl?: string },
): Promise<void> {
  if (io.noteRemoteTask === undefined || pending.taskId.length === 0) return;
  await io.noteRemoteTask({
    provider: pending.provider,
    taskId: pending.taskId,
    lastStatus: notedStatus(initial.json),
    pollUrl: pending.pollUrl ?? nextUrl,
    calls,
    response: publicResult(initial),
  });
}

export async function awaitHaomaoTask(
  calls: HttpCall[],
  baseUrl: string,
  headers: Record<string, string>,
  initial: HttpResult,
  opts: SendOptions,
  io: IO,
  knownId?: string,
): Promise<{ task: HttpResult; videoUrl?: string }> {
  const id = haomaoTaskId(initial.json) ?? knownId;
  if (id === undefined) throw new TransportError("haomao response has no task id", calls, publicResult(initial));
  const root = baseUrl.replace(/\/$/, "");
  const task = await awaitTask(
    calls,
    initial,
    `${root}/contents/generations/tasks/${encodeURIComponent(id)}`,
    headers,
    haomaoTaskState,
    opts,
    io,
    `haomao task ${id}`,
    { provider: "haomao", taskId: id },
  );
  return { task, videoUrl: haomaoVideoUrl(task.json) };
}
