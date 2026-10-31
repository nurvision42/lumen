import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { finishHaomaoVideo } from "../clients/seedance.js";
import { finishBeeftvVideo } from "../clients/beeftv.js";
import { finishYcyapiVideo } from "../clients/ycyapi.js";
import { pollMediakitTask, publishedMediakit } from "../clients/mediakit.js";
import { PendingTaskError } from "../clients/jobs.js";
import { CliError } from "../errors.js";
import { fetchOf, joinUrl, perform, TransportError, type HttpCall, type SendOptions } from "../http.js";
import { line, type IO } from "../io.js";
import { LAYOUT, outputPath } from "../project.js";
import { redactUrl } from "../redact.js";
import { readRunRecord, resumeHint, runDir, writeRun, type OutputFile, type PendingTask, type RunRecord } from "../runs.js";
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
  const task = await pollMediakitTask(calls, binding.baseUrl, pending.taskId, opts, io);
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

export async function resumeRun(
  project: string,
  id: string,
  overrides: { task?: string; out?: string },
  io: IO,
): Promise<number> {
  const record = await readRunRecord(project, id);
  if (record.status === "ok" && overrides.task === undefined) {
    line(io, `run ${id} already finished`);
    for (const output of record.outputs) line(io, `wrote: ${output}`);
    return 0;
  }
  const pending = derivePending(record, project, overrides);
  if (pending === undefined) throw new CliError(`run ${id} has no remote task to resume (pass --task <id>)`, 2);
  if (pending.provider !== "haomao" && pending.provider !== "beeftv" && pending.provider !== "ycyapi" && pending.provider !== "mediakit") {
    throw new CliError(`resume supports haomao, beeftv, ycyapi, and mediakit tasks, not ${pending.provider}`, 2);
  }
  if (pending.provider === "mediakit" && record.modelId !== "video-understand-router" && !ENHANCE_MODELS.has(record.modelId)) {
    throw new CliError(`resume does not know how to finish mediakit model ${record.modelId}`, 2);
  }
  const binding = record.binding;
  if (binding === null) throw new CliError(`run ${id} has no provider binding`, 2);
  const apiKey = io.env[binding.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) throw new CliError(`set ${binding.apiKeyEnv} to resume run ${id}`, 2);

  const opts = { mode: "execute" as const, fetchImpl: fetchOf(io), apiKey };
  const calls: HttpCall[] = [];
  const now = (io.now?.() ?? new Date()).toISOString();
  const next: RunRecord = { ...record, resumedAt: [...(record.resumedAt ?? []), now] };
  try {
    const outcome =
      pending.provider === "mediakit"
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
