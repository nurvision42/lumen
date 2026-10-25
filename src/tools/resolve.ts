import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolPaths } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { binaryAsset, platformId, SHARP_INTEGRITY, SHARP_VERSION } from "./catalog.js";
import { lumenCacheDir } from "./cache.js";
import { execText, probeVersion } from "./run.js";

export type BinarySource = "config" | "path" | "cache" | "download";
export type SharpSource = "module" | "cache" | "download";

export interface ResolvedBinary {
  readonly name: "ffmpeg" | "ffprobe";
  readonly path: string;
  readonly version: string;
  readonly source: BinarySource;
}

export interface ResolvedSharp {
  readonly version: string;
  readonly path: string;
  readonly source: SharpSource;
  load: () => Promise<SharpModule>;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Enough of sharp for contact sheets. The package is loaded at runtime. */
export interface SharpModule {
  (input?: unknown): SharpChain;
  versions?: { sharp?: string };
}

export interface SharpChain {
  metadata: () => Promise<{ width?: number; height?: number }>;
  resize: (width: number, height: number, options?: { fit?: string; background?: string }) => SharpChain;
  composite: (images: readonly { input: Buffer; left?: number; top?: number }[]) => SharpChain;
  png: () => SharpChain;
  toBuffer: () => Promise<Buffer>;
}

export function configuredBinary(
  name: "ffmpeg" | "ffprobe",
  env: NodeJS.ProcessEnv,
  tools: ToolPaths,
): string | undefined {
  const fromEnv = (name === "ffmpeg" ? env.LUMEN_FFMPEG : env.LUMEN_FFPROBE)?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = tools[name]?.trim();
  return fromFile === undefined || fromFile.length === 0 ? undefined : fromFile;
}

export function binaryLine(name: string, resolved: ResolvedBinary | undefined): string {
  if (resolved === undefined) return `${name}: missing`;
  return `${name}: ${resolved.path} ${resolved.version} source=${resolved.source}`;
}

export function sharpLine(resolved: ResolvedSharp | undefined): string {
  if (resolved === undefined) return "sharp: missing";
  return `sharp: ${resolved.version} ${resolved.path} source=${resolved.source}`;
}

async function firstOnPath(
  name: "ffmpeg" | "ffprobe",
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; version: string } | undefined> {
  const entries = (env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  const filenames = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of entries) {
    for (const filename of filenames) {
      const full = path.join(dir, filename);
      try {
        await access(full, constants.X_OK);
      } catch {
        continue;
      }
      const version = await probeVersion(full, name);
      if (version !== undefined) return { path: full, version };
    }
  }
  return undefined;
}

async function downloadGzip(url: string, dest: string, sha256: string, fetchImpl: FetchImpl): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok || response.body === null) {
    throw new CliError(`download failed HTTP ${response.status} for ${path.basename(dest)}`);
  }
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const file = createWriteStream(temp, { mode: 0o755 });
  try {
    await pipeline(Readable.fromWeb(response.body), createGunzip(), hasher, file);
    if (hash.digest("hex") !== sha256) throw new CliError(`${path.basename(dest)} download hash mismatch`);
    await chmod(temp, 0o755);
    await rename(temp, dest);
  } catch (error) {
    file.destroy();
    await rm(temp, { force: true });
    throw error;
  }
}

export async function resolveBinary(options: {
  readonly name: "ffmpeg" | "ffprobe";
  readonly env: NodeJS.ProcessEnv;
  readonly configured?: string;
  readonly download: boolean;
  readonly fetch?: FetchImpl;
  readonly asset?: { url: string; sha256: string; filename: string };
  readonly onDownload?: (name: "ffmpeg" | "ffprobe") => void;
}): Promise<ResolvedBinary | undefined> {
  const { name } = options;
  if (options.configured !== undefined) {
    const version = await probeVersion(options.configured, name);
    if (version === undefined) {
      const envName = name === "ffmpeg" ? "LUMEN_FFMPEG" : "LUMEN_FFPROBE";
      throw new CliError(`${name} at ${options.configured} did not run -version; check ${envName} or tools.${name}`);
    }
    return { name, path: options.configured, version, source: "config" };
  }
  const onPath = await firstOnPath(name, options.env);
  if (onPath !== undefined) return { name, path: onPath.path, version: onPath.version, source: "path" };

  const platform = platformId();
  const asset = options.asset ?? binaryAsset(name, platform);
  const root = lumenCacheDir(options.env);
  const cached = root === undefined ? undefined : path.join(root, "bin", platform, asset.filename);
  if (cached !== undefined && (await fileExists(cached))) {
    const version = await probeVersion(cached, name);
    if (version !== undefined) return { name, path: cached, version, source: "cache" };
  }
  if (!options.download) return undefined;
  if (cached === undefined) throw new CliError("HOME or XDG_CACHE_HOME is required to cache ffmpeg");
  options.onDownload?.(name);
  await downloadGzip(asset.url, cached, asset.sha256, options.fetch ?? ((input, init) => fetch(input, init)));
  const version = await probeVersion(cached, name);
  if (version === undefined) {
    await rm(cached, { force: true });
    throw new CliError(`downloaded ${name} did not run -version`);
  }
  return { name, path: cached, version, source: "download" };
}

function tryResolve(fromFile: string): string | undefined {
  try {
    return createRequire(fromFile).resolve("sharp");
  } catch {
    return undefined;
  }
}

async function readSharpVersion(entry: string): Promise<string> {
  let dir = path.dirname(entry);
  while (true) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (parsed.name === "sharp" && typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // keep walking toward the sharp package root
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

function moduleRoots(project: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const nodePath = (env.NODE_PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [...new Set([project, cwd, ...nodePath, path.resolve(here, "..", "..")])];
}

async function installSharp(dir: string, env: NodeJS.ProcessEnv, fetchImpl: FetchImpl): Promise<void> {
  const metaUrl = `https://registry.npmjs.org/sharp/${SHARP_VERSION}`;
  const response = await fetchImpl(metaUrl);
  if (!response.ok) throw new CliError(`could not read the sharp package metadata (HTTP ${response.status})`);
  const meta = await response.json() as { dist?: { integrity?: string } };
  if (meta.dist?.integrity !== SHARP_INTEGRITY) {
    throw new CliError("sharp package integrity does not match the pinned hash");
  }
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({
    name: "lumen-sharp-cache",
    private: true,
    dependencies: { sharp: SHARP_VERSION },
  }, null, 2)}\n`);
  try {
    await execText("npm", ["install", "--prefix", dir, "--omit=dev", "--no-audit", "--no-fund"], { env, cwd: dir, timeout: 180_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`could not install sharp into the cache\n${message.split("\n").slice(-12).join("\n")}`);
  }
}

export async function resolveSharp(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly project: string;
  readonly cwd: string;
  readonly download: boolean;
  readonly fetch?: FetchImpl;
  readonly onDownload?: () => void;
}): Promise<ResolvedSharp | undefined> {
  const finish = async (entry: string, source: SharpSource): Promise<ResolvedSharp> => {
    const version = await readSharpVersion(entry);
    return {
      version,
      path: entry,
      source,
      load: async () => {
        const imported = await import(pathToFileURL(entry).href) as { default?: SharpModule };
        const sharp = imported.default ?? (imported as unknown as SharpModule);
        return sharp;
      },
    };
  };
  for (const root of moduleRoots(options.project, options.env, options.cwd)) {
    const entry = tryResolve(path.join(root, "package.json"));
    if (entry !== undefined) return finish(entry, "module");
  }
  const root = lumenCacheDir(options.env);
  const cacheRoot = root === undefined ? undefined : path.join(root, "sharp");
  if (cacheRoot !== undefined) {
    const cached = tryResolve(path.join(cacheRoot, "package.json"));
    if (cached !== undefined) return finish(cached, "cache");
  }
  if (!options.download) return undefined;
  if (cacheRoot === undefined) throw new CliError("HOME or XDG_CACHE_HOME is required to cache sharp");
  options.onDownload?.();
  await installSharp(cacheRoot, options.env, options.fetch ?? ((input, init) => fetch(input, init)));
  const installed = tryResolve(path.join(cacheRoot, "package.json"));
  if (installed === undefined) throw new CliError("sharp installed into the cache but could not be loaded");
  return finish(installed, "download");
}

export async function requireBinary(
  name: "ffmpeg" | "ffprobe",
  env: NodeJS.ProcessEnv,
  tools: ToolPaths,
  download: boolean,
  fetchImpl?: FetchImpl,
  onDownload?: (name: "ffmpeg" | "ffprobe") => void,
): Promise<ResolvedBinary> {
  const resolved = await resolveBinary({
    name,
    env,
    configured: configuredBinary(name, env, tools),
    download,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(onDownload === undefined ? {} : { onDownload }),
  });
  if (resolved === undefined) {
    throw new CliError(`${name} was not found. Run \`lumen setup ffmpeg\` or install ${name} on PATH.`);
  }
  return resolved;
}
