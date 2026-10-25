import { access, constants } from "node:fs/promises";
import path from "node:path";

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findOnPath(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const entries = (env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  for (const dir of entries) {
    try {
      await access(path.join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function envPresence(env: NodeJS.ProcessEnv, name: string): "present" | "missing" {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? "present" : "missing";
}
