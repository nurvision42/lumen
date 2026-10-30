import { CliError } from "../errors.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { line, type IO } from "../io.js";
import { assertProject } from "../project.js";
import { resumeRun } from "./resume.js";
import { listRunRecords, readRunMarkdown } from "../runs.js";

export async function runsCommand(args: string[], project: string, io: IO): Promise<number> {
  const [sub, ...rest] = args;
  await assertProject(project);
  if (sub === "list") {
    const parsed = parseFlags(rest, {});
    requireRestEmpty(parsed.rest);
    const records = await listRunRecords(project);
    if (records.length === 0) line(io, "no runs");
    for (const record of records) {
      const task = record.pending === undefined ? "" : `  task ${record.pending.taskId}`;
      line(io, `${record.id}  ${record.status}  ${record.modelId}  ${record.mode}${task}`);
    }
    return 0;
  }
  if (sub === "show") {
    const parsed = parseFlags(rest, {});
    const id = parsed.rest[0] ?? flagString(parsed.values, "id");
    if (id === undefined) throw new CliError("runs show needs an id", 2);
    requireRestEmpty(parsed.rest.slice(1));
    io.stdout(await readRunMarkdown(project, id));
    return 0;
  }
  if (sub === "resume") {
    const parsed = parseFlags(rest, { task: "string", out: "string" });
    const id = parsed.rest[0];
    if (id === undefined) throw new CliError("runs resume needs a run id", 2);
    requireRestEmpty(parsed.rest.slice(1));
    const task = flagString(parsed.values, "task");
    const out = flagString(parsed.values, "out");
    return resumeRun(project, id, { ...(task === undefined ? {} : { task }), ...(out === undefined ? {} : { out }) }, io);
  }
  throw new CliError("runs needs list, show or resume", 2);
}
