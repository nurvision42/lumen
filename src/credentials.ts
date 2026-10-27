import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { configDir } from "./install/locate.js";

/** Host credential name for the TikHub lookup key. It is not a project setting. */
export const TIKHUB_CREDENTIAL = "tikhub.api";

export function tikhubCredentialFile(env: NodeJS.ProcessEnv): string | undefined {
  const home = configDir(env);
  if (home === undefined) return undefined;
  return path.join(home, "credentials", TIKHUB_CREDENTIAL);
}

/** The machine store wins. `TIKHUB_API_KEY` covers a shell that has no store yet. */
export async function readTikhubKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = tikhubCredentialFile(env);
  if (file !== undefined) {
    try {
      const stored = (await readFile(file, "utf8")).trim();
      if (stored.length > 0) return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fromEnv = env.TIKHUB_API_KEY?.trim();
  return fromEnv === undefined || fromEnv.length === 0 ? undefined : fromEnv;
}

export async function tikhubKeyPresent(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await readTikhubKey(env)) !== undefined;
}

export async function writeTikhubKey(env: NodeJS.ProcessEnv, secret: string): Promise<void> {
  const file = tikhubCredentialFile(env);
  if (file === undefined) throw new CliError("HOME or XDG_CONFIG_HOME is required to store a TikHub key");
  const value = secret.trim();
  if (value.length === 0) throw new CliError("TikHub API key is required");
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, `${value}\n`, { mode: 0o600 });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  await chmod(file, 0o600);
}
