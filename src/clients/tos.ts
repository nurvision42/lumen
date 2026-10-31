import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TosConfig } from "../config.js";
import { CliError } from "../errors.js";
import type { RunMode } from "../flags.js";
import { fetchOf, pause, perform, TransportError, type HttpCall, type SendOptions } from "../http.js";
import type { IO } from "../io.js";
import { contentTypeFor } from "../media.js";
import { asRecord } from "../walk.js";
import type { UploadKind } from "./beeftv.js";

/**
 * Volcengine TOS (object storage) for providers that need a public HTTPS URL
 * and have no upload API of their own. The bucket stays private: PutObject is
 * signed with AK/SK, and the provider receives a time-limited presigned GET.
 *
 * Signing follows ve-tos-golang-sdk SignV4. The signing key is HMAC(secret, date)
 * then region, "tos", "request". Presigned GETs hash UNSIGNED-PAYLOAD and sign
 * only host. PutObject signs content-type, host, and x-tos-date, and uses the
 * empty-body SHA-256 in the canonical request (the Go SDK does not send
 * x-tos-content-sha256).
 */
export const TOS_ALGORITHM = "TOS4-HMAC-SHA256";
export const TOS_PAYLOAD_HASH = "UNSIGNED-PAYLOAD";
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Private objects stay private; providers fetch a presigned GET for 3 days. */
export const TOS_PRESIGN_SECONDS = 3 * 24 * 60 * 60;
export const TOS_UPLOAD_TIMEOUT_MS = 300_000;

export const TOS_ACCESS_KEY_ALIASES = ["VOLC_ACCESSKEY", "VOLCENGINE_ACCESS_KEY"] as const;
export const TOS_SECRET_KEY_ALIASES = ["VOLC_SECRETKEY", "VOLCENGINE_SECRET_KEY"] as const;

const UPLOAD_RETRIES = 4;

export interface PlannedTosUpload {
  source: string;
  path: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  sha256: string;
  bucket: string;
  key: string;
}

export function tosTimestamp(now: Date): { dateTime: string; dateStamp: string } {
  const dateTime = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { dateTime, dateStamp: dateTime.slice(0, 8) };
}

/** Encode like ve-tos-golang-sdk URIEncode: unreserved is A-Z a-z 0-9 - _ . ~ */
export function tosUriEncode(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const plain =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~";
    out += plain ? ch : `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function tosVirtualHost(bucket: string, endpoint: string): string {
  const host = endpoint.trim();
  if (host === bucket || host.startsWith(`${bucket}.`)) return host;
  return `${bucket}.${host}`;
}

export function tosObjectKey(filePath: string, sha256: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const safe = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
  return `lumen-${sha256}${safe}`;
}

function canonicalUri(key: string): string {
  const clean = key.replace(/^\/+/, "");
  return `/${clean.split("/").map((segment) => tosUriEncode(segment)).join("/")}`;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${tosUriEncode(key)}=${tosUriEncode(params[key] ?? "")}`)
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lines = names.map((name) => {
    const value = (headers[name] ?? "").replace(/\s+/g, " ").trim();
    return `${name}:${value}`;
  });
  return { block: lines.join("\n"), signed: names.join(";") };
}

function canonicalRequest(
  method: string,
  uri: string,
  query: string,
  headerBlock: string,
  signed: string,
  payloadHash: string,
): string {
  return [method, uri, query, `${headerBlock}\n`, signed, payloadHash].join("\n");
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = createHmac("sha256", secret).update(dateStamp, "utf8").digest();
  const kRegion = createHmac("sha256", kDate).update(region, "utf8").digest();
  const kService = createHmac("sha256", kRegion).update("tos", "utf8").digest();
  return createHmac("sha256", kService).update("request", "utf8").digest();
}

function sign(secret: string, region: string, dateTime: string, dateStamp: string, canonical: string): string {
  const scope = `${dateStamp}/${region}/tos/request`;
  const hashed = createHash("sha256").update(canonical, "utf8").digest("hex");
  const stringToSign = [TOS_ALGORITHM, dateTime, scope, hashed].join("\n");
  return createHmac("sha256", signingKey(secret, dateStamp, region)).update(stringToSign, "utf8").digest("hex");
}

export interface TosSignInput {
  bucket: string;
  endpoint: string;
  region: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

/** Header-signed PutObject. Host is signed but not set: fetch fills it from the URL. */
export function tosPutAuthHeaders(input: TosSignInput & { contentType?: string; method?: "GET" | "PUT" }): Record<string, string> {
  const host = tosVirtualHost(input.bucket, input.endpoint);
  const uri = canonicalUri(input.key);
  const { dateTime, dateStamp } = tosTimestamp(input.now);
  const scope = `${dateStamp}/${input.region}/tos/request`;
  const signedHeaders: Record<string, string> = { host, "x-tos-date": dateTime };
  if (input.contentType !== undefined) signedHeaders["content-type"] = input.contentType;
  const { block, signed } = canonicalHeaders(signedHeaders);
  const canonical = canonicalRequest(input.method ?? "PUT", uri, "", block, signed, EMPTY_BODY_SHA256);
  const signature = sign(input.secretAccessKey, input.region, dateTime, dateStamp, canonical);
  return {
    ...(input.contentType === undefined ? {} : { "Content-Type": input.contentType }),
    "x-tos-date": dateTime,
    Authorization: `${TOS_ALGORITHM} Credential=${input.accessKeyId}/${scope},SignedHeaders=${signed},Signature=${signature}`,
  };
}

/** Time-limited GET. Only `host` is signed; the payload hash is UNSIGNED-PAYLOAD. */
export function presignTosGet(input: TosSignInput & { expiresSeconds: number }): string {
  const host = tosVirtualHost(input.bucket, input.endpoint);
  const uri = canonicalUri(input.key);
  const { dateTime, dateStamp } = tosTimestamp(input.now);
  const scope = `${dateStamp}/${input.region}/tos/request`;
  const params: Record<string, string> = {
    "X-Tos-Algorithm": TOS_ALGORITHM,
    "X-Tos-Credential": `${input.accessKeyId}/${scope}`,
    "X-Tos-Date": dateTime,
    "X-Tos-Expires": String(input.expiresSeconds),
    "X-Tos-SignedHeaders": "host",
  };
  const query = canonicalQuery(params);
  const canonical = canonicalRequest("GET", uri, query, `host:${host}`, "host", TOS_PAYLOAD_HASH);
  const signature = sign(input.secretAccessKey, input.region, dateTime, dateStamp, canonical);
  return `https://${host}${uri}?${query}&X-Tos-Signature=${signature}`;
}

export function tosPutCall(settings: TosConfig, up: PlannedTosUpload, headers: Record<string, string> = {}): HttpCall {
  const host = tosVirtualHost(settings.bucket, settings.endpoint);
  return {
    method: "PUT",
    url: `https://${host}${canonicalUri(up.key)}`,
    headers: {
      "Content-Type": up.mime,
      ...headers,
    },
    body: { kind: "file", path: up.path, contentType: up.mime },
  };
}

export async function describeTosUpload(source: string, kind: UploadKind, cwd: string, bucket: string): Promise<PlannedTosUpload> {
  const file = path.resolve(cwd, source);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(`local media not found: ${file}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { source, path: file, kind, mime: contentTypeFor(file), bytes: bytes.byteLength, sha256, bucket, key: tosObjectKey(file, sha256) };
}

export function tosEnvValue(
  env: NodeJS.ProcessEnv,
  preferred: string,
  aliases: readonly string[],
): { value?: string; from?: string; names: string[] } {
  const names = [preferred, ...aliases.filter((name) => name !== preferred)];
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), from: name, names };
  }
  return { names };
}

export function requireTosCredentials(settings: TosConfig, env: NodeJS.ProcessEnv): { accessKeyId: string; secretAccessKey: string } {
  const access = tosEnvValue(env, settings.accessKeyEnv, TOS_ACCESS_KEY_ALIASES);
  const secret = tosEnvValue(env, settings.secretKeyEnv, TOS_SECRET_KEY_ALIASES);
  if (access.value !== undefined && secret.value !== undefined) {
    return { accessKeyId: access.value, secretAccessKey: secret.value };
  }
  const missing = [
    access.value === undefined ? `access key ${access.names.join(" or ")}` : undefined,
    secret.value === undefined ? `secret key ${secret.names.join(" or ")}` : undefined,
  ].filter((item): item is string => item !== undefined);
  throw new CliError(
    `tos upload needs ${missing.join(" and ")}\nAdd "tos": {} (or a full tos block) and set VOLC_ACCESSKEY and VOLC_SECRETKEY. Values are not stored in config.`,
  );
}

export function tosDoctorLine(settings: TosConfig | undefined, env: NodeJS.ProcessEnv): string {
  if (settings === undefined) return "tos: not configured";
  const access = tosEnvValue(env, settings.accessKeyEnv, TOS_ACCESS_KEY_ALIASES);
  const secret = tosEnvValue(env, settings.secretKeyEnv, TOS_SECRET_KEY_ALIASES);
  const accessText = access.from === undefined ? `missing (${access.names.join(" or ")})` : `present (${access.from})`;
  const secretText = secret.from === undefined ? `missing (${secret.names.join(" or ")})` : `present (${secret.from})`;
  return `tos: ${settings.bucket} ${settings.region} ${settings.endpoint} access ${accessText} secret ${secretText}`;
}

function retriable(err: unknown): boolean {
  if (!(err instanceof TransportError)) return true;
  const status = asRecord(err.response)?.status;
  return typeof status !== "number" || status === 408 || status === 429 || status >= 500;
}

async function withRetry<T>(io: IO, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!retriable(err) || attempt >= UPLOAD_RETRIES) throw err;
      const ms = Number(io.env.SEEDANCE_POLL_MS ?? 2_000);
      await pause(io, Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 2_000) * (attempt + 1) : 2_000);
    }
  }
}

/**
 * Upload distinct local files to TOS and map each source to a presigned https GET.
 * Dry-run records the PUT and uses {{upload:sha256}} and does not send.
 * Keys are still required, so a missing AK/SK fails before any request.
 * The same sha256 is uploaded once per run.
 */
export async function mapLocalMediaViaTos(
  locals: Array<{ source: string; kind: UploadKind }>,
  settings: TosConfig,
  mode: RunMode,
  io: IO,
  calls: HttpCall[],
): Promise<{ urls: Map<string, string>; plannedUploads: PlannedTosUpload[] }> {
  const described = await Promise.all(locals.map((item) => describeTosUpload(item.source, item.kind, io.cwd, settings.bucket)));
  const plannedUploads = described.filter((item, index) => described.findIndex((other) => other.sha256 === item.sha256) === index);
  const creds = requireTosCredentials(settings, io.env);
  if (mode === "dry-run") {
    for (const up of plannedUploads) calls.push(tosPutCall(settings, up));
    return {
      urls: new Map(described.map((item) => [item.source, `{{upload:${item.sha256}}}`])),
      plannedUploads,
    };
  }
  const opts: SendOptions = { mode, fetchImpl: fetchOf(io), auth: false, timeoutMs: TOS_UPLOAD_TIMEOUT_MS };
  const bySha = new Map<string, string>();
  for (const up of plannedUploads) {
    const now = io.now?.() ?? new Date();
    const headers = tosPutAuthHeaders({
      bucket: settings.bucket,
      endpoint: settings.endpoint,
      region: settings.region,
      key: up.key,
      contentType: up.mime,
      now,
      ...creds,
    });
    await withRetry(io, () => perform(calls, tosPutCall(settings, up, headers), opts));
    bySha.set(
      up.sha256,
      presignTosGet({
        bucket: settings.bucket,
        endpoint: settings.endpoint,
        region: settings.region,
        key: up.key,
        now,
        expiresSeconds: TOS_PRESIGN_SECONDS,
        ...creds,
      }),
    );
  }
  return {
    urls: new Map(described.map((item) => [item.source, bySha.get(item.sha256)!])),
    plannedUploads,
  };
}
