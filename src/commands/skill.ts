import { fileURLToPath } from "node:url";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { packageRootFrom } from "../install/locate.js";
import { CliError } from "../errors.js";
import { line, type IO } from "../io.js";
import { installSkill } from "../skill/place.js";
import { readVersion } from "../version.js";

const root = packageRootFrom(fileURLToPath(import.meta.url));

export function skillHelp(): string {
  return `lumen skill install [--target grokbot|agents|<path>] [--clean]

Copies this package's SKILL.md and references into one directory.
LUMEN_SKILL_DIR wins over --target. Otherwise --target, otherwise auto-detect.
Auto-detect uses /home/box/agent-data/workflows/lumen when that workflows directory exists and is writable.
Otherwise it uses ~/.agents/skills/lumen. It never writes both.
npm postinstall uses the same detection after npm install, overwrites that directory, and does not fail npm.
--clean removes the other lumen directory and leaves every other skill in place.
A version file .lumen-version is written in the lumen directory.
LUMEN_NO_SKILL_AUTOINSTALL=1 skips the postinstall and the check on later lumen runs.`;
}

export async function skillCommand(args: string[], io: IO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help") {
    line(io, skillHelp());
    return 0;
  }
  if (sub !== "install") throw new CliError(`unknown skill command: ${sub}\n\n${skillHelp()}`, 2);
  const parsed = parseFlags(rest, { target: "string", clean: "boolean" });
  requireRestEmpty(parsed.rest);
  const result = await installSkill({
    env: io.env,
    cwd: io.cwd,
    root,
    cliVersion: readVersion(),
    target: flagString(parsed.values, "target"),
    clean: parsed.values.clean === true,
  });
  if (result === undefined) throw new CliError("no skill directory: set HOME or LUMEN_SKILL_DIR", 1);
  if (result.note !== undefined) line(io, result.note);
  for (const removed of result.removed) line(io, `removed ${removed}`);
  line(io, `skill installed: ${result.dir} (${result.version})`);
  for (const other of result.others) line(io, `other lumen skill: ${other.dir}`);
  if (result.others.length > 0) line(io, "re-run with --clean to remove the other lumen skill");
  return 0;
}
