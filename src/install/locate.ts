import { access, constants, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { lumenCacheDir } from "../tools/cache.js";

const accessFile = promisify(access);

/** Package root of this lumen checkout or install. */
export function packageRootFrom(startFile: string): string {
  let dir = path.dirname(path.resolve(startFile));
  const fallback = path.resolve(dir, "..", "..");
  while (true) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (parsed.name === "@nurvision/lumen") return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

/** `~/.local/bin`. The install script puts the `lumen` command here. */
export function userBinDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim();
  if (home === undefined || home.length === 0) return undefined;
  return path.join(home, ".local", "bin");
}

/**
 * `~/.local/share/lumen`, or `$XDG_DATA_HOME/lumen` when that directory is under HOME.
 * A data home outside HOME is ignored so the default install stays in the user directory.
 */
export function userInstallDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim();
  const xdg = env.XDG_DATA_HOME?.trim();
  if (home === undefined || home.length === 0) return undefined;
  if (xdg !== undefined && xdg.length > 0 && (xdg === home || xdg.startsWith(home + path.sep))) {
    return path.join(xdg, "lumen");
  }
  return path.join(home, ".local", "share", "lumen");
}

/** `~/.config/lumen` or `$XDG_CONFIG_HOME/lumen`. */
export function configDir(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.XDG_CONFIG_HOME ?? (env.HOME ? path.join(env.HOME, ".config") : undefined);
  if (base === undefined || base.length === 0) return undefined;
  return path.join(base, "lumen");
}

export function dirOnPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  const target = path.resolve(dir);
  return (env.PATH ?? "").split(path.delimiter).some((entry) => entry.length > 0 && path.resolve(entry) === target);
}

export async function findCommand(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const filename of names) {
      const full = path.join(dir, filename);
      try {
        await accessFile(full, constants.X_OK);
        return full;
      } catch {
        // try the next directory
      }
    }
  }
  return undefined;
}

export async function commandStatus(
  env: NodeJS.ProcessEnv,
  root: string,
): Promise<{ readonly path?: string; readonly relation: "missing" | "this" | "other" }> {
  const found = await findCommand("lumen", env);
  if (found === undefined) return { relation: "missing" };
  let resolved = found;
  let rootReal = path.resolve(root);
  try {
    resolved = await realpath(found);
  } catch {
    // a broken command is still on PATH
  }
  try {
    rootReal = await realpath(root);
  } catch {
    // compare against the given path
  }
  const relation = resolved === rootReal || resolved.startsWith(rootReal + path.sep) ? "this" : "other";
  return { path: found, relation };
}

export async function installReport(env: NodeJS.ProcessEnv, root: string): Promise<string[]> {
  const command = await commandStatus(env, root);
  const binDir = userBinDir(env);
  const config = configDir(env);
  const cache = lumenCacheDir(env);
  const onPath = command.relation === "missing" || command.path === undefined
    ? "lumen on PATH: missing"
    : `lumen on PATH: ${command.path} (${command.relation})`;
  return [
    `lumen: ${root}`,
    onPath,
    binDir === undefined ? "user bin: unavailable" : `user bin: ${binDir} ${dirOnPath(binDir, env) ? "on PATH" : "not on PATH"}`,
    config === undefined ? "config dir: unavailable" : `config dir: ${config}`,
    cache === undefined ? "cache dir: unavailable" : `cache dir: ${cache}`,
  ];
}
