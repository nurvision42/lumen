import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";

/** `~/.config/lumen` or `$XDG_CONFIG_HOME/lumen`. Shared across projects. */
export function lumenHome(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, "lumen");
  const home = env.HOME?.trim();
  if (home === undefined || home.length === 0) return undefined;
  return path.join(home, ".config", "lumen");
}

export function requireLumenHome(env: NodeJS.ProcessEnv): string {
  const home = lumenHome(env);
  if (home === undefined) throw new CliError("HOME or XDG_CONFIG_HOME is required for the asset library");
  return home;
}

export function libraryStateFile(home: string): string {
  return path.join(home, "library", "feishu.json");
}

export function appCredentialFile(home: string): string {
  return path.join(home, "credentials", "library.feishu.app.json");
}

export function userCredentialFile(home: string): string {
  return path.join(home, "credentials", "library.feishu.user.json");
}

export async function readJsonFile(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`${path.basename(file)} could not be parsed. Run: lumen library connect feishu`);
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
