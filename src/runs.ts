import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MODELS, canonicalModel } from "./catalog.js";
import type { ModelBinding } from "./config.js";
import { spawnDetached } from "./detach.js";
import { CliError, errorCode } from "./errors.js";
import { fileExists } from "./fsutil.js";
import type { HttpCall } from "./http.js";
import { TransportError } from "./http.js";
import { PendingTaskError } from "./clients/jobs.js";
import { line, type ImageResultNote, type IO, type RemoteTaskNote } from "./io.js";
import { assertProject } from "./project.js";
import { redactUrl, redactValue } from "./redact.js";
import type { RunMode } from "./flags.js";

/** `lumen runs wait` timed out while the run is still pending or running. */
export const WAIT_STILL_RUNNING = 3;

export interface RunBinding {
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  keyPresent: boolean;
  group?: string;
  modelAlias?: string;
  source?: "project" | "global";
}

export interface RunRecord {
  id: string;
  time: string;
  command: string[];
  modelId: string;
  mode: RunMode;
  status: "dry-run" | "mock" | "ok" | "error" | "running" | "pending";
  binding: RunBinding | null;
  params: unknown;
  calls: unknown;
  response: unknown;
  outputs: string[];
  error?: string;
  pending?: PendingTask;
  resumedAt?: string[];
  /** Detached child, or the foreground pid for an image execute that can be killed mid-request. */
  worker?: WorkerInfo;
  /** Image provider response kept before the file is written, so a killed run can resume the download. */
  image?: ImageAsset;
  /** Set after `runs wait` or `runs show` has read a finished result. */
  claimed?: boolean;
  claimedAt?: string;
  claimedBy?: "wait" | "show";
}

export interface WorkerInfo {
  pid: number;
  log?: string;
  /** Set when the worker process finishes on purpose (success, failure, or poll window). */
  exited?: "clean";
}

export interface ImageAsset {
  provider: string;
  outFile: string;
  url?: string;
  taskId?: string;
  received?: boolean;
}

/**
 * Remote task id for `lumen runs resume <id>`.
 * Written as soon as submit returns, then updated if the poll window ends first.
 */
export interface PendingTask {
  provider: string;
  taskId: string;
  lastStatus: string;
  videoFile: string;
  receipt: string;
  /** GET URL for this task. MediaKit resume polls it; the audit keeps it so the id is not only in an error string. */
  pollUrl?: string;
}

export interface OutputFile {
  path: string;
  bytes?: Uint8Array;
  text?: string;
}

export interface RunCtx {
  params: unknown;
  binding: ModelBinding | null;
  source?: "project" | "global";
  keyPresent: boolean;
  secret?: string;
  calls: HttpCall[];
  response: unknown;
  files: OutputFile[];
  resume?: { videoFile: string; receipt: string };
  image?: ImageAsset;
  /** Installed for commands that can detach. Runs after local checks and before any provider call. */
  afterLocal?: () => Promise<void>;
}

/** Thrown inside a command after the detached child has been spawned. Not a failure. */
export class DetachedSignal extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`detached ${runId}`);
    this.name = "DetachedSignal";
    this.runId = runId;
  }
}

export function isImageModel(modelId: string): boolean {
  try {
    return (IMAGE_MODELS as readonly string[]).includes(canonicalModel(modelId));
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

export function detachedWorkerArgs(command: string[], project: string): string[] {
  const args: string[] = [];
  for (const arg of command) {
    if (arg === "--detach" || arg === "--detach=true" || arg.startsWith("--detach=")) continue;
    args.push(arg);
  }
  args.push("--project", project);
  return args;
}

export function resumeHint(id: string): string {
  return `still running on the server; resume with: lumen runs resume ${id}`;
}

export function createRunId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function publicBinding(ctx: RunCtx): RunBinding | null {
  if (ctx.binding === null) return null;
  return {
    provider: ctx.binding.provider,
    baseUrl: ctx.binding.baseUrl,
    apiKeyEnv: ctx.binding.apiKeyEnv,
    keyPresent: ctx.keyPresent,
    ...(ctx.binding.group === undefined ? {} : { group: ctx.binding.group }),
    ...(ctx.binding.modelAlias === undefined ? {} : { modelAlias: ctx.binding.modelAlias }),
    ...(ctx.source === undefined ? {} : { source: ctx.source }),
  };
}

function render(record: RunRecord): string {
  const binding = record.binding;
  const lines = [
    `# run ${record.id}`,
    "",
    `- time: ${record.time}`,
    `- command: \`${record.command.join(" ")}\``,
    `- model: ${record.modelId}`,
    `- mode: ${record.mode}`,
    `- status: ${record.status}`,
  ];
  if (binding === null) lines.push("- binding: none");
  else {
    lines.push(`- provider: ${binding.provider}`);
    lines.push(`- baseUrl: ${binding.baseUrl}`);
    lines.push(`- apiKeyEnv: ${binding.apiKeyEnv}`);
    lines.push(`- keyPresent: ${binding.keyPresent}`);
    if (binding.group !== undefined) lines.push(`- group: ${binding.group}`);
    if (binding.modelAlias !== undefined) lines.push(`- modelAlias: ${binding.modelAlias}`);
  }
  if (record.pending !== undefined) {
    lines.push(`- task: ${record.pending.provider} ${record.pending.taskId} (${record.pending.lastStatus})`);
    if (record.pending.pollUrl !== undefined) lines.push(`- poll: ${record.pending.pollUrl}`);
    lines.push(`- resume: lumen runs resume ${record.id}`);
  }
  if (record.worker !== undefined) {
    lines.push(`- pid: ${record.worker.pid}`);
    if (record.worker.log !== undefined) lines.push(`- log: ${record.worker.log}`);
    if (record.worker.exited !== undefined) lines.push(`- worker: ${record.worker.exited}`);
  }
  if (record.image !== undefined) {
    lines.push(`- image: ${record.image.outFile}`);
    if (record.image.url !== undefined) lines.push(`- imageUrl: ${record.image.url}`);
    if (record.image.taskId !== undefined) lines.push(`- imageTask: ${record.image.taskId}`);
  }
  if (record.claimed === true) lines.push(`- claimed: ${record.claimedBy ?? "yes"} ${record.claimedAt ?? ""}`.trim());
  lines.push("", "## params", "", "```json", JSON.stringify(record.params, null, 2), "```");
  lines.push("", "## calls", "", "```json", JSON.stringify(record.calls, null, 2), "```");
  lines.push("", "## response", "", "```json", JSON.stringify(record.response, null, 2), "```");
  lines.push("", "## outputs", "");
  if (record.outputs.length === 0) lines.push("(none)");
  else for (const output of record.outputs) lines.push(`- ${output}`);
  if (record.error !== undefined) lines.push("", "## error", "", record.error);
  lines.push("");
  return lines.join("\n");
}

export function runDir(project: string, id: string): string {
  return path.join(project, ".lumen", "runs", id);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

async function readRecordFile(file: string): Promise<RunRecord | undefined> {
  if (!(await fileExists(file))) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as RunRecord;
}

async function withRunLock<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, ".lock");
  const start = Date.now();
  let handle: FileHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lock, "wx");
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 5_000) await unlink(lock);
      } catch {
        // another writer took or released the lock
      }
      if (Date.now() - start > 15_000) throw new CliError(`run lock busy: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await body();
  } finally {
    await handle.close();
    await unlink(lock).catch(() => {});
  }
}

function mergeRecord(prev: RunRecord | undefined, record: RunRecord, sealWorker: boolean): RunRecord {
  const next: RunRecord = { ...record };
  if (prev === undefined) {
    if (sealWorker && next.worker !== undefined) next.worker = { ...next.worker, exited: "clean" };
    return next;
  }
  if (next.worker !== undefined || prev.worker !== undefined || sealWorker) {
    const worker = { ...prev.worker, ...defined(next.worker) };
    if (sealWorker && typeof worker.pid === "number") worker.exited = "clean";
    if (typeof worker.pid === "number") next.worker = worker as WorkerInfo;
  }
  if (next.image !== undefined || prev.image !== undefined) {
    next.image = { ...prev.image, ...defined(next.image) } as ImageAsset;
  }
  if (next.claimed === undefined && prev.claimed === true) {
    next.claimed = true;
    next.claimedAt = prev.claimedAt;
    next.claimedBy = prev.claimedBy;
  }
  if (next.resumedAt === undefined && prev.resumedAt !== undefined) next.resumedAt = prev.resumedAt;
  return next;
}

async function persistRecord(dir: string, record: RunRecord, secrets: readonly string[]): Promise<void> {
  const safe = redactValue(record, secrets) as RunRecord;
  const body = `${JSON.stringify(safe, null, 2)}\n`;
  // JSON first: resume and list read it. The markdown sidecar follows for `runs show`.
  await writeAtomic(path.join(dir, "record.json"), body);
  await writeAtomic(path.join(dir, "record.md"), render(safe));
}

export async function writeRun(
  project: string,
  record: RunRecord,
  secrets: readonly string[],
  options?: { sealWorker?: boolean },
): Promise<void> {
  const dir = runDir(project, record.id);
  await mkdir(dir, { recursive: true });
  await withRunLock(dir, async () => {
    const prev = await readRecordFile(path.join(dir, "record.json"));
    const merged = mergeRecord(prev, record, options?.sealWorker === true);
    await persistRecord(dir, merged, secrets);
  });
}

export async function updateRun(
  project: string,
  id: string,
  mutate: (record: RunRecord) => void,
  secrets: readonly string[] = [],
): Promise<void> {
  const dir = runDir(project, id);
  await mkdir(dir, { recursive: true });
  await withRunLock(dir, async () => {
    const record = await readRecordFile(path.join(dir, "record.json"));
    if (record === undefined) throw new CliError(`no run ${id}`);
    mutate(record);
    await persistRecord(dir, record, secrets);
  });
}

export async function claimRun(project: string, id: string, by: "wait" | "show", at: string): Promise<void> {
  await updateRun(project, id, (record) => {
    if (record.claimed === true) return;
    record.claimed = true;
    record.claimedBy = by;
    record.claimedAt = at;
  });
}

export function isUnclaimed(record: RunRecord): boolean {
  if (record.status === "pending" || record.status === "running") return true;
  if (record.claimed === true) return false;
  if (record.mode === "dry-run") return false;
  return record.status === "ok" || record.status === "error" || record.status === "mock";
}

export async function outputsOnDisk(record: RunRecord): Promise<string[]> {
  const candidates: string[] = [];
  for (const file of record.outputs) if (!candidates.includes(file)) candidates.push(file);
  if (record.image?.outFile !== undefined && !candidates.includes(record.image.outFile)) candidates.push(record.image.outFile);
  const found: string[] = [];
  for (const file of candidates) if (await fileExists(file)) found.push(file);
  return found;
}

/** Live Chinese notes for `runs show` and a timed-out `runs wait`. The stored markdown is not rewritten. */
export function explainRun(record: RunRecord, filesOnDisk: readonly string[]): string[] {
  const lines: string[] = [];
  const inflight = record.status === "pending" || record.status === "running";
  const imageLike = record.image !== undefined || isImageModel(record.modelId);
  if (!inflight && !imageLike && record.worker === undefined && record.claimed !== true) return lines;

  lines.push("## 状态说明");
  if (record.claimed === true) lines.push("已取走。");
  if (imageLike) {
    const pics = filesOnDisk.filter((file) => file === record.image?.outFile || record.outputs.includes(file));
    if (pics.length > 0) {
      for (const file of pics) lines.push(`已出图：${file}`);
    } else if (inflight || record.status === "error") {
      lines.push("没有本地图像。");
    } else if (record.outputs.length > 0) {
      for (const file of record.outputs) lines.push(`已出图：${file}`);
    }
  } else if (filesOnDisk.length > 0 && (record.status === "ok" || record.status === "mock")) {
    for (const file of filesOnDisk) lines.push(`本地结果：${file}`);
  }

  if (!inflight) {
    if (record.status === "error" && record.error !== undefined) lines.push(`失败：${record.error}`);
    if (filesOnDisk.length === 0 && record.image?.url !== undefined && record.status !== "ok") {
      lines.push("服务商返回过结果 URL。");
      lines.push(`lumen runs resume ${record.id} 只下载该地址。不要重新提交。`);
    } else if (filesOnDisk.length === 0 && record.image?.taskId !== undefined && record.status !== "ok") {
      if (record.image.provider === "yir" || record.pending?.provider === "yir") {
        lines.push(`服务商返回过任务 ${record.image.taskId}。`);
        lines.push(`lumen runs resume ${record.id} 继续同一个任务，不要重新提交。`);
      } else {
        lines.push(
          `服务商返回过任务 ${record.image.taskId}，但 ${record.image.provider} 的出图接口不能续查。不能 resume。不要重新提交。`,
        );
      }
    } else if (filesOnDisk.length === 0 && record.pending?.provider === "yir" && record.status !== "ok") {
      lines.push(`服务商返回过任务 ${record.pending.taskId}。`);
      lines.push(`lumen runs resume ${record.id} 继续同一个任务，不要重新提交。`);
    }
    return lines;
  }

  const pid = record.worker?.pid;
  if (pid !== undefined && pidAlive(pid)) {
    lines.push(`仍在生成（pid ${pid}）。`);
    lines.push(`下一步: lumen runs wait ${record.id}`);
    return lines;
  }
  if (pid !== undefined) lines.push(`已中断（pid ${pid} 已不在，状态仍是 ${record.status}）。`);
  else lines.push(`状态仍是 ${record.status}，记录里没有 pid。`);

  if (record.pending !== undefined) {
    if (record.worker?.exited === "clean") lines.push("本机轮询已结束，服务端任务还在。");
    lines.push(`服务端任务还在：${record.pending.provider} ${record.pending.taskId}。`);
    lines.push(`lumen runs resume ${record.id} 继续同一个任务，不要重新提交。`);
    return lines;
  }
  if (record.image?.url !== undefined) {
    lines.push("服务商返回过结果 URL。");
    lines.push(`lumen runs resume ${record.id} 只下载该地址。不要重新提交。`);
    return lines;
  }
  if (record.image?.taskId !== undefined) {
    if (record.image.provider === "yir") {
      lines.push(`服务商返回过任务 ${record.image.taskId}。`);
      lines.push(`lumen runs resume ${record.id} 继续同一个任务，不要重新提交。`);
    } else {
      lines.push(
        `服务商返回过任务 ${record.image.taskId}，但 ${record.image.provider} 的出图接口不能续查。不能 resume。不要重新提交。`,
      );
    }
    return lines;
  }
  if (imageLike) {
    lines.push("没有任务 id，也没有结果 URL。不能 resume。不要重新提交。");
    return lines;
  }
  lines.push("没有可续的服务端任务。不要重新提交。");
  return lines;
}

export async function startDetached(input: { project: string; id: string; args: string[]; io: IO }): Promise<void> {
  const dir = runDir(input.project, input.id);
  await mkdir(dir, { recursive: true });
  const logFile = path.join(dir, "worker.log");
  const spawn = input.io.spawnDetached ?? spawnDetached;
  let spawned: { pid: number };
  try {
    spawned = spawn({
      args: input.args,
      cwd: input.io.cwd,
      env: { ...input.io.env, LUMEN_DETACH_WORKER: input.id },
      logFile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(input.project, input.id, (record) => {
      record.status = "error";
      record.error = message;
    });
    throw err instanceof CliError ? err : new CliError(message);
  }
  await updateRun(input.project, input.id, (record) => {
    if (record.worker?.exited === "clean" && (record.status === "ok" || record.status === "error" || record.status === "mock")) {
      return;
    }
    const worker: WorkerInfo = { ...record.worker, pid: spawned.pid, log: logFile };
    delete worker.exited;
    record.worker = worker;
  });
  line(input.io, `run: ${input.id}`);
  line(input.io, `pid: ${spawned.pid}`);
  line(input.io, `下一步: lumen runs wait ${input.id}`);
}

export interface SettleOptions {
  /** Spawn a detached worker after local checks. Requires --execute or --mock. */
  detach?: boolean;
}

export async function settle(
  io: IO,
  project: string,
  command: string[],
  modelId: string,
  mode: RunMode,
  work: (runId: string, ctx: RunCtx) => Promise<void>,
  options?: SettleOptions,
): Promise<number> {
  await assertProject(project);
  const date = io.now?.() ?? new Date();
  const workerId = io.env.LUMEN_DETACH_WORKER?.trim() || undefined;
  const detach = options?.detach === true && workerId === undefined && mode !== "dry-run";
  const id = workerId !== undefined && workerId.length > 0 ? workerId : createRunId(date);
  let startedAt = date.toISOString();
  let recordedCommand = command;
  if (workerId !== undefined) {
    const prior = await readRecordFile(path.join(runDir(project, id), "record.json"));
    if (prior !== undefined) {
      startedAt = prior.time;
      recordedCommand = prior.command;
    }
  }
  const ctx: RunCtx = {
    params: {},
    binding: null,
    keyPresent: false,
    calls: [],
    response: null,
    files: [],
  };
  let status: RunRecord["status"] = "error";
  let error: string | undefined;
  let thrown: unknown;
  let pending: PendingTask | undefined;
  let accepted: PendingTask | undefined;
  let handedOff = false;
  const previousNote = io.noteRemoteTask;
  const previousImage = io.noteImageResult;
  const secrets = (): string[] => (ctx.secret === undefined ? [] : [ctx.secret]);
  const snapshot = (
    nextStatus: RunRecord["status"],
    extra?: { pending?: PendingTask; error?: string; outputs?: string[]; workerPid?: number },
  ): RunRecord => ({
    id,
    time: startedAt,
    command: recordedCommand,
    modelId,
    mode,
    status: nextStatus,
    binding: publicBinding(ctx),
    params: ctx.params,
    calls: ctx.calls,
    response: ctx.response,
    outputs: extra?.outputs ?? [],
    ...(extra?.error === undefined ? {} : { error: extra.error }),
    ...(extra?.pending === undefined ? {} : { pending: extra.pending }),
    ...(ctx.image === undefined ? {} : { image: ctx.image }),
    ...(extra?.workerPid === undefined ? {} : { worker: { pid: extra.workerPid } }),
  });
  io.noteRemoteTask = async (note: RemoteTaskNote) => {
    if (note.taskId.length === 0) return;
    const task: PendingTask = {
      provider: note.provider,
      taskId: note.taskId,
      lastStatus: note.lastStatus,
      videoFile: ctx.resume?.videoFile ?? "",
      receipt: ctx.resume?.receipt ?? "",
      ...(note.pollUrl === undefined ? {} : { pollUrl: note.pollUrl }),
    };
    accepted = task;
    if (Array.isArray(note.calls)) ctx.calls = note.calls as HttpCall[];
    ctx.response = note.response;
    await writeRun(project, snapshot("running", { pending: task }), secrets());
  };
  io.noteImageResult = async (note: ImageResultNote) => {
    ctx.image = {
      provider: note.provider,
      outFile: note.outFile,
      ...(ctx.image?.url !== undefined && note.url === undefined ? { url: ctx.image.url } : {}),
      ...(ctx.image?.taskId !== undefined && note.taskId === undefined ? { taskId: ctx.image.taskId } : {}),
      ...(note.url === undefined ? {} : { url: note.url }),
      ...(note.taskId === undefined ? {} : { taskId: note.taskId }),
      ...(note.received === undefined ? {} : { received: note.received }),
    };
    if (note.response !== undefined) ctx.response = note.response;
    if (note.url !== undefined) {
      const file = path.join(runDir(project, id), "image-url.txt");
      await mkdir(runDir(project, id), { recursive: true });
      await writeFile(file, note.url, { mode: 0o600 });
    }
    if (mode === "execute") await writeRun(project, snapshot("pending"), secrets());
  };
  ctx.afterLocal = async () => {
    if (detach) {
      await writeRun(project, snapshot("pending"), secrets());
      await startDetached({ project, id, args: detachedWorkerArgs(recordedCommand, project), io });
      throw new DetachedSignal(id);
    }
    if (mode === "execute" && ctx.image !== undefined) {
      await writeRun(project, snapshot("pending", { workerPid: process.pid }), secrets());
    }
  };
  try {
    // Test hook: the detached child pauses before any provider call so a parent exit can be observed.
    const holdMs = Number(io.env.LUMEN_DETACH_HOLD_MS ?? "");
    if (workerId !== undefined && Number.isFinite(holdMs) && holdMs > 0) {
      if (io.sleep) await io.sleep(holdMs);
      else await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
    try {
      await work(id, ctx);
      status = mode === "dry-run" ? "dry-run" : mode === "mock" ? "mock" : "ok";
    } catch (err) {
      if (err instanceof DetachedSignal) {
        handedOff = true;
      } else if (err instanceof CliError && err.exitCode === 2) {
        throw err;
      } else if (err instanceof PendingTaskError && mode === "execute" && (ctx.resume !== undefined || ctx.image !== undefined)) {
        status = "running";
        pending = {
          provider: err.provider,
          taskId: err.taskId,
          lastStatus: err.lastStatus,
          videoFile: ctx.resume?.videoFile ?? ctx.image?.outFile ?? "",
          receipt: ctx.resume?.receipt ?? "",
          ...(err.pollUrl === undefined ? {} : { pollUrl: err.pollUrl }),
        };
        ctx.calls = err.calls;
        ctx.response = err.response ?? ctx.response;
      } else {
        thrown = err;
        error = err instanceof Error ? err.message : String(err);
        if (err instanceof TransportError) {
          ctx.calls = err.calls;
          ctx.response = err.response ?? ctx.response;
        }
        // A later failure must not wipe the id that submit already flushed.
        if (accepted !== undefined) pending = accepted;
      }
    }

    if (handedOff) return 0;

    const outputs: string[] = [];
    if (thrown === undefined && pending === undefined && mode === "execute") {
      for (const file of ctx.files) {
        await mkdir(path.dirname(file.path), { recursive: true });
        if (file.bytes !== undefined) await writeFile(file.path, file.bytes);
        else if (file.text !== undefined) await writeFile(file.path, file.text);
        outputs.push(file.path);
      }
    }

    const record = snapshot(status, {
      outputs,
      ...(error === undefined ? {} : { error }),
      ...(pending === undefined ? {} : { pending }),
    });
    await writeRun(project, record, secrets(), { sealWorker: true });

    if (thrown !== undefined) {
      const message = error ?? "failed";
      const withRun = message.includes(`run: ${id}`) ? message : `${message}\nrun: ${id}`;
      const code = thrown instanceof CliError ? thrown.exitCode : 1;
      throw new CliError(withRun, code);
    }

    line(io, `${status} ${modelId}`);
    line(io, `run: ${id}`);
    if (pending !== undefined) {
      line(io, `task: ${pending.provider} ${pending.taskId} (${pending.lastStatus})`);
      if (pending.pollUrl !== undefined) line(io, `poll: ${redactUrl(pending.pollUrl)}`);
      line(io, resumeHint(id));
    }
    for (const call of ctx.calls) line(io, `${call.method} ${redactUrl(call.url)}`);
    for (const output of outputs) line(io, `wrote: ${output}`);
    line(io, `audit: ${path.join(runDir(project, id), "record.json")}`);
    return 0;
  } finally {
    if (previousNote === undefined) delete io.noteRemoteTask;
    else io.noteRemoteTask = previousNote;
    if (previousImage === undefined) delete io.noteImageResult;
    else io.noteImageResult = previousImage;
    delete ctx.afterLocal;
  }
}

export async function listRunRecords(project: string): Promise<RunRecord[]> {
  const dir = path.join(project, ".lumen", "runs");
  if (!(await fileExists(dir))) return [];
  const names = await readdir(dir);
  const records: RunRecord[] = [];
  for (const name of names) {
    const file = path.join(dir, name, "record.json");
    if (!(await fileExists(file))) continue;
    records.push(JSON.parse(await readFile(file, "utf8")) as RunRecord);
  }
  records.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return records;
}

export async function readRunMarkdown(project: string, id: string): Promise<string> {
  const file = path.join(runDir(project, id), "record.md");
  if (!(await fileExists(file))) throw new CliError(`no run ${id}`);
  return readFile(file, "utf8");
}

export async function readRunRecord(project: string, id: string): Promise<RunRecord> {
  const file = path.join(runDir(project, id), "record.json");
  if (!(await fileExists(file))) throw new CliError(`no run ${id}`);
  return JSON.parse(await readFile(file, "utf8")) as RunRecord;
}
