import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { finishHaomaoVideo } from "../clients/seedance.js";
import { finishBeeftvVideo } from "../clients/beeftv.js";
import { PendingTaskError } from "../clients/jobs.js";
import { CliError } from "../errors.js";
import { fetchOf, joinUrl, perform, TransportError, type HttpCall } from "../http.js";
import { line, type IO } from "../io.js";
import { outputPath } from "../project.js";
import { readRunRecord, resumeHint, runDir, writeRun, type PendingTask, type RunRecord } from "../runs.js";

function flagAfter(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index >= 0 ? command[index + 1] : undefined;
}

/** Older runs (<=0.1.4) recorded a still-processing task as an error; recover what we can. */
function derivePending(record: RunRecord, project: string, overrides: { task?: string; out?: string }): PendingTask | undefined {
  const taskId = overrides.task ?? record.pending?.taskId ?? /(?:haomao|beeftv) task (\S+)/.exec(record.error ?? "")?.[1];
  if (taskId === undefined) return undefined;
  const out = overrides.out ?? flagAfter(record.command, "--out");
  const videoFile =
    overrides.out !== undefined || record.pending === undefined
      ? outputPath(project, { folder: "clip", filename: `${record.id}.mp4`, ...(out === undefined ? {} : { out }) })
      : record.pending.videoFile;
  return {
    provider: record.pending?.provider ?? record.binding?.provider ?? "haomao",
    taskId,
    lastStatus: record.pending?.lastStatus ?? "unknown",
    videoFile,
    receipt: `${videoFile.replace(/\.mp4$/i, "")}.seedance.json`,
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
  if (pending.provider !== "haomao" && pending.provider !== "beeftv") throw new CliError(`resume supports haomao and beeftv seedance tasks, not ${pending.provider}`, 2);
  const binding = record.binding;
  if (binding === null) throw new CliError(`run ${id} has no provider binding`, 2);
  const apiKey = io.env[binding.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) throw new CliError(`set ${binding.apiKeyEnv} to resume run ${id}`, 2);

  const opts = { mode: "execute" as const, fetchImpl: fetchOf(io), apiKey };
  const calls: HttpCall[] = [];
  const now = (io.now?.() ?? new Date()).toISOString();
  const next: RunRecord = { ...record, resumedAt: [...(record.resumedAt ?? []), now] };
  try {
    const first = await perform(
      calls,
      {
        method: "GET",
        url: joinUrl(
          binding.baseUrl,
          pending.provider === "beeftv"
            ? `/v1/videos/${encodeURIComponent(pending.taskId)}`
            : `/contents/generations/tasks/${encodeURIComponent(pending.taskId)}`,
        ),
        headers: {},
        body: { kind: "empty" },
      },
      opts,
    );
    const outcome = await (pending.provider === "beeftv" ? finishBeeftvVideo : finishHaomaoVideo)(calls, binding.baseUrl, first, opts, io, "execute", pending.videoFile, pending.receipt, pending.taskId);
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
      Object.assign(next, { status: "running", pending: { ...pending, lastStatus: err.lastStatus }, response: err.response });
      delete next.error;
      await writeRun(project, next, [apiKey]);
      line(io, `running ${record.modelId}`);
      line(io, `run: ${id}`);
      line(io, `task: ${pending.provider} ${pending.taskId} (${err.lastStatus})`);
      line(io, resumeHint(id));
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    Object.assign(next, { status: "error", error: message, pending, ...(err instanceof TransportError ? { response: err.response } : {}) });
    await writeRun(project, next, [apiKey]);
    throw new CliError(`${message}\nrun: ${id}`);
  }
}
