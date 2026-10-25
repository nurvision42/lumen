import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "../errors.js";

const exec = promisify(execFile);

export async function execText(
  file: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await exec(file, [...args], {
      timeout: options.timeout ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const stderr = String(err.stderr ?? "").trim();
    const stdout = String(err.stdout ?? "").trim();
    throw new CliError(stderr || stdout || err.message || `${file} failed`);
  }
}

export async function probeVersion(file: string, name: "ffmpeg" | "ffprobe"): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execText(file, ["-version"], { timeout: 15_000 });
    const match = `${stdout}\n${stderr}`.match(new RegExp(`^${name} version\\s+(\\S+)`, "m"));
    return match?.[1];
  } catch {
    return undefined;
  }
}
