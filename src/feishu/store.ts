import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { configDir } from "../install/locate.js";
import { parseBrand, type FeishuBrand } from "./endpoints.js";

export interface FeishuApp {
  appId: string;
  appSecret: string;
  brand: FeishuBrand;
  source: "registration" | "manual" | "env";
}

export interface FeishuSession {
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  tokenType: string;
  openId?: string;
  unionId?: string;
  name?: string;
}

export function feishuDir(env: NodeJS.ProcessEnv): string {
  const root = configDir(env);
  if (root === undefined) throw new CliError("HOME or XDG_CONFIG_HOME is required to store Feishu credentials");
  return path.join(root, "feishu");
}

export function appFile(env: NodeJS.ProcessEnv): string {
  return path.join(feishuDir(env), "app.json");
}

export function sessionFile(env: NodeJS.ProcessEnv): string {
  return path.join(feishuDir(env), "session.json");
}

async function writePrivate(file: string, body: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, body, { mode: 0o600 });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  await chmod(file, 0o600);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new CliError(`${label} is missing ${key}`);
  return value.trim();
}

export function parseApp(raw: unknown, label: string): FeishuApp {
  const record = asRecord(raw, label);
  const source = record.source;
  return {
    appId: requiredString(record, "appId", label),
    appSecret: requiredString(record, "appSecret", label),
    brand: parseBrand(typeof record.brand === "string" ? record.brand : undefined),
    source: source === "registration" || source === "manual" || source === "env" ? source : "manual",
  };
}

export function parseSession(raw: unknown, label: string): FeishuSession {
  const record = asRecord(raw, label);
  const expiresAt = record.expiresAt;
  const refreshExpiresAt = record.refreshExpiresAt;
  if (typeof expiresAt !== "number" || typeof refreshExpiresAt !== "number") {
    throw new CliError(`${label} has no expiry`);
  }
  return {
    appId: requiredString(record, "appId", label),
    accessToken: requiredString(record, "accessToken", label),
    refreshToken: requiredString(record, "refreshToken", label),
    expiresAt,
    refreshExpiresAt,
    scope: typeof record.scope === "string" ? record.scope : "",
    tokenType: typeof record.tokenType === "string" && record.tokenType.length > 0 ? record.tokenType : "Bearer",
    ...(typeof record.openId === "string" ? { openId: record.openId } : {}),
    ...(typeof record.unionId === "string" ? { unionId: record.unionId } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
  };
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new CliError(`${file}: not valid JSON`);
    throw error;
  }
}

export async function readStoredApp(env: NodeJS.ProcessEnv): Promise<FeishuApp | undefined> {
  const file = appFile(env);
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  return parseApp(raw, file);
}

/** Env credentials win over the file when both App ID and Secret are set. */
export async function loadApp(env: NodeJS.ProcessEnv): Promise<FeishuApp> {
  const appId = env.FEISHU_APP_ID?.trim() ?? "";
  const appSecret = env.FEISHU_APP_SECRET?.trim() ?? "";
  if ((appId.length === 0) !== (appSecret.length === 0)) {
    throw new CliError("set both FEISHU_APP_ID and FEISHU_APP_SECRET, or neither");
  }
  if (appId.length > 0 && appSecret.length > 0) {
    return { appId, appSecret, brand: parseBrand(env.FEISHU_BRAND), source: "env" };
  }
  const stored = await readStoredApp(env);
  if (stored === undefined) {
    throw new CliError(
      "Feishu app credentials are missing. Run `lumen feishu setup` to scan and create or select an app, or set FEISHU_APP_ID and FEISHU_APP_SECRET and run `lumen feishu app`.",
    );
  }
  return stored;
}

export async function writeApp(env: NodeJS.ProcessEnv, app: FeishuApp): Promise<void> {
  const file = appFile(env);
  await writePrivate(file, `${JSON.stringify({ appId: app.appId, appSecret: app.appSecret, brand: app.brand, source: app.source }, null, 2)}\n`);
}

export async function readSession(env: NodeJS.ProcessEnv): Promise<FeishuSession | undefined> {
  const file = sessionFile(env);
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  return parseSession(raw, file);
}

export async function writeSession(env: NodeJS.ProcessEnv, session: FeishuSession): Promise<void> {
  await writePrivate(sessionFile(env), `${JSON.stringify(session, null, 2)}\n`);
}

export async function clearSession(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(sessionFile(env), { force: true });
}
