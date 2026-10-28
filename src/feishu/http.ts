import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import { fetchOf, type HttpMethod } from "../http.js";
import type { IO } from "../io.js";
import { redactText } from "../redact.js";

export interface MultipartField {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Uint8Array;
}

export function encodeMultipart(fields: readonly MultipartField[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (field.data !== undefined) {
      const filename = field.filename ?? "file";
      const type = field.contentType ?? "application/octet-stream";
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${field.name}"; filename="${filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${type}\r\n\r\n`));
      chunks.push(Buffer.from(field.data));
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value ?? ""}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

export interface RawResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  json?: unknown;
}

export async function request(
  io: IO,
  method: HttpMethod | "DELETE" | "PATCH",
  url: string,
  init: { headers?: Record<string, string>; body?: RequestInit["body"]; secrets?: readonly string[] } = {},
): Promise<RawResponse> {
  const headers = { ...(init.headers ?? {}) };
  let response: Response;
  try {
    response = await fetchOf(io)(url, { method, headers, body: init.body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Feishu request failed: ${redactText(message, init.secrets ?? [])}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  let json: unknown;
  if (contentType.includes("json") || looksLikeJson(bytes)) {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, contentType, bytes, ...(json === undefined ? {} : { json }) };
}

function looksLikeJson(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.byteLength > 2_000_000) return false;
  const first = bytes[0];
  return first === 0x7b || first === 0x5b;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function numberField(record: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function oauthError(json: unknown): string {
  const record = asObject(json);
  if (record === undefined) return "";
  const description = stringField(record, "error_description");
  if (description.length > 0) return description;
  return stringField(record, "error");
}

export async function postForm(
  io: IO,
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  secrets: readonly string[] = [],
): Promise<RawResponse> {
  const body = new URLSearchParams(fields);
  return request(io, "POST", url, {
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
    secrets,
  });
}

export interface ApiClient {
  io: IO;
  openBase: string;
  token: string;
  secrets: readonly string[];
}

export async function apiJson(
  client: ApiClient,
  method: HttpMethod | "DELETE" | "PATCH",
  apiPath: string,
  options: { query?: Record<string, string | undefined>; json?: unknown; multipart?: MultipartField[] } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${client.openBase}/open-apis${apiPath}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
  }
  let body: RequestInit["body"];
  const headers: Record<string, string> = { authorization: `Bearer ${client.token}` };
  if (options.multipart !== undefined) {
    const boundary = `lumen-${randomUUID()}`;
    body = encodeMultipart(options.multipart, boundary);
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json; charset=utf-8";
  }
  const response = await request(client.io, method, url.toString(), { headers, body, secrets: client.secrets });
  const record = asObject(response.json);
  const code = record === undefined ? undefined : record.code;
  if (response.status >= 400 || (typeof code === "number" && code !== 0)) {
    const msg = record === undefined ? response.status.toString() : stringField(record, "msg") || oauthError(response.json) || response.status.toString();
    const numeric = typeof code === "number" ? `${code} ` : "";
    throw new CliError(`Feishu API ${apiPath} failed: ${numeric}${redactText(msg, client.secrets)}`.trim());
  }
  if (record === undefined) throw new CliError(`Feishu API ${apiPath} returned no JSON`);
  return record;
}

export function dataOf(record: Record<string, unknown>): Record<string, unknown> {
  return asObject(record.data) ?? {};
}

export async function apiBytes(
  client: ApiClient,
  apiPath: string,
  query: Record<string, string | undefined> = {},
): Promise<Uint8Array> {
  const url = new URL(`${client.openBase}/open-apis${apiPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
  }
  const response = await request(client.io, "GET", url.toString(), {
    headers: { authorization: `Bearer ${client.token}` },
    secrets: client.secrets,
  });
  const record = asObject(response.json);
  const code = record?.code;
  if (response.status >= 400 || (typeof code === "number" && code !== 0) || (record !== undefined && response.contentType.includes("json"))) {
    const msg = stringField(record, "msg") || oauthError(response.json) || `HTTP ${response.status}`;
    throw new CliError(`Feishu API ${apiPath} failed: ${redactText(msg, client.secrets)}`);
  }
  return response.bytes;
}
