import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finishHaomaoVideo } from "../clients/seedance.js";
import { finishBeeftvVideo } from "../clients/beeftv.js";
import { finishYcyapiVideo } from "../clients/ycyapi.js";
import { finishYirImage, yirJobId } from "../clients/yir.js";
import { pollMediakitTask, publishedMediakit } from "../clients/mediakit.js";
import { resumeSeedAsr } from "../clients/seedasr.js";
import { asRecord } from "../walk.js";
import { PendingTaskError } from "../clients/jobs.js";
import { bytesFromResult } from "../clients/wire.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { fetchOf, joinUrl, perform, TransportError, type HttpCall, type SendOptions } from "../http.js";
import { line, type IO } from "../io.js";
import { LAYOUT, outputPath } from "../project.js";
import { redactUrl } from "../redact.js";
import {
  isImageModel,
  pidAlive,
  readRunRecord,
  resumeHint,
  runDir,
  startDetached,
  writeRun,
  type OutputFile,
  type PendingTask,
  type RunRecord,
} from "../runs.js";
import { materializeBreakdown } from "./breakdown.js";
import { materializeEnhance } from "./enhance.js";

const ENHANCE_MODELS = new Set(["enhance-video", "enhance-video-generative"]);

function flagAfter(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index >= 0 ? command[index + 1] : undefined;
}

function positiveShot(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return undefined;
  return Number(value);
}

function mediakitPending(record: RunRecord, project: string, overrides: { out?: string }, taskId: string): PendingTask {
  const commandOut = flagAfter(record.command, "--out");
  const shot = positiveShot(flagAfter(record.command, "--shot"));
  const chosenOut = overrides.out ?? (record.pending === undefined ? commandOut : undefined);
  let videoFile: string;
  let receipt: string;
  if (record.pending !== undefined && overrides.out === undefined) {
    videoFile = record.pending.videoFile;
    receipt = record.pending.receipt;
  } else if (ENHANCE_MODELS.has(record.modelId)) {
    videoFile = outputPath(project, {
      folder: "clip",
      filename: `enhance-${record.id}.mp4`,
      ...(shot === undefined ? {} : { shot }),
      ...(chosenOut === undefined ? {} : { out: chosenOut }),
    });
    receipt = record.pending?.receipt ?? path.join(project, LAYOUT.refs, `${record.id}.enhance.json`);
  } else {
    const understand = path.join(project, LAYOUT.refs, `${record.id}.video-understand.json`);
    videoFile = overrides.out !== undefined ? path.resolve(project, overrides.out) : (record.pending?.videoFile ?? understand);
    receipt = record.pending?.receipt ?? understand;
  }
  const pollUrl =
    record.pending?.pollUrl ??
    (record.binding === null ? undefined : joinUrl(record.binding.baseUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}`));
  return {
    provider: "mediakit",
    taskId,
    lastStatus: record.pending?.lastStatus ?? "unknown",
    videoFile,
    receipt,
    ...(pollUrl === undefined ? {} : { pollUrl }),
  };
}

/** Older runs recorded a still-processing task as an error; recover the id from that message. */
function derivePending(record: RunRecord, project: string, overrides: { task?: string; out?: string }): PendingTask | undefined {
  const mediakitFromError = /MediaKit task (\S+)/.exec(record.error ?? "")?.[1];
  const seedanceFromError = /(?:haomao|beeftv|ycyapi) task (\S+)/.exec(record.error ?? "")?.[1];
  const taskId = overrides.task ?? record.pending?.taskId ?? seedanceFromError ?? mediakitFromError;
  if (taskId === undefined) return undefined;
  const provider =
    record.pending?.provider ??
    record.binding?.provider ??
    (mediakitFromError !== undefined && seedanceFromError === undefined ? "mediakit" : "haomao");
  if (provider === "mediakit") return mediakitPending(record, project, overrides, taskId);
  const out = overrides.out ?? flagAfter(record.command, "--out");
  const videoFile =
    overrides.out !== undefined || record.pending === undefined
      ? outputPath(project, { folder: "clip", filename: `${record.id}.mp4`, ...(out === undefined ? {} : { out }) })
      : record.pending.videoFile;
  return {
    provider,
    taskId,
    lastStatus: record.pending?.lastStatus ?? "unknown",
    videoFile,
    receipt: `${videoFile.replace(/\.mp4$/i, "")}.seedance.json`,
    ...(record.pending?.pollUrl === undefined ? {} : { pollUrl: record.pending.pollUrl }),
  };
}

async function resumeSeedance(
  pending: PendingTask,
  baseUrl: string,
  calls: HttpCall[],
  opts: SendOptions,
  io: IO,
): Promise<{ response: unknown; files: OutputFile[] }> {
  const first = await perform(
    calls,
    {
      method: "GET",
      url: joinUrl(
        baseUrl,
        pending.provider === "beeftv" || pending.provider === "ycyapi"
          ? `/v1/videos/${encodeURIComponent(pending.taskId)}`
          : `/contents/generations/tasks/${encodeURIComponent(pending.taskId)}`,
      ),
      headers: {},
      body: { kind: "empty" },
    },
    opts,
  );
  const finish =
    pending.provider === "beeftv"
      ? finishBeeftvVideo
      : pending.provider === "ycyapi"
        ? finishYcyapiVideo
        : finishHaomaoVideo;
  return finish(
    calls,
    baseUrl,
    first,
    opts,
    io,
    "execute",
    pending.videoFile,
    pending.receipt,
    pending.taskId,
  );
}

/** Breakdown defaults to need_audio. Enhance and other tools do not. */
function understandNeedAudio(record: RunRecord): boolean | undefined {
  if (record.modelId !== "video-understand-router") return undefined;
  const params = record.params;
  if (params !== null && typeof params === "object" && !Array.isArray(params) && "needAudio" in params) {
    const need = (params as { needAudio?: unknown }).needAudio;
    if (typeof need === "boolean") return need;
  }
  return true;
}

async function resumeMediakit(
  project: string,
  record: RunRecord,
  pending: PendingTask,
  calls: HttpCall[],
  opts: SendOptions,
  io: IO,
): Promise<{ response: unknown; files: OutputFile[] }> {
  const binding = record.binding;
  if (binding === null) throw new CliError(`run ${record.id} has no provider binding`, 2);
  const task = await pollMediakitTask(calls, binding.baseUrl, pending.taskId, opts, io, understandNeedAudio(record));
  const result = publishedMediakit(task);
  if (record.modelId === "video-understand-router") {
    return { response: result.response, files: await materializeBreakdown(project, record.id, result.task) };
  }
  if (result.videoUrl === undefined) return { response: result.response, files: [] };
  return {
    response: result.response,
    files: await materializeEnhance(result.videoUrl, calls, io, project, { videoFile: pending.videoFile, receipt: pending.receipt }),
  };
}

async function resumeOpenspeech(
  record: RunRecord,
  pending: PendingTask,
  binding: NonNullable<RunRecord["binding"]>,
  apiKey: string,
  calls: HttpCall[],
  io: IO,
): Promise<{ response: unknown; files: OutputFile[] }> {
  const params = asRecord(record.params);
  const duration = typeof params?.duration === "number" ? params.duration : undefined;
  const video = typeof params?.video === "string" ? params.video : pending.videoFile;
  if (duration === undefined || !(duration > 0)) {
    throw new CliError(`run ${record.id} has no probed duration. Refusing to invent cue times.`);
  }
  const draft = await resumeSeedAsr({
    binding,
    taskId: pending.taskId,
    apiKey,
    io,
    calls,
    duration,
    video,
  });
  const jsonPath = pending.videoFile.length > 0 ? pending.videoFile : path.join(record.id, "captions.json");
  const asrPath = pending.receipt.length > 0 ? pending.receipt : `${jsonPath}.asr.json`;
  const txtPath = jsonPath.replace(/\.json$/i, ".txt");
  return {
    response: draft.captions,
    files: [
      { path: jsonPath, text: `${JSON.stringify(draft.captions, null, 2)}\n` },
      { path: txtPath, text: draft.readable },
      { path: asrPath, text: `${JSON.stringify(draft.asr, null, 2)}\n` },
    ],
  };
}

function imageRun(record: RunRecord): boolean {
  return record.image !== undefined || isImageModel(record.modelId);
}

async function rawImageUrl(project: string, record: RunRecord): Promise<string | undefined> {
  const side = path.join(runDir(project, record.id), "image-url.txt");
  if (await fileExists(side)) {
    const text = (await readFile(side, "utf8")).trim();
    if (text.length > 0) return text;
  }
  return record.image?.url;
}

function yirImageTaskId(record: RunRecord): string | undefined {
  if (record.pending?.provider === "yir" && record.pending.taskId.length > 0) return record.pending.taskId;
  if (record.image?.provider === "yir" && record.image.taskId !== undefined && record.image.taskId.length > 0) {
    return record.image.taskId;
  }
  if (record.binding?.provider === "yir" && record.image?.taskId !== undefined && record.image.taskId.length > 0) {
    return record.image.taskId;
  }
  return undefined;
}

function imageBlocked(record: RunRecord): string | undefined {
  const taskId = record.image?.taskId ?? record.pending?.taskId;
  if (record.image?.url !== undefined) return undefined;
  if (yirImageTaskId(record) !== undefined) return undefined;
  if (taskId !== undefined) {
    return `run ${record.id} 的出图有任务 ${taskId}，但 ${record.image?.provider ?? record.pending?.provider ?? "该供应商"} 的出图接口不能续查。不能 resume。不要重新提交。`;
  }
  return `run ${record.id} 没有出图，也没有结果 URL 或任务 id。不能 resume。不要重新提交。`;
}

async function finishImageFile(project: string, record: RunRecord, outFile: string, io: IO): Promise<number> {
  const now = (io.now?.() ?? new Date()).toISOString();
  const next: RunRecord = {
    ...record,
    status: "ok",
    outputs: [outFile],
    resumedAt: [...(record.resumedAt ?? []), now],
  };
  delete next.pending;
  delete next.error;
  if (next.worker !== undefined) next.worker = { ...next.worker, exited: "clean" };
  await writeRun(project, next, []);
  line(io, `ok ${record.modelId}`);
  line(io, `run: ${record.id}`);
  line(io, `wrote: ${outFile}`);
  return 0;
}

/** Download a saved image URL, or refuse. Never submits a new image request. */
async function resumeImage(
  project: string,
  record: RunRecord,
  io: IO,
  detach: boolean,
): Promise<number> {
  const id = record.id;
  const inflight = record.status === "pending" || record.status === "running";
  if (inflight && record.worker?.pid !== undefined && pidAlive(record.worker.pid) && record.worker.exited !== "clean") {
    line(io, `仍在生成（pid ${record.worker.pid}）`);
    line(io, `下一步: lumen runs wait ${id}`);
    return 0;
  }
  const outFile = record.image?.outFile;
  const url = await rawImageUrl(project, record);
  const onDisk = outFile !== undefined && (await fileExists(outFile));
  if (detach && io.env.LUMEN_DETACH_WORKER === undefined) {
    if (url === undefined && !onDisk && yirImageTaskId(record) === undefined) throw new CliError(imageBlocked(record) ?? "不能 resume", 2);
    await startDetached({
      project,
      id,
      args: ["runs", "resume", id, "--execute", "--project", project],
      io,
    });
    return 0;
  }
  if (onDisk && outFile !== undefined) return finishImageFile(project, record, outFile, io);
  const taskId = yirImageTaskId(record);
  if ((url === undefined || outFile === undefined) && taskId === undefined) {
    throw new CliError(imageBlocked(record) ?? "不能 resume", 2);
  }
  const calls: HttpCall[] = [];
  try {
    if (url !== undefined && outFile !== undefined) {
      if (url.includes("[redacted]")) {
        throw new CliError(`run ${id} 的结果 URL 已打码，不能下载。不要重新提交。`, 2);
      }
      const downloaded = await perform(
        calls,
        { method: "GET", url, headers: {}, body: { kind: "empty" } },
        { mode: "execute", fetchImpl: fetchOf(io), auth: false },
      );
      const payload = bytesFromResult(downloaded) ?? downloaded.body;
      if (payload.byteLength === 0) throw new CliError(`run ${id} 的结果 URL 没有图像数据。不要重新提交。`);
      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, payload);
    } else if (taskId !== undefined && outFile !== undefined) {
      await resumeYirImageJob(record, taskId, outFile, calls, io);
    } else {
      throw new CliError(imageBlocked(record) ?? "不能 resume", 2);
    }
  } catch (err) {
    if (err instanceof CliError && err.exitCode === 2) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const next: RunRecord = { ...record, status: "error", error: message, calls };
    await writeRun(project, next, []);
    throw new CliError(`${message}\nrun: ${id}`);
  }
  return finishImageFile(project, record, outFile!, io);
}

async function resumeYirImageJob(
  record: RunRecord,
  taskId: string,
  outFile: string,
  calls: HttpCall[],
  io: IO,
): Promise<void> {
  const binding = record.binding;
  if (binding === null) throw new CliError(`run ${record.id} has no provider binding`, 2);
  const apiKey = io.env[binding.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) throw new CliError(`set ${binding.apiKeyEnv} to resume run ${record.id}`, 2);
  const opts = { mode: "execute" as const, fetchImpl: fetchOf(io), apiKey };
  const pollUrl = record.pending?.pollUrl ?? `${binding.baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(taskId)}/status`;
  const first = await perform(calls, { method: "GET", url: pollUrl, headers: {}, body: { kind: "empty" } }, opts);
  const knownId = yirJobId(first.json) ?? taskId;
  const outcome = await finishYirImage(calls, binding.baseUrl, first, opts, io, "execute", outFile, knownId);
  const file = outcome.files[0];
  if (file?.bytes === undefined) throw new CliError(`run ${record.id} 的 yir 任务没有图像数据。不要重新提交。`);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, file.bytes);
}

export async function resumeRun(
  project: string,
  id: string,
  overrides: { task?: string; out?: string },
  io: IO,
  options?: { detach?: boolean },
): Promise<number> {
  const loaded = await readRunRecord(project, id);
  if (loaded.status === "ok" && overrides.task === undefined) {
    line(io, `run ${id} already finished`);
    for (const output of loaded.outputs) line(io, `wrote: ${output}`);
    return 0;
  }
  let record = loaded;
  if (imageRun(record) && (overrides.task === undefined || yirImageTaskId(record) !== undefined || record.binding?.provider === "yir")) {
    if (overrides.task !== undefined && record.image !== undefined && record.image.taskId !== overrides.task) {
      record = { ...record, image: { ...record.image, taskId: overrides.task }, pending: { provider: "yir", taskId: overrides.task, lastStatus: record.pending?.lastStatus ?? "unknown", videoFile: record.pending?.videoFile ?? "", receipt: record.pending?.receipt ?? "" } };
    }
    if (record.pending === undefined || record.pending.provider === "yir" || yirImageTaskId(record) !== undefined) {
      return resumeImage(project, record, io, options?.detach === true);
    }
  }
  const pending = derivePending(record, project, overrides);
  if (pending === undefined) throw new CliError(`run ${id} has no remote task to resume (pass --task <id>)`, 2);
  if (pending.provider !== "haomao" && pending.provider !== "beeftv" && pending.provider !== "ycyapi" && pending.provider !== "mediakit" && pending.provider !== "openspeech") {
    throw new CliError(`resume supports haomao, beeftv, ycyapi, mediakit, and openspeech tasks, not ${pending.provider}`, 2);
  }
  if (pending.provider === "mediakit" && record.modelId !== "video-understand-router" && !ENHANCE_MODELS.has(record.modelId)) {
    throw new CliError(`resume does not know how to finish mediakit model ${record.modelId}`, 2);
  }
  const binding = record.binding;
  if (binding === null) throw new CliError(`run ${id} has no provider binding`, 2);
  const apiKey = io.env[binding.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) throw new CliError(`set ${binding.apiKeyEnv} to resume run ${id}`, 2);

  const workerAlive =
    (record.status === "pending" || record.status === "running") &&
    record.worker?.pid !== undefined &&
    pidAlive(record.worker.pid) &&
    record.worker.exited !== "clean";
  if (workerAlive) {
    line(io, `仍在生成（pid ${record.worker?.pid}）`);
    line(io, `下一步: lumen runs wait ${id}`);
    return 0;
  }
  if (options?.detach === true && io.env.LUMEN_DETACH_WORKER === undefined) {
    const args = ["runs", "resume", id, "--execute", "--project", project];
    if (overrides.task !== undefined) args.push("--task", overrides.task);
    if (overrides.out !== undefined) args.push("--out", overrides.out);
    await startDetached({ project, id, args, io });
    return 0;
  }

  const opts = { mode: "execute" as const, fetchImpl: fetchOf(io), apiKey };
  const calls: HttpCall[] = [];
  const now = (io.now?.() ?? new Date()).toISOString();
  const next: RunRecord = { ...record, resumedAt: [...(record.resumedAt ?? []), now] };
  try {
    const outcome = pending.provider === "openspeech"
      ? await resumeOpenspeech(record, pending, binding, apiKey, calls, io)
      : pending.provider === "mediakit"
        ? await resumeMediakit(project, record, pending, calls, opts, io)
        : await resumeSeedance(pending, binding.baseUrl, calls, opts, io);
    const outputs: string[] = [];
    for (const file of outcome.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      if (file.bytes !== undefined) await writeFile(file.path, file.bytes);
      else if (file.text !== undefined) await writeFile(file.path, file.text);
      outputs.push(file.path);
    }
    delete next.pending;
    delete next.error;
    Object.assign(next, { status: "ok", response: outcome.response, outputs });
    await writeRun(project, next, [apiKey]);
    line(io, `ok ${record.modelId}`);
    line(io, `run: ${id}`);
    for (const output of outputs) line(io, `wrote: ${output}`);
    line(io, `audit: ${path.join(runDir(project, id), "record.json")}`);
    return 0;
  } catch (err) {
    if (err instanceof PendingTaskError) {
      const still: PendingTask = {
        ...pending,
        lastStatus: err.lastStatus,
        ...(err.pollUrl === undefined ? {} : { pollUrl: err.pollUrl }),
      };
      Object.assign(next, { status: "running", pending: still, response: err.response });
      delete next.error;
      await writeRun(project, next, [apiKey]);
      line(io, `running ${record.modelId}`);
      line(io, `run: ${id}`);
      line(io, `task: ${still.provider} ${still.taskId} (${still.lastStatus})`);
      if (still.pollUrl !== undefined) line(io, `poll: ${redactUrl(still.pollUrl)}`);
      line(io, resumeHint(id));
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    Object.assign(next, { status: "error", error: message, pending, ...(err instanceof TransportError ? { response: err.response } : {}) });
    await writeRun(project, next, [apiKey]);
    throw new CliError(`${message}\nrun: ${id}`);
  }
}
