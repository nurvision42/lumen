import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IO } from "../src/io.js";

export async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function capture(env: NodeJS.ProcessEnv = process.env, extra: Partial<IO> = {}): {
  io: IO;
  out: () => string;
  err: () => string;
} {
  let out = "";
  let err = "";
  const scoped: NodeJS.ProcessEnv = { ...env };
  if (scoped.LUMEN_NO_SKILL_AUTOINSTALL === undefined) scoped.LUMEN_NO_SKILL_AUTOINSTALL = "1";
  return {
    io: {
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: (chunk) => {
        err += chunk;
      },
      cwd: process.cwd(),
      env: scoped,
      ...extra,
    },
    out: () => out,
    err: () => err,
  };
}
