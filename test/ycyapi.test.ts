import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ycyapiTaskState, ycyapiWireModel } from "../src/clients/ycyapi.js";
import { PROVIDER_DEFAULT_BASE_URLS, assertVideoProviderRules, validateVideo } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://y.example";

async function bind(dir: string, extra: string[] = []): Promise<void> {
  const cap = capture();
  assert.equal(
    await run(
      ["providers", "set", "seedance-2.5", "--provider", "ycyapi", "--base-url", BASE, "--api-key-env", "YK", ...extra, "--project", dir],
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

test("ycyapi rejects frame, task-type, adaptive, duration -1, and local refs", () => {
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
  assert.throws(() => assertVideoProviderRules(local, "ycyapi"), /https:\/\//);
});

test("ycyapi execute: submits /v1/videos with seedance2.5-A, polls, downloads /content", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["queued", 503, "in_progress", "completed"]);
    const cap = capture({ ...process.env, YK: "secret-k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
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
    await bind(dir, ["--model-alias", "seedance2.5-custom"]);
    const f = fakeFetch(["completed"]);
    const dry = capture({ ...process.env, YK: "k" }, { fetch: f.fetch, cwd: dir });
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
    const set = capture();
    assert.equal(
      await run(["providers", "set", "seedance-2.5", "--provider", "ycyapi", "--api-key-env", "YCYAPI_API_KEY", "--project", dir], set.io),
      0,
      set.err(),
    );
    assert.match(set.out(), /https:\/\/ycyapi\.cn \(default\)/);
  });
});
