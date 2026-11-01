import { CliError } from "../errors.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { fail, line, type IO } from "../io.js";
import { assertProject } from "../project.js";
import { resumeRun } from "./resume.js";
import {
  WAIT_STILL_RUNNING,
  claimRun,
  explainRun,
  isUnclaimed,
  listRunRecords,
  outputsOnDisk,
  pidAlive,
  readRunMarkdown,
  readRunRecord,
  type RunRecord,
} from "../runs.js";

const TERMINAL = new Set<RunRecord["status"]>(["ok", "error", "mock", "dry-run"]);

function listLine(record: RunRecord): string {
  const task = record.pending === undefined ? "" : `  task ${record.pending.taskId}`;
  const claimed = record.claimed === true ? "  已取走" : "";
  return `${record.id}  ${record.status}  ${record.modelId}  ${record.mode}${task}${claimed}`;
}

function pendingLine(record: RunRecord): string {
  const dead =
    (record.status === "pending" || record.status === "running") &&
    record.worker?.pid !== undefined &&
    !pidAlive(record.worker.pid);
  const note = dead ? "  已中断" : "";
  return `${record.id}  ${record.status}  ${record.modelId}  ${record.time}${note}`;
}

function timeoutSeconds(value: string | undefined): number {
  if (value === undefined) return 60;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new CliError("--timeout 需要秒数", 2);
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new CliError("--timeout 需要非负秒数", 2);
  return seconds;
}

async function sleep(io: IO, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (io.sleep) {
    await io.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the run record until it finishes. Does not submit or resume. */
export async function waitForRun(project: string, id: string, timeoutSec: number, io: IO): Promise<number> {
  const started = Date.now();
  let record = await readRunRecord(project, id);
  while (!TERMINAL.has(record.status)) {
    if ((Date.now() - started) / 1000 >= timeoutSec) {
      line(io, "仍在生成");
      line(io, `run: ${id}`);
      line(io, `status: ${record.status}`);
      for (const text of explainRun(record, await outputsOnDisk(record))) line(io, text);
      line(io, `下一步: lumen runs wait ${id}`);
      return WAIT_STILL_RUNNING;
    }
    const left = timeoutSec * 1000 - (Date.now() - started);
    await sleep(io, Math.min(200, Math.max(0, left)));
    record = await readRunRecord(project, id);
  }
  const at = (io.now?.() ?? new Date()).toISOString();
  if (record.status === "ok" || record.status === "error" || record.status === "mock") {
    await claimRun(project, id, "wait", at);
  }
  if (record.status === "error") {
    const reason = record.error ?? "failed";
    fail(io, reason.includes(`run: ${id}`) ? reason : `${reason}\nrun: ${id}`);
    return 1;
  }
  line(io, `${record.status} ${record.modelId}`);
  line(io, `run: ${id}`);
  for (const output of record.outputs) line(io, `wrote: ${output}`);
  return 0;
}

export async function runsCommand(args: string[], project: string, io: IO): Promise<number> {
  const [sub, ...rest] = args;
  await assertProject(project);
  if (sub === "list") {
    const parsed = parseFlags(rest, { pending: "boolean" });
    requireRestEmpty(parsed.rest);
    const records = await listRunRecords(project);
    const pendingOnly = parsed.values.pending === true;
    const shown = pendingOnly ? records.filter(isUnclaimed) : records;
    if (shown.length === 0) line(io, pendingOnly ? "没有未取走的 run" : "no runs");
    for (const record of shown) line(io, pendingOnly ? pendingLine(record) : listLine(record));
    return 0;
  }
  if (sub === "show") {
    const parsed = parseFlags(rest, {});
    const id = parsed.rest[0] ?? flagString(parsed.values, "id");
    if (id === undefined) throw new CliError("runs show needs an id", 2);
    requireRestEmpty(parsed.rest.slice(1));
    const record = await readRunRecord(project, id);
    io.stdout(await readRunMarkdown(project, id));
    for (const text of explainRun(record, await outputsOnDisk(record))) line(io, text);
    if ((record.status === "ok" || record.status === "error" || record.status === "mock") && record.claimed !== true) {
      await claimRun(project, id, "show", (io.now?.() ?? new Date()).toISOString());
    }
    return 0;
  }
  if (sub === "wait") {
    const parsed = parseFlags(rest, { timeout: "string" });
    const id = parsed.rest[0] ?? flagString(parsed.values, "id");
    if (id === undefined) throw new CliError("runs wait needs a run id", 2);
    requireRestEmpty(parsed.rest.slice(1));
    return waitForRun(project, id, timeoutSeconds(flagString(parsed.values, "timeout")), io);
  }
  if (sub === "resume") {
    const parsed = parseFlags(rest, { task: "string", out: "string", execute: "boolean", detach: "boolean", mock: "boolean" });
    const id = parsed.rest[0];
    if (id === undefined) throw new CliError("runs resume needs a run id", 2);
    requireRestEmpty(parsed.rest.slice(1));
    if (parsed.values.detach === true && parsed.values.execute !== true) throw new CliError("--detach 需要 --execute", 2);
    const task = flagString(parsed.values, "task");
    const out = flagString(parsed.values, "out");
    return resumeRun(
      project,
      id,
      { ...(task === undefined ? {} : { task }), ...(out === undefined ? {} : { out }) },
      io,
      { detach: parsed.values.detach === true },
    );
  }
  throw new CliError("runs needs list, show, wait or resume", 2);
}
