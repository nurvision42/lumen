import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { beeftvTaskState } from "../src/clients/beeftv.js";
import { PROVIDER_DEFAULT_BASE_URLS } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://b.example";

async function bind(dir: string, extra: string[] = []): Promise<void> {
  const cap = capture();
  assert.equal(await run(["providers", "set", "seedance-2-fast", "--provider", "beeftv", "--base-url", BASE, "--api-key-env", "BK", ...extra, "--project", dir], cap.io), 0, cap.err());
}

function fakeFetch(statuses: Array<string | number>) {
  const seen: Array<{ url: string; body?: unknown; auth?: string | null }> = [];
  let polls = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    if (url === `${BASE}/v1/videos`) return Response.json({ id: "task_1", object: "video", status: "queued" });
    if (url === `${BASE}/v1/videos/task_1`) {
      const s = statuses[Math.min(polls, statuses.length - 1)]!;
      polls += 1;
      if (typeof s === "number") return new Response("busy", { status: s });
      return Response.json({ id: "task_1", status: s, ...(s === "completed" ? { metadata: { url: "https://cdn.example/r.mp4" } } : {}) });
    }
    if (url === `${BASE}/v1/videos/task_1/content`) return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected ${url}`);
  };
  return { fetch: fetch as never, seen };
}

const args = (dir: string, extra: string[] = []) => ["gen", "video", "--model", "seedance-2-fast", "--shape", "text", "--prompt", "p", "--aspect-ratio", "16:9", "--resolution", "720p", "--duration", "5", "--out", "out/v.mp4", ...extra, "--project", dir];

test("beeftv default base url is the official domain", () => {
  assert.equal(PROVIDER_DEFAULT_BASE_URLS.beeftv, "https://enterprise.beefapi.com");
});

test("beeftv statuses: only completed/failed/expired end polling", () => {
  for (const s of ["queued", "in_progress", "unknown", "weird", ""]) assert.equal(beeftvTaskState({ status: s }), "pending", s);
  for (const s of ["failed", "expired"]) assert.equal(beeftvTaskState({ status: s }), "fail");
  assert.equal(beeftvTaskState({ status: "completed" }), "ok");
});

test("beeftv execute: submits /v1/videos with seedance-2.0-fast, polls through 503, downloads /content", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["queued", 503, "in_progress", "completed"]);
    const cap = capture({ ...process.env, BK: "secret-k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...args(dir), "--execute"], cap.io), 0, cap.err());
    assert.deepEqual([...(await readFile(path.join(dir, "out/v.mp4")))], [7, 8, 9]);
    const submit = f.seen[0]!;
    assert.equal(submit.url, `${BASE}/v1/videos`);
    assert.equal(submit.auth, "Bearer secret-k");
    assert.deepEqual(submit.body, { model: "seedance-2.0-fast", prompt: "p", duration: 5, resolution: "720p", metadata: { ratio: "16:9", generate_audio: false } });
  });
});

test("beeftv modelAlias overrides the wire id; dry-run sends nothing", async () => {
  await withDir(async (dir) => {
    await bind(dir, ["--model-alias", "seedance-2.0-fast-x"]);
    const f = fakeFetch(["completed"]);
    const cap = capture({ ...process.env, BK: "k" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...args(dir), "--dry-run"], cap.io), 0, cap.err());
    assert.equal(f.seen.length, 0);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8"));
    assert.equal(rec.calls[0].url, `${BASE}/v1/videos`);
    assert.equal(rec.calls[0].body.value.model, "seedance-2.0-fast-x");
  });
});

function uploadFetch(opts: { failStartOnce?: boolean } = {}) {
  const seen: Array<{ method: string; url: string; body?: unknown; auth: string | null; headers: Headers; raw?: unknown }> = [];
  let n = 0;
  let failed = false;
  const tickets = new Map<string, string>();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    seen.push({ method, url, auth: headers.get("authorization"), headers, raw: init?.body, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    if (url === `${BASE}/v1/video-references/uploads` && method === "POST") {
      if (opts.failStartOnce && !failed) { failed = true; return new Response("down", { status: 502 }); }
      const body = JSON.parse(String(init?.body));
      n += 1;
      const t = `tk${n}`;
      tickets.set(t, body.sha256);
      return Response.json({ ticket: t, upload_method: "PUT", upload_url: `https://s3.example/obj${n}?X-Sig=abc`, required_headers: { "Content-Length": String(body.bytes), "Content-Type": body.mime }, expires_at: "x", upload_expires_at: "y" });
    }
    if (url.startsWith("https://s3.example/") && method === "PUT") return new Response(null, { status: 200 });
    if (url === `${BASE}/v1/video-references/uploads/complete`) {
      const t = JSON.parse(String(init?.body)).ticket;
      return Response.json({ url: `https://ref.example/${tickets.get(t)}`, bytes: 1, kind: "image", mime: "image/png", sha256: tickets.get(t), expires_at: "z" });
    }
    if (url === `${BASE}/v1/videos`) return Response.json({ id: "task_1", status: "queued" });
    if (url === `${BASE}/v1/videos/task_1`) return Response.json({ id: "task_1", status: "completed" });
    if (url === `${BASE}/v1/videos/task_1/content`) return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch: fetch as never, seen };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("beeftv uploads local refs: start, PUT presigned without auth, complete; same sha uploads once", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await writeFile(path.join(dir, "a-copy.png"), "AAA");
    await writeFile(path.join(dir, "v.mp4"), "VVVV");
    await writeFile(path.join(dir, "s.mp3"), "SS");
    await bind(dir);
    const f = uploadFetch({ failStartOnce: true });
    const cap = capture({ ...process.env, BK: "secret-k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run(["gen", "video", "--model", "seedance-2-fast", "--shape", "reference", "--prompt", "p", "--duration", "5",
      "--ref", "image|a.png|false", "--ref", "image|a-copy.png|false", "--ref", "image|https://e.example/x.png|false",
      "--ref", "video|v.mp4|false", "--ref", "audio|s.mp3", "--out", "out/v.mp4", "--execute", "--project", dir], cap.io), 0, cap.err());
    const starts = f.seen.filter((c) => c.url.endsWith("/uploads") && c.method === "POST");
    assert.equal(starts.length, 4); // 1 failed 502 + 3 distinct files
    assert.deepEqual(starts[1]!.body, { bytes: 3, kind: "image", mime: "image/png", sha256: sha("AAA"), resumable: true });
    assert.equal(starts[1]!.auth, "Bearer secret-k");
    const puts = f.seen.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 3);
    for (const p of puts) assert.equal(p.auth, null);
    assert.equal(puts[0]!.headers.get("content-type"), "image/png");
    const submit = f.seen.find((c) => c.url === `${BASE}/v1/videos`)!;
    assert.deepEqual((submit.body as { content: unknown }).content, [
      { type: "image_url", image_url: { url: `https://ref.example/${sha("AAA")}` }, role: "reference_image" },
      { type: "image_url", image_url: { url: `https://ref.example/${sha("AAA")}` }, role: "reference_image" },
      { type: "image_url", image_url: { url: "https://e.example/x.png" }, role: "reference_image" },
      { type: "video_url", video_url: { url: `https://ref.example/${sha("VVVV")}` }, role: "reference_video" },
      { type: "audio_url", audio_url: { url: `https://ref.example/${sha("SS")}` }, role: "reference_audio" },
    ]);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const raw = await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8");
    assert.doesNotMatch(raw, /X-Sig|secret-k/);
  });
});

test("beeftv first and last frames upload too; dry-run lists planned uploads and sends nothing", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "f.png"), "F");
    await writeFile(path.join(dir, "l.png"), "L");
    await bind(dir);
    const f = uploadFetch();
    const dry = capture({ ...process.env, BK: "k" }, { fetch: f.fetch, cwd: dir });
    const base = ["gen", "video", "--model", "seedance-2-fast", "--shape", "frame", "--prompt", "p", "--duration", "5", "--first-frame", "f.png", "--first-person", "false", "--last-frame", "l.png", "--last-person", "false", "--out", "out/v.mp4", "--project", dir];
    assert.equal(await run([...base, "--dry-run"], dry.io), 0, dry.err());
    assert.equal(f.seen.length, 0);
    const id = /run: (\S+)/.exec(dry.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8"));
    assert.equal(rec.response.plannedUploads.length, 2);
    assert.equal(rec.calls[0].url, `${BASE}/v1/video-references/uploads`);
    const ex = capture({ ...process.env, BK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...base, "--execute"], ex.io), 0, ex.err());
    const submit = f.seen.find((c) => c.url === `${BASE}/v1/videos`)!;
    const body = submit.body as Record<string, unknown>;
    assert.equal(body.image, undefined);
    assert.deepEqual(body.content, [
      { type: "image_url", image_url: { url: `https://ref.example/${sha("F")}` }, role: "first_frame" },
      { type: "image_url", image_url: { url: `https://ref.example/${sha("L")}` }, role: "last_frame" },
    ]);
  });
});

test("beeftv timeout leaves the run running and runs resume finishes it", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["in_progress"]);
    const cap = capture({ ...process.env, BK: "k", SEEDANCE_POLL_MS: "0", SEEDANCE_MAX_POLLS: "2" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...args(dir), "--execute"], cap.io), 0, cap.err());
    assert.match(cap.out(), /^running seedance-2-fast/m);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const later = fakeFetch(["completed"]);
    const res = capture({ ...process.env, BK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: later.fetch, cwd: dir });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    assert.match(res.out(), /wrote: .*v\.mp4/);
    assert.equal(later.seen[0]!.url, `${BASE}/v1/videos/task_1`);
  });
});
