import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
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

test("beeftv reference content items; local refs are rejected (no upload endpoint)", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const ok = capture({ ...process.env, BK: "k" }, { cwd: dir });
    assert.equal(await run(["gen", "video", "--model", "seedance-2-fast", "--shape", "reference", "--prompt", "p", "--duration", "5", "--ref", "image|https://e.example/a.png|true", "--dry-run", "--project", dir], ok.io), 0, ok.err());
    const id = /run: (\S+)/.exec(ok.out())![1]!;
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8"));
    assert.deepEqual(rec.calls[0].body.value.content, [{ type: "image_url", image_url: { url: "https://e.example/a.png" }, role: "reference_image" }]);
    await writeFile(path.join(dir, "a.png"), "x");
    const bad = capture({ ...process.env, BK: "k" }, { cwd: dir });
    assert.notEqual(await run(["gen", "video", "--model", "seedance-2-fast", "--shape", "reference", "--prompt", "p", "--duration", "5", "--ref", "image|a.png|true", "--dry-run", "--project", dir], bad.io), 0);
    assert.match(bad.err(), /beeftv has no upload endpoint/);
  });
});

test("beeftv local lone first frame goes inline as top-level image, kept out of the record", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "f.png"), "png");
    await bind(dir);
    const f = fakeFetch(["completed"]);
    const cap = capture({ ...process.env, BK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run(["gen", "video", "--model", "seedance-2-fast", "--shape", "frame", "--prompt", "p", "--duration", "5", "--first-frame", "f.png", "--first-person", "false", "--out", "out/v.mp4", "--execute", "--project", dir], cap.io), 0, cap.err());
    const body = f.seen[0]!.body as Record<string, unknown>;
    assert.equal(body.image, `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    assert.equal(body.content, undefined);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const raw = await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8");
    assert.doesNotMatch(raw, /base64/);
    assert.doesNotMatch(raw, /"k"/);
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
