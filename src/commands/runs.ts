import { CliError } from "../errors.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { line, type IO } from "../io.js";
import { assertProject } from "../project.js";
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
      line(io, `${record.id}  ${record.status}  ${record.modelId}  ${record.mode}`);
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
  throw new CliError("runs needs list or show", 2);
}
