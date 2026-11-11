import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";
import type { IO } from "./io.js";
import { redactText } from "./redact.js";

export type HttpMethod = "GET" | "POST" | "PUT";

export interface MultipartPart {
  name: string;
  text?: string;
  filePath?: string;
  filename?: string;
  contentType?: string;
}

export type HttpBody =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "file"; path: string; contentType: string }
  | { kind: "multipart"; parts: MultipartPart[] };

export interface HttpCall {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: HttpBody;
}

export interface HttpResult {
  status: number;
  contentType: string;
  bytes: number;
  json?: unknown;
  body: Uint8Array;
  /** Lowercase response headers we keep. Auth request headers are not copied here. */
  headers?: Record<string, string>;
}

export function joinUrl(base: string, path: string): string {
  const root = base.replace(/\/$/, "");
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

export function groupHeaders(provider: string, group: string | undefined): Record<string, string> {
  if (group === undefined || group.length === 0) return {};
  if (provider === "yunqiao") return { "X-Group": group };
  return {};
}

export class TransportError extends CliError {
  readonly calls: HttpCall[];
  readonly response: unknown;

  constructor(message: string, calls: HttpCall[], response: unknown) {
    super(message);
    this.name = "TransportError";
    this.calls = calls;
    this.response = response;
  }
}

export function publicResult(result: HttpResult): unknown {
  return {
    status: result.status,
    contentType: result.contentType,
    bytes: result.bytes,
    ...(result.json === undefined ? {} : { json: result.json }),
    ...(result.headers === undefined ? {} : { headers: result.headers }),
  };
}

export function fetchOf(io: IO): (input: string, init?: RequestInit) => Promise<Response> {
  return io.fetch ?? ((input, init) => fetch(input, init));
}

export async function pause(io: IO, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (io.sleep) {
    await io.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendOptions {
  mode: "execute" | "mock";
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  /** When false, the bearer token is not attached. Downloads use this. */
  auth?: boolean;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

function mockJson(call: HttpCall): unknown {
  const url = call.url;
  if (url.includes("request-media-upload-url")) {
    return {
      success: true,
      result: {
        file_id: "mediakit://mock-file",
        upload_url: "https://upload.example/put?auth_key=mockauthkeyvalue",
        method: "PUT",
        upload_headers: [],
      },
    };
  }
  if (call.method === "PUT") return { success: true };
  if (url.endsWith("/files/uploads")) return { url: "https://cdn.example/mock-upload.bin" };
  if (url.includes("video-understand-router") || url.includes("/enhance-video") || url.includes("asr-subtitles")) {
    return { success: true, task_id: "mock-task" };
  }
  if (url.includes("/api/v1/tasks/")) {
    return {
      success: true,
      status: "completed",
      result: {
        video_url: "mediakit://mock-video",
        contents: "mock understanding",
        duration: 2,
        subtitles: [{ start_time: 0.2, end_time: 1.5, subtitle_text: "mock line" }],
      },
    };
  }
  if (url.includes("/v1/jobs/") && url.endsWith("/status")) {
    return { id: "mock-yir-job", object: "job", status: "succeeded", error: null };
  }
  if (url.includes("/v1/jobs/")) {
    return {
      id: "mock-yir-job",
      object: "job",
      status: "succeeded",
      error: null,
      result: {
        availability: "available",
        files: [{ url: "https://cdn.example/mock.png", media_type: "image/png", width: 1024, height: 1024 }],
      },
    };
  }
  if (url.includes("/v1/files/") && url.endsWith("/complete")) {
    return {
      id: "file_11111111-1111-4111-8111-111111111111",
      object: "file",
      status: "ready",
      name: "ref.png",
      media_type: "image/png",
      size: 1,
    };
  }
  if ((url.includes("/v1/files/") && !url.endsWith("/files")) || /\/v1\/files\/[^/]+$/.test(url)) {
    return {
      id: "file_11111111-1111-4111-8111-111111111111",
      object: "file",
      status: "ready",
      name: "ref.png",
      media_type: "image/png",
      size: 1,
    };
  }
  if (url.replace(/\/$/, "").endsWith("/v1/files")) {
    return {
      files: [
        {
          id: "file_11111111-1111-4111-8111-111111111111",
          object: "file",
          status: "pending_upload",
          name: "ref.png",
          media_type: "image/png",
          size: 1,
          upload: {
            type: "multipart",
            expires_at: 1_790_000_900,
            parts: [{ part_number: 1, size: 1, url: "https://upload.example/part" }],
          },
        },
      ],
    };
  }
  if (url.includes("/v1/images/generations") && call.body.kind === "json") {
    const body = call.body.value;
    if (typeof body === "object" && body !== null && "input" in body) {
      return { id: "mock-yir-job", object: "job", status: "queued", error: null };
    }
  }
  if (url.includes("/images/")) return { created: 0, data: [{ b64_json: "aGVsbG8=" }] };
  if (url.includes("/contents/generations/tasks/")) {
    return { id: "mock-task", status: "succeeded", content: { video_url: "https://cdn.example/mock.mp4" } };
  }
  if (url.includes("/contents/generations/tasks")) return { id: "mock-task", status: "queued" };
  if (url.includes("/voice-designs")) {
    return { designId: "mock-design", candidates: [{ candidateId: "mock-candidate" }] };
  }
  if (url.includes("/api/open/v1/voices")) return { voiceId: "mock-voice-id" };
  if (url.includes("/speech/tts")) return { id: "mock-audio" };
  if (url.includes("/auc/bigmodel/submit")) return { task_id: "mock-seed-task" };
  if (url.includes("/auc/bigmodel/query")) {
    return {
      audio_info: { duration: 400 },
      result: { utterances: [{ start_time: 0, end_time: 400, text: "测", words: [{ text: "测", start_time: 0, end_time: 400 }] }] },
    };
  }
  return { ok: true };
}

const KEPT_RESPONSE_HEADERS = new Set(["x-api-status-code", "x-api-message", "x-tt-logid"]);

function asResult(
  status: number,
  contentType: string,
  body: Uint8Array,
  json?: unknown,
  headers?: Record<string, string>,
): HttpResult {
  return {
    status,
    contentType,
    bytes: body.byteLength,
    body,
    ...(json === undefined ? {} : { json }),
    ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

async function encodeMultipart(parts: MultipartPart[], boundary: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const push = (text: string): void => {
    chunks.push(Buffer.from(text));
  };
  for (const part of parts) {
    push(`--${boundary}\r\n`);
    if (part.filePath !== undefined) {
      const filename = part.filename ?? part.filePath.split(/[/\\]/).pop() ?? "file";
      const type = part.contentType ?? "application/octet-stream";
      push(`Content-Disposition: form-data; name="${part.name}"; filename="${filename}"\r\n`);
      push(`Content-Type: ${type}\r\n\r\n`);
      chunks.push(await readFile(part.filePath));
      push("\r\n");
      continue;
    }
    push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
    push(`${part.text ?? ""}\r\n`);
  }
  push(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

async function toInit(call: HttpCall, apiKey: string | undefined): Promise<RequestInit> {
  const headers: Record<string, string> = { ...call.headers };
  if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
  if (call.body.kind === "empty") return { method: call.method, headers };
  if (call.body.kind === "json") {
    headers["Content-Type"] ??= "application/json";
    return { method: call.method, headers, body: JSON.stringify(call.body.value) };
  }
  if (call.body.kind === "file") {
    if (headers["Content-Type"] === undefined) headers["Content-Type"] = call.body.contentType;
    const bytes = await readFile(call.body.path);
    return { method: call.method, headers, body: bytes };
  }
  const boundary = `lumen${Date.now().toString(16)}`;
  headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
  return { method: call.method, headers, body: await encodeMultipart(call.body.parts, boundary) };
}

export async function sendCall(call: HttpCall, opts: SendOptions): Promise<HttpResult> {
  if (opts.mode === "mock") {
    const json = mockJson(call);
    const body = Buffer.from(JSON.stringify(json));
    const headers = call.url.includes("/auc/bigmodel/")
      ? { "x-api-status-code": "20000000", "x-api-message": "OK" }
      : undefined;
    return asResult(200, "application/json", body, json, headers);
  }
  const auth = opts.auth === false ? undefined : opts.apiKey;
  let response: Response;
  try {
    const init = await toInit(call, auth);
    if (opts.timeoutMs !== undefined) init.signal = AbortSignal.timeout(opts.timeoutMs);
    response = await opts.fetchImpl(call.url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(redactText(message, opts.apiKey ? [opts.apiKey] : []));
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (KEPT_RESPONSE_HEADERS.has(name)) headers[name] = value;
  });
  let json: unknown;
  const text = Buffer.from(body).toString("utf8");
  if (contentType.includes("json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      json = text.length === 0 ? {} : (JSON.parse(text) as unknown);
    } catch {
      json = undefined;
    }
  }
  return asResult(response.status, contentType, body, json, headers);
}

export async function perform(
  calls: HttpCall[],
  call: HttpCall,
  opts: SendOptions,
): Promise<HttpResult> {
  calls.push(call);
  try {
    const result = await sendCall(call, opts);
    if (result.status >= 400) {
      const snippet = Buffer.from(result.body).toString("utf8").slice(0, 300);
      const message = redactText(`HTTP ${result.status} ${call.method} ${call.url} ${snippet}`, opts.apiKey ? [opts.apiKey] : []);
      throw new TransportError(message, calls, publicResult(result));
    }
    return result;
  } catch (err) {
    if (err instanceof TransportError) throw err;
    const message = redactText(err instanceof Error ? err.message : String(err), opts.apiKey ? [opts.apiKey] : []);
    throw new TransportError(message, calls, null);
  }
}
