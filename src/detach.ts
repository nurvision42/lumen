import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import type { DetachSpawnSpec } from "./io.js";
import { packageRootFrom } from "./install/locate.js";

/** Script arguments for a detached `node` child that re-enters the lumen CLI. */
export function lumenScriptArgs(args: string[]): string[] {
  const entry = process.argv[1];
  if (entry && /[/\\]cli\.js$/.test(entry)) return [entry, ...args];
  const root = packageRootFrom(fileURLToPath(import.meta.url));
  const dist = path.join(root, "dist", "cli.js");
  if (existsSync(dist)) return [dist, ...args];
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const source = path.join(root, "src", "cli.ts");
  if (existsSync(tsx) && existsSync(source)) return [tsx, source, ...args];
  throw new CliError("找不到 lumen 程序入口，无法 --detach");
}

/**
 * New session and process group, stdin ignored, stdout/stderr appended to the run log.
 * The child is unref'd so the parent can exit without waiting, and without keeping a pipe.
 */
export function spawnDetached(spec: DetachSpawnSpec): { pid: number } {
  const logFd = openSync(spec.logFile, "a");
  try {
    const child = spawn(process.execPath, lumenScriptArgs(spec.args), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
    });
    child.unref();
    if (child.pid === undefined) throw new CliError("后台进程没有 pid");
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}
