import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { rejectUnknown } from "../args.js";
import { CliError, errorCode } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { line, type IO } from "../io.js";
import { CONFIG_TEMPLATE, projectConfigPath } from "../config.js";
import { LAYOUT, resolveProject } from "../project.js";
import { SHOTLIST_MD_TEMPLATE } from "../shotlist.js";

async function ensureProjectDir(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new CliError(`not a directory: ${dir}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (errorCode(err) !== "ENOENT") throw err;
    await mkdir(dir, { recursive: true });
  }
}

async function ensureChild(dir: string, name: string): Promise<"created" | "kept"> {
  const child = path.join(dir, name);
  try {
    await mkdir(child);
    await writeFile(path.join(child, ".gitkeep"), "");
    return "created";
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
    const info = await stat(child);
    if (!info.isDirectory()) throw new CliError(`not a directory: ${child}`);
    return "kept";
  }
}

export async function initCommand(args: string[], projectFlag: string | undefined, io: IO): Promise<number> {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  rejectUnknown(args.filter((arg) => arg.startsWith("-")));
  if (positional.length > 1) throw new CliError("init accepts at most one directory", 2);

  const chosen = positional[0];
  if (
    chosen !== undefined &&
    projectFlag !== undefined &&
    path.resolve(io.cwd, chosen) !== path.resolve(io.cwd, projectFlag)
  ) {
    throw new CliError("init: pass a directory argument or --project, not both", 2);
  }

  const dir = resolveProject(io.cwd, chosen ?? projectFlag);
  await ensureProjectDir(dir);

  const md = path.join(dir, LAYOUT.shotlistMd);
  const json = path.join(dir, LAYOUT.shotlistJson);
  const notes: string[] = [];
  if (await fileExists(json)) {
    notes.push(`kept ${LAYOUT.shotlistJson}`);
  } else if (await fileExists(md)) {
    notes.push(`kept ${LAYOUT.shotlistMd}`);
  } else {
    await writeFile(md, SHOTLIST_MD_TEMPLATE, { flag: "wx" });
    notes.push(`created ${LAYOUT.shotlistMd}`);
  }

  for (const name of [LAYOUT.refs, LAYOUT.shots, LAYOUT.out]) {
    const status = await ensureChild(dir, name);
    notes.push(`${status} ${name}/`);
  }

  const config = projectConfigPath(dir);
  if (await fileExists(config)) {
    notes.push("kept lumen.config.json");
  } else {
    await writeFile(config, CONFIG_TEMPLATE, { flag: "wx" });
    notes.push("created lumen.config.json");
  }

  line(io, `initialized ${dir}`);
  for (const note of notes) line(io, `  ${note}`);
  return 0;
}
