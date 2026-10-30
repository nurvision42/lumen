import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ycyapiTaskState, ycyapiWireModel } from "../src/clients/ycyapi.js";
import { PROVIDER_DEFAULT_BASE_URLS, assertVideoProviderRules, validateVideo } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://y.example";
const BEEF = "https://b.example";

/** Keep global ~/.config/lumen/providers.json from leaking beeftv into these tests. */
function isolatedEnv(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, XDG_CONFIG_HOME: path.join(dir, ".xdg-config") };
}

async function bindYcy(dir: string, extra: string[] = []): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(
      ["providers", "set", "seedance-2.5", "--provider", "ycyapi", "--base-url", BASE, "--api-key-env", "YK", ...extra, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

async function bindBeef(dir: string): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(
      ["providers", "set", "seedance-2-fast", "--provider", "beeftv", "--base-url", BEEF, "--api-key-env", "BK", "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
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
      return Response.json({ id: "task_1", status: s });
    }
    if (url === `${BASE}/v1/videos/task_1/content`) {
      return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch: fetch as never, seen };
}

function uploadAndVideoFetch() {
  const seen: Array<{ method: string; url: string; body?: unknown; auth: string | null; headers: Headers }> = [];
  let n = 0;
  const tickets = new Map<string, string>();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    seen.push({
      method,
      url,
      auth: headers.get("authorization"),
      headers,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (url === `${BEEF}/v1/video-references/uploads` && method === "POST") {
      const body = JSON.parse(String(init?.body));
      n += 1;
      const t = `tk${n}`;
      tickets.set(t, body.sha256);
      return Response.json({
        ticket: t,
        upload_method: "PUT",
        upload_url: `https://s3.example/obj${n}?X-Sig=abc`,
        required_headers: { "Content-Length": String(body.bytes), "Content-Type": body.mime },
      });
    }
    if (url.startsWith("https://s3.example/") && method === "PUT") return new Response(null, { status: 200 });
    if (url === `${BEEF}/v1/video-references/uploads/complete`) {
      const t = JSON.parse(String(init?.body)).ticket;
      return Response.json({ url: `https://ref.example/${tickets.get(t)}`, bytes: 1, kind: "image", mime: "image/png", sha256: tickets.get(t) });
    }
    if (url === `${BASE}/v1/videos`) return Response.json({ id: "task_1", status: "queued" });
    if (url === `${BASE}/v1/videos/task_1`) return Response.json({ id: "task_1", status: "completed" });
    if (url === `${BASE}/v1/videos/task_1/content`) {
      return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch: fetch as never, seen };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const args = (dir: string, extra: string[] = []) => [
  "gen",
  "video",
  "--model",
  "seedance-2.5",
  "--shape",
  "text",
  "--prompt",
  "p",
  "--aspect-ratio",
  "16:9",
  "--resolution",
  "720p",
  "--duration",
  "4",
  "--out",
  "out/v.mp4",
  ...extra,
  "--project",
  dir,
];

test("ycyapi default base url is the official domain", () => {
  assert.equal(PROVIDER_DEFAULT_BASE_URLS.ycyapi, "https://ycyapi.cn");
});

test("ycyapi wire model is seedance2.5-A unless aliased", () => {
  assert.equal(ycyapiWireModel("seedance-2.5", undefined), "seedance2.5-A");
  assert.equal(ycyapiWireModel("seedance-2.5", "custom-x"), "custom-x");
});

test("ycyapi statuses: only completed/failed/expired end polling", () => {
  for (const s of ["queued", "in_progress", "unknown", "weird", ""]) assert.equal(ycyapiTaskState({ status: s }), "pending", s);
  for (const s of ["failed", "expired", "cancelled"]) assert.equal(ycyapiTaskState({ status: s }), "fail");
  assert.equal(ycyapiTaskState({ status: "completed" }), "ok");
});

test("ycyapi rejects frame, task-type, adaptive, duration -1; allows local refs; rejects non-https schemes", () => {
  const base = {
    modelId: "seedance-2.5",
    shape: "text",
    prompt: "p",
    duration: "4",
    resolution: "720p",
    aspectRatio: "16:9",
    generateAudio: false,
    webSearch: false,
    firstFrame: undefined,
    firstPerson: undefined,
    lastFrame: undefined,
    lastPerson: undefined,
    references: [] as never[],
    taskType: undefined,
  };
  const text = validateVideo(base);
  assert.doesNotThrow(() => assertVideoProviderRules(text, "ycyapi"));

  const frame = validateVideo({
    ...base,
    shape: "frame",
    firstFrame: "https://e.example/f.png",
    firstPerson: "false",
  });
  assert.throws(() => assertVideoProviderRules(frame, "ycyapi"), /first\/last frame/);

  const auto = validateVideo({
    ...base,
    shape: "reference",
    references: [{ kind: "image", source: "https://e.example/a.png", personReference: false }],
    taskType: "auto",
  });
  assert.throws(() => assertVideoProviderRules(auto, "ycyapi"), /task-type/);

  const adaptive = validateVideo({ ...base, aspectRatio: "adaptive" });
  assert.throws(() => assertVideoProviderRules(adaptive, "ycyapi"), /adaptive/);

  const autoDur = validateVideo({ ...base, duration: "-1" });
  assert.throws(() => assertVideoProviderRules(autoDur, "ycyapi"), /4 to 30/);

  const local = validateVideo({
    ...base,
    shape: "reference",
    references: [{ kind: "image", source: "./a.png", personReference: false }],
  });
  assert.doesNotThrow(() => assertVideoProviderRules(local, "ycyapi"));

  const bad = validateVideo({
    ...base,
    shape: "reference",
    references: [{ kind: "image", source: "ftp://e.example/a.png", personReference: false }],
  });
  assert.throws(() => assertVideoProviderRules(bad, "ycyapi"), /https:\/\/|local file/);
});

test("ycyapi execute: submits /v1/videos with seedance2.5-A, polls, downloads /content", async () => {
  await withDir(async (dir) => {
    await bindYcy(dir);
    const f = fakeFetch(["queued", 503, "in_progress", "completed"]);
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-k", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...args(dir), "--execute"], cap.io), 0, cap.err());
    assert.deepEqual([...(await readFile(path.join(dir, "out/v.mp4")))], [7, 8, 9]);
    const submit = f.seen[0]!;
    assert.equal(submit.url, `${BASE}/v1/videos`);
    assert.equal(submit.auth, "Bearer secret-k");
    assert.deepEqual(submit.body, {
      model: "seedance2.5-A",
      prompt: "p",
      seconds: 4,
      resolution: "720p",
      aspect_ratio: "16:9",
    });
  });
});

test("ycyapi modelAlias overrides wire id; dry-run sends nothing; HTTPS refs land in references", async () => {
  await withDir(async (dir) => {
    await bindYcy(dir, ["--model-alias", "seedance2.5-custom"]);
    const f = fakeFetch(["completed"]);
    const dry = capture(isolatedEnv(dir, { ...process.env, YK: "k" }), { fetch: f.fetch, cwd: dir });
    assert.equal(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|https://e.example/a.png|false",
          "--ref",
          "video|https://e.example/v.mp4|false",
          "--out",
          "out/v.mp4",
          "--dry-run",
          "--project",
          dir,
        ],
        dry.io,
      ),
      0,
      dry.err(),
    );
    assert.equal(f.seen.length, 0);
    const id = /run: (\S+)/.exec(dry.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8"));
    assert.equal(rec.calls[0].url, `${BASE}/v1/videos`);
    assert.equal(rec.calls[0].body.value.model, "seedance2.5-custom");
    assert.deepEqual(rec.calls[0].body.value.references, [
      { type: "image", role: "reference", source: "https://e.example/a.png" },
      { type: "video", role: "reference", source: "https://e.example/v.mp4" },
    ]);
  });
});

test("ycyapi providers set uses default base url", async () => {
  await withDir(async (dir) => {
    const set = capture(isolatedEnv(dir));
    assert.equal(
      await run(["providers", "set", "seedance-2.5", "--provider", "ycyapi", "--api-key-env", "YCYAPI_API_KEY", "--project", dir], set.io),
      0,
      set.err(),
    );
    assert.match(set.out(), /https:\/\/ycyapi\.cn \(default\)/);
  });
});

test("ycyapi local refs upload via beeftv then land as https in references", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await writeFile(path.join(dir, "v.mp4"), "VVVV");
    await bindYcy(dir);
    await bindBeef(dir);
    const f = uploadAndVideoFetch();
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-y", BK: "secret-b", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|a.png|false",
          "--ref",
          "video|v.mp4|false",
          "--ref",
          "image|https://e.example/x.png|false",
          "--out",
          "out/v.mp4",
          "--execute",
          "--project",
          dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const starts = f.seen.filter((c) => c.url.endsWith("/uploads") && c.method === "POST");
    assert.equal(starts.length, 2);
    assert.equal(starts[0]!.auth, "Bearer secret-b");
    const puts = f.seen.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    for (const p of puts) assert.equal(p.auth, null);
    const submit = f.seen.find((c) => c.url === `${BASE}/v1/videos`)!;
    assert.equal(submit.auth, "Bearer secret-y");
    assert.deepEqual((submit.body as { references: unknown }).references, [
      { type: "image", role: "reference", source: `https://ref.example/${sha("AAA")}` },
      { type: "video", role: "reference", source: `https://ref.example/${sha("VVVV")}` },
      { type: "image", role: "reference", source: "https://e.example/x.png" },
    ]);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const raw = await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8");
    assert.doesNotMatch(raw, /X-Sig|secret-b|secret-y/);
  });
});

test("ycyapi https-only refs skip beeftv upload", async () => {
  await withDir(async (dir) => {
    await bindYcy(dir);
    // no beeftv binding — must still succeed with https-only
    const f = fakeFetch(["completed"]);
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-y", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|https://e.example/a.png|false",
          "--out",
          "out/v.mp4",
          "--execute",
          "--project",
          dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.equal(f.seen.length >= 1, true);
    assert.equal(f.seen[0]!.url, `${BASE}/v1/videos`);
    assert.ok(f.seen.every((c) => !c.url.includes("video-references")));
  });
});

test("ycyapi local refs without beeftv binding fail clearly", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "A");
    await bindYcy(dir);
    const f = fakeFetch(["completed"]);
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "k" }), { fetch: f.fetch, cwd: dir });
    assert.notEqual(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|a.png|false",
          "--out",
          "out/v.mp4",
          "--dry-run",
          "--project",
          dir,
        ],
        cap.io,
      ),
      0,
    );
    assert.match(cap.err(), /beeftv/);
    assert.equal(f.seen.length, 0);
  });
});

test("ycyapi local refs with beeftv binding but missing key fail on execute", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "A");
    await bindYcy(dir);
    await bindBeef(dir);
    const f = uploadAndVideoFetch();
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-y", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    // BK deliberately unset
    delete (cap.io.env as Record<string, string | undefined>).BK;
    assert.notEqual(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|a.png|false",
          "--out",
          "out/v.mp4",
          "--execute",
          "--project",
          dir,
        ],
        cap.io,
      ),
      0,
    );
    assert.match(cap.err(), /BK|beeftv API key/);
    assert.equal(f.seen.length, 0);
  });
});

test("ycyapi local refs dry-run plans beeftv upload without sending", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bindYcy(dir);
    await bindBeef(dir);
    const f = uploadAndVideoFetch();
    const dry = capture(isolatedEnv(dir, { ...process.env, YK: "y" }), { fetch: f.fetch, cwd: dir });
    // no BK needed for dry-run
    delete (dry.io.env as Record<string, string | undefined>).BK;
    assert.equal(
      await run(
        [
          "gen",
          "video",
          "--model",
          "seedance-2.5",
          "--shape",
          "reference",
          "--prompt",
          "p",
          "--duration",
          "5",
          "--aspect-ratio",
          "16:9",
          "--ref",
          "image|a.png|false",
          "--out",
          "out/v.mp4",
          "--dry-run",
          "--project",
          dir,
        ],
        dry.io,
      ),
      0,
      dry.err(),
    );
    assert.equal(f.seen.length, 0);
    const id = /run: (\S+)/.exec(dry.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8"));
    assert.equal(rec.response.plannedUploads.length, 1);
    assert.equal(rec.calls[0].url, `${BEEF}/v1/video-references/uploads`);
    assert.equal(rec.calls[1].url, `${BASE}/v1/videos`);
    assert.equal(rec.calls[1].body.value.references[0].source, `{{upload:${sha("AAA")}}}`);
  });
});
