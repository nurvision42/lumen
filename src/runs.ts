import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelBinding } from "./config.js";
import { CliError } from "./errors.js";
import { fileExists } from "./fsutil.js";
import type { HttpCall } from "./http.js";
import { TransportError } from "./http.js";
import { PendingTaskError } from "./clients/jobs.js";
import type { IO } from "./io.js";
import { line } from "./io.js";
import { assertProject } from "./project.js";
import { redactUrl, redactValue } from "./redact.js";
import type { RunMode } from "./flags.js";

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
  status: "dry-run" | "mock" | "ok" | "error" | "running";
  binding: RunBinding | null;
  params: unknown;
  calls: unknown;
  response: unknown;
  outputs: string[];
  error?: string;
  pending?: PendingTask;
  resumedAt?: string[];
}

/** A remote task still running when the poll window ended; `lumen runs resume <id>` picks it up. */
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

export async function writeRun(project: string, record: RunRecord, secrets: readonly string[]): Promise<void> {
  const safe = redactValue(record, secrets) as RunRecord;
  const dir = runDir(project, record.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "record.json"), `${JSON.stringify(safe, null, 2)}\n`);
  await writeFile(path.join(dir, "record.md"), render(safe));
}

export async function settle(
  io: IO,
  project: string,
  command: string[],
  modelId: string,
  mode: RunMode,
  work: (runId: string, ctx: RunCtx) => Promise<void>,
): Promise<number> {
  await assertProject(project);
  const date = io.now?.() ?? new Date();
  const id = createRunId(date);
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
  try {
    await work(id, ctx);
    status = mode === "dry-run" ? "dry-run" : mode === "mock" ? "mock" : "ok";
  } catch (err) {
    if (err instanceof CliError && err.exitCode === 2) throw err;
    if (err instanceof PendingTaskError && ctx.resume !== undefined && mode === "execute") {
      status = "running";
      pending = {
        provider: err.provider,
        taskId: err.taskId,
        lastStatus: err.lastStatus,
        ...ctx.resume,
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
    }
  }

  const outputs: string[] = [];
  if (thrown === undefined && pending === undefined && mode === "execute") {
    for (const file of ctx.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      if (file.bytes !== undefined) await writeFile(file.path, file.bytes);
      else if (file.text !== undefined) await writeFile(file.path, file.text);
      outputs.push(file.path);
    }
  }

  const record: RunRecord = {
    id,
    time: date.toISOString(),
    command,
    modelId,
    mode,
    status,
    binding: publicBinding(ctx),
    params: ctx.params,
    calls: ctx.calls,
    response: ctx.response,
    outputs,
    ...(error === undefined ? {} : { error }),
    ...(pending === undefined ? {} : { pending }),
  };
  await writeRun(project, record, ctx.secret === undefined ? [] : [ctx.secret]);

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
