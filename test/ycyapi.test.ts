import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TOS_PRESIGN_SECONDS } from "../src/clients/tos.js";
import { ycyapiTaskState, ycyapiWireModel } from "../src/clients/ycyapi.js";
import { PROVIDER_DEFAULT_BASE_URLS, assertVideoProviderRules, validateVideo } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://y.example";

/** Keep global ~/.config/lumen/providers.json from leaking into these tests. */
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

test("ycyapi https-only refs do not upload", async () => {
  await withDir(async (dir) => {
    await bindYcy(dir);
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
    assert.ok(f.seen.every((c) => !c.url.includes("video-references") && !c.url.includes(".volces.com")));
  });
});

async function enableTos(dir: string, tos: Record<string, unknown> = {}): Promise<void> {
  const file = path.join(dir, "lumen.config.json");
  const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  current.tos = tos;
  await writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
}

function tosAndVideoFetch() {
  const seen: Array<{ method: string; url: string; body?: unknown; auth: string | null; contentSha: string | null }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    seen.push({
      method,
      url,
      auth: headers.get("authorization"),
      contentSha: headers.get("x-tos-content-sha256"),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (method === "PUT" && url.includes(".tos-cn-beijing.volces.com/")) return new Response(null, { status: 200 });
    if (url === `${BASE}/v1/videos`) return Response.json({ id: "task_1", status: "queued" });
    if (url === `${BASE}/v1/videos/task_1`) return Response.json({ id: "task_1", status: "completed" });
    if (url === `${BASE}/v1/videos/task_1/content`) {
      return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch: fetch as never, seen };
}

const refArgs = (dir: string, refs: string[], extra: string[]) => [
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
  ...refs.flatMap((ref) => ["--ref", ref]),
  "--out",
  "out/v.mp4",
  ...extra,
  "--project",
  dir,
];

test("ycyapi local file is PUT to TOS and the presigned https URL lands in references", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await writeFile(path.join(dir, "v.mp4"), "VVVV");
    await bindYcy(dir);
    await enableTos(dir, {});
    const f = tosAndVideoFetch();
    const cap = capture(
      isolatedEnv(dir, {
        ...process.env,
        YK: "secret-y",
        VOLC_ACCESSKEY: "AKIDlumen42test",
        VOLC_SECRETKEY: "tos-secret-key-value",
        SEEDANCE_POLL_MS: "0",
      }),
      { fetch: f.fetch, cwd: dir },
    );
    assert.equal(
      await run(
        refArgs(dir, ["image|a.png|false", "image|a.png|false", "video|v.mp4|false", "image|https://e.example/x.png|false"], ["--execute"]),
        cap.io,
      ),
      0,
      cap.err(),
    );
    const puts = f.seen.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    assert.equal(puts[0]!.url, `https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png`);
    assert.equal(puts[1]!.url, `https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("VVVV")}.mp4`);
    for (const put of puts) {
      assert.equal(put.auth?.startsWith("TOS4-HMAC-SHA256 Credential=AKIDlumen42test/"), true);
      assert.match(put.auth ?? "", /SignedHeaders=content-type;host;x-tos-date,/);
      assert.equal(put.auth?.includes("tos-secret-key-value"), false);
      assert.equal(put.contentSha, null);
      assert.equal(put.auth?.startsWith("Bearer"), false);
    }
    assert.equal(f.seen.some((c) => c.url.includes("video-references")), false);
    const submit = f.seen.find((c) => c.url === `${BASE}/v1/videos`)!;
    assert.equal(submit.auth, "Bearer secret-y");
    const refs = (submit.body as { references: Array<{ type: string; role: string; source: string }> }).references;
    const imageUrl = refs[0]!.source;
    assert.equal(imageUrl, refs[1]!.source);
    assert.match(imageUrl, new RegExp(`^https://lumen42\\.tos-cn-beijing\\.volces\\.com/lumen-${sha("AAA")}\\.png\\?`));
    assert.match(imageUrl, /X-Tos-Algorithm=TOS4-HMAC-SHA256/);
    assert.match(imageUrl, new RegExp(`X-Tos-Expires=${TOS_PRESIGN_SECONDS}`));
    assert.match(imageUrl, /X-Tos-Signature=[0-9a-f]{64}/);
    assert.equal(imageUrl.includes("tos-secret-key-value"), false);
    assert.equal(refs[2]!.source.startsWith(`https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("VVVV")}.mp4?`), true);
    assert.equal(refs[3]!.source, "https://e.example/x.png");
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const raw = await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8");
    assert.doesNotMatch(raw, /tos-secret-key-value|AKIDlumen42test|X-Tos-Signature/);
    const rec = JSON.parse(raw) as { calls: Array<{ method: string; headers: { Authorization?: string } }> };
    assert.equal(rec.calls.find((call) => call.method === "PUT")?.headers.Authorization, "[redacted]");
  });
});

test("ycyapi https-only refs skip TOS upload", async () => {
  await withDir(async (dir) => {
    await bindYcy(dir);
    await enableTos(dir, {});
    const f = tosAndVideoFetch();
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-y", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(await run(refArgs(dir, ["image|https://e.example/a.png|false"], ["--execute"]), cap.io), 0, cap.err());
    assert.equal(f.seen.some((c) => c.method === "PUT"), false);
    assert.equal(f.seen[0]!.url, `${BASE}/v1/videos`);
    assert.deepEqual((f.seen[0]!.body as { references: unknown }).references, [
      { type: "image", role: "reference", source: "https://e.example/a.png" },
    ]);
  });
});

test("ycyapi local refs without tos fail and do not use beeftv", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bindYcy(dir);
    const beef = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["providers", "set", "seedance-2-fast", "--provider", "beeftv", "--base-url", "https://b.example", "--api-key-env", "BK", "--project", dir],
        beef.io,
      ),
      0,
      beef.err(),
    );
    const f = tosAndVideoFetch();
    const cap = capture(
      isolatedEnv(dir, {
        ...process.env,
        YK: "secret-y",
        BK: "secret-b",
        VOLC_ACCESSKEY: "AKIDlumen42test",
        VOLC_SECRETKEY: "tos-secret-key-value",
      }),
      { fetch: f.fetch, cwd: dir },
    );
    assert.notEqual(await run(refArgs(dir, ["image|a.png|false"], ["--execute"]), cap.io), 0);
    assert.match(cap.err(), /"tos": \{\}/);
    assert.match(cap.err(), /VOLC_ACCESSKEY/);
    assert.match(cap.err(), /VOLC_SECRETKEY/);
    assert.doesNotMatch(cap.err(), /beeftv/);
    assert.equal(f.seen.length, 0);
  });
});

test("ycyapi TOS dry-run plans the PUT and does not send", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bindYcy(dir);
    await enableTos(dir, { endpoint: "https://tos-cn-beijing.volces.com/" });
    const f = tosAndVideoFetch();
    const dry = capture(
      isolatedEnv(dir, { ...process.env, YK: "y", VOLC_ACCESSKEY: "AKIDlumen42test", VOLC_SECRETKEY: "tos-secret-key-value" }),
      { fetch: f.fetch, cwd: dir },
    );
    assert.equal(await run(refArgs(dir, ["image|a.png|false"], ["--dry-run"]), dry.io), 0, dry.err());
    assert.equal(f.seen.length, 0);
    const id = /run: (\S+)/.exec(dry.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      response: { plannedUploads: Array<{ key: string; bucket: string }> };
      calls: Array<{ method: string; url: string; headers: { Authorization?: string }; body: { value: { references: Array<{ source: string }> } } }>;
    };
    assert.equal(rec.response.plannedUploads.length, 1);
    assert.equal(rec.response.plannedUploads[0]!.bucket, "lumen42");
    assert.equal(rec.response.plannedUploads[0]!.key, `lumen-${sha("AAA")}.png`);
    assert.equal(rec.calls[0]!.method, "PUT");
    assert.equal(rec.calls[0]!.url, `https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png`);
    assert.equal(rec.calls[0]!.headers.Authorization, undefined);
    assert.equal(rec.calls[1]!.url, `${BASE}/v1/videos`);
    assert.equal(rec.calls[1]!.body.value.references[0]!.source, `{{upload:${sha("AAA")}}}`);
  });
});

test("ycyapi TOS without keys fails before any request", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "A");
    await bindYcy(dir);
    await enableTos(dir, {});
    const f = tosAndVideoFetch();
    const cap = capture(isolatedEnv(dir, { ...process.env, YK: "secret-y" }), { fetch: f.fetch, cwd: dir });
    for (const name of ["VOLC_ACCESSKEY", "VOLC_SECRETKEY", "VOLCENGINE_ACCESS_KEY", "VOLCENGINE_SECRET_KEY"]) {
      delete (cap.io.env as Record<string, string | undefined>)[name];
    }
    assert.notEqual(await run(refArgs(dir, ["image|a.png|false"], ["--dry-run"]), cap.io), 0);
    assert.match(cap.err(), /"tos": \{\}/);
    assert.match(cap.err(), /VOLC_ACCESSKEY/);
    assert.match(cap.err(), /VOLC_SECRETKEY/);
    assert.equal(f.seen.length, 0);
    const again = capture(cap.io.env, { fetch: f.fetch, cwd: dir });
    assert.notEqual(await run(refArgs(dir, ["image|a.png|false"], ["--execute"]), again.io), 0);
    assert.match(again.err(), /VOLC_ACCESSKEY/);
    assert.equal(f.seen.length, 0);
  });
});

test("ycyapi TOS accepts VOLCENGINE_ACCESS_KEY aliases and a custom bucket", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bindYcy(dir);
    await enableTos(dir, { bucket: "other-bucket" });
    const f = tosAndVideoFetch();
    const env = isolatedEnv(dir, {
      ...process.env,
      YK: "secret-y",
      VOLCENGINE_ACCESS_KEY: "AKIDaliasvalue",
      VOLCENGINE_SECRET_KEY: "alias-secret-key-value",
      SEEDANCE_POLL_MS: "0",
    });
    delete env.VOLC_ACCESSKEY;
    delete env.VOLC_SECRETKEY;
    const cap = capture(env, { fetch: f.fetch, cwd: dir });
    assert.equal(await run(refArgs(dir, ["image|a.png|false"], ["--execute"]), cap.io), 0, cap.err());
    const put = f.seen.find((c) => c.method === "PUT")!;
    assert.equal(put.url, `https://other-bucket.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png`);
    assert.match(put.auth ?? "", /Credential=AKIDaliasvalue\//);
    assert.equal((put.auth ?? "").includes("alias-secret-key-value"), false);
    const submit = f.seen.find((c) => c.url === `${BASE}/v1/videos`)!;
    const source = (submit.body as { references: Array<{ source: string }> }).references[0]!.source;
    assert.equal(source.startsWith(`https://other-bucket.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png?`), true);
  });
});
