import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractProject } from "../args.js";
import { CliError, errorCode } from "../errors.js";
import { fileExists } from "../fsutil.js";
import type { IO } from "../io.js";

/** Version file written inside the installed lumen skill directory. */
export const SKILL_VERSION_FILE = ".lumen-version";

/** Grok Bot reads one SKILL.md from each child of this directory. */
export const GROKBOT_WORKFLOWS_DIR = "/home/box/agent-data/workflows";

export function workflowsDir(env: NodeJS.ProcessEnv): string {
  const override = env.LUMEN_WORKFLOWS_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : GROKBOT_WORKFLOWS_DIR;
}

export function agentsSkillDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim();
  if (home === undefined || home.length === 0) return undefined;
  return path.join(home, ".agents", "skills", "lumen");
}

export function autoinstallDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.LUMEN_NO_SKILL_AUTOINSTALL?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** `older` when missing or unparsable, so an auto-install replaces it. */
export function versionRelation(installed: string | undefined, cli: string): "match" | "older" | "newer" {
  if (installed === undefined) return "older";
  const cmp = compareSemver(installed, cli);
  if (cmp === undefined || cmp < 0) return "older";
  if (cmp > 0) return "newer";
  return "match";
}

export async function detectSkillDir(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (await isWritableDirectory(workflowsDir(env))) return path.join(workflowsDir(env), "lumen");
  return agentsSkillDir(env);
}

export async function skillReport(env: NodeJS.ProcessEnv, cliVersion: string, cwd: string): Promise<string[]> {
  const chosen = await chosenSkillDir(env, cwd);
  const lines: string[] = [];
  if (chosen === undefined) {
    lines.push("skill: unavailable");
  } else {
    const state = await readInstalled(chosen);
    if (!state.present) lines.push(`skill: ${chosen} missing`);
    else lines.push(`skill: ${chosen} version=${state.version ?? "missing"} cli=${cliVersion} ${versionRelation(state.version, cliVersion)}`);
  }
  const others = await otherCopies(env, cwd, chosen);
  if (others.length === 0) lines.push("skill duplicate: none");
  for (const other of others) lines.push(`skill duplicate: ${other.dir} version=${other.version ?? "missing"}`);
  return lines;
}

export async function installSkill(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  root: string;
  cliVersion: string;
  target?: string;
  clean?: boolean;
  /** Skip the copy when this CLI's skill is already installed. */
  upgradeOnly?: boolean;
}): Promise<{
  dir: string;
  version: string;
  action: "installed" | "updated" | "unchanged";
  others: { dir: string; version?: string }[];
  removed: string[];
  note?: string;
} | undefined> {
  const resolved = await resolveDestination(options.env, options.cwd, options.target, options.upgradeOnly === true);
  if (resolved === undefined) return undefined;
  const state = await readInstalled(resolved.dir);
  const others = await otherCopies(options.env, options.cwd, resolved.dir);
  const removed: string[] = [];
  if (options.clean === true) {
    for (const other of others) {
      await removeLumenDir(other.dir);
      removed.push(other.dir);
    }
  }
  const current = state.skill && versionRelation(state.version, options.cliVersion) !== "older";
  if (options.upgradeOnly === true && current) {
    return { dir: resolved.dir, version: options.cliVersion, action: "unchanged", others, removed, note: resolved.note };
  }
  await copyPackageSkill(options.root, resolved.dir, options.cliVersion);
  return {
    dir: resolved.dir,
    version: options.cliVersion,
    action: state.present ? "updated" : "installed",
    others: options.clean === true ? [] : others,
    removed,
    note: resolved.note,
  };
}

export async function autoinstallSkill(io: IO, root: string, cliVersion: string): Promise<void> {
  if (autoinstallDisabled(io.env)) return;
  try {
    const result = await installSkill({
      env: io.env,
      cwd: io.cwd,
      root,
      cliVersion,
      upgradeOnly: true,
    });
    if (result === undefined || result.action === "unchanged") return;
    const verb = result.action === "updated" ? "updated" : "installed";
    const others = result.others.length === 0 ? "" : `; other copy: ${result.others.map((item) => item.dir).join(", ")}`;
    io.stderr(`skill ${verb}: ${result.dir} (${result.version})${others}\n`);
  } catch (err) {
    io.stderr(`skill autoinstall failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export function explicitSkillInstall(argv: string[]): boolean {
  try {
    const extracted = extractProject(argv);
    return extracted.argv[0] === "skill" && extracted.argv[1] === "install";
  } catch {
    return false;
  }
}

async function chosenSkillDir(env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const fromEnv = env.LUMEN_SKILL_DIR?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(cwd, fromEnv);
  return detectSkillDir(env);
}

async function resolveDestination(
  env: NodeJS.ProcessEnv,
  cwd: string,
  target: string | undefined,
  upgradeOnly: boolean,
): Promise<{ dir: string; note?: string } | undefined> {
  const fromEnv = env.LUMEN_SKILL_DIR?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const dir = path.resolve(cwd, fromEnv);
    if (target === undefined) return { dir };
    let note: string | undefined;
    try {
      const requested = await resolveTarget(env, cwd, target);
      if (!(await samePath(requested, dir))) note = "LUMEN_SKILL_DIR takes precedence over --target";
    } catch {
      note = "LUMEN_SKILL_DIR takes precedence over --target";
    }
    return { dir, note };
  }
  if (target !== undefined) return { dir: await resolveTarget(env, cwd, target) };
  const detected = await detectSkillDir(env);
  if (detected === undefined) {
    if (upgradeOnly) return undefined;
    throw new CliError("no skill directory: set HOME or LUMEN_SKILL_DIR", 1);
  }
  return { dir: detected };
}

async function resolveTarget(env: NodeJS.ProcessEnv, cwd: string, target: string): Promise<string> {
  if (target === "grokbot") {
    const parent = workflowsDir(env);
    if (!(await isWritableDirectory(parent))) throw new CliError(`grokbot workflows directory is not writable: ${parent}`, 1);
    return path.join(parent, "lumen");
  }
  if (target === "agents") {
    const dir = agentsSkillDir(env);
    if (dir === undefined) throw new CliError("agents skill directory needs HOME", 1);
    return dir;
  }
  return path.resolve(cwd, target);
}

async function otherCopies(
  env: NodeJS.ProcessEnv,
  cwd: string,
  chosen: string | undefined,
): Promise<{ dir: string; version?: string }[]> {
  const dirs: string[] = [];
  if (await isDirectory(workflowsDir(env))) dirs.push(path.join(workflowsDir(env), "lumen"));
  const agents = agentsSkillDir(env);
  if (agents !== undefined) dirs.push(agents);
  const custom = env.LUMEN_SKILL_DIR?.trim();
  if (custom !== undefined && custom.length > 0) dirs.push(path.resolve(cwd, custom));
  const others: { dir: string; version?: string }[] = [];
  const seen: string[] = [];
  for (const dir of dirs) {
    if (chosen !== undefined && (await samePath(dir, chosen))) continue;
    let duplicate = false;
    for (const previous of seen) {
      if (await samePath(previous, dir)) duplicate = true;
    }
    if (duplicate) continue;
    seen.push(dir);
    const state = await readInstalled(dir);
    if (!state.present) continue;
    others.push({ dir, version: state.version });
  }
  return others;
}

async function readInstalled(dir: string): Promise<{ present: boolean; skill: boolean; version?: string }> {
  const skill = await fileExists(path.join(dir, "SKILL.md"));
  let version: string | undefined;
  try {
    const text = (await readFile(path.join(dir, SKILL_VERSION_FILE), "utf8")).trim();
    if (text.length > 0) version = text;
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
  return { present: skill || version !== undefined, skill, version };
}

async function copyPackageSkill(root: string, dest: string, version: string): Promise<void> {
  const source = path.join(root, "skills", "lumen");
  const skill = path.join(source, "SKILL.md");
  const references = path.join(source, "references");
  if (!(await fileExists(skill)) || !(await isDirectory(references))) {
    throw new CliError(`lumen skill is missing from the package: ${source}`, 1);
  }
  await assertWritableSkillDir(dest);
  await mkdir(dest, { recursive: true });
  await cp(skill, path.join(dest, "SKILL.md"));
  const destRefs = path.join(dest, "references");
  await rm(destRefs, { recursive: true, force: true });
  await cp(references, destRefs, { recursive: true });
  await writeFile(path.join(dest, SKILL_VERSION_FILE), `${version}\n`, "utf8");
}

async function assertWritableSkillDir(dest: string): Promise<void> {
  try {
    const info = await lstat(dest);
    if (info.isSymbolicLink()) throw new CliError(`refusing to write through a symlink: ${dest}`, 1);
    if (!info.isDirectory()) throw new CliError(`skill directory is not a directory: ${dest}`, 1);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

async function removeLumenDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  if (path.basename(resolved) !== "lumen") throw new CliError(`refusing to remove ${resolved}`, 1);
  await rm(resolved, { recursive: true, force: true });
}

async function isWritableDirectory(dir: string): Promise<boolean> {
  try {
    if (!(await isDirectory(dir))) return false;
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

function compareSemver(left: string, right: string): number | undefined {
  const a = parts(left);
  const b = parts(right);
  if (a === undefined || b === undefined) return undefined;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function parts(version: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return undefined;
  return version.split(".").map((item) => Number.parseInt(item, 10));
}
