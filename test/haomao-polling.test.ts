import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { haomaoTaskState } from "../src/clients/jobs.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://h.example/api/v3";

async function bind(dir: string): Promise<void> {
  const cap = capture();
  assert.equal(await run(["providers", "set", "seedance-2-fast", "--provider", "haomao", "--base-url", BASE, "--api-key-env", "HK", "--project", dir], cap.io), 0, cap.err());
}

function fakeFetch(statuses: Array<string | number>): { fetch: (url: string) => Promise<Response>; polls: () => number } {
  let polls = 0;
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith("/contents/generations/tasks")) return Response.json({ id: "cgt-1", status: "queued" });
    if (url.includes("/contents/generations/tasks/")) {
      const s = statuses[Math.min(polls, statuses.length - 1)]!;
      polls += 1;
      if (typeof s === "number") return new Response("busy", { status: s });
      return Response.json(s === "succeeded" ? { id: "cgt-1", status: s, content: { video_url: "https://cdn.example/v.mp4" } } : { id: "cgt-1", status: s });
    }
    if (url === "https://cdn.example/v.mp4") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected ${url}`);
  };
  return { fetch: fetch as never, polls: () => polls };
}

const args = (dir: string) => ["gen", "video", "--model", "seedance-2-fast", "--shape", "text", "--prompt", "p", "--aspect-ratio", "16:9", "--resolution", "720p", "--duration", "5", "--out", "out/v.mp4", "--execute", "--project", dir];

test("non-terminal statuses keep polling", () => {
  for (const s of ["queued", "pending", "running", "processing", "in_progress", "submitted", "weird", ""]) assert.equal(haomaoTaskState({ status: s }), "pending", s);
  for (const s of ["failed", "cancelled", "expired"]) assert.equal(haomaoTaskState({ status: s }), "fail");
  assert.equal(haomaoTaskState({ status: "succeeded" }), "ok");
});

test("processing then succeeded downloads the video; transient 5xx is retried", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["processing", 503, "processing", "succeeded"]);
    const cap = capture({ ...process.env, HK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run(args(dir), cap.io), 0, cap.err());
    assert.deepEqual([...(await readFile(path.join(dir, "out/v.mp4")))], [1, 2, 3]);
  });
});

test("timeout leaves the run running and runs resume finishes it", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["processing"]);
    const cap = capture({ ...process.env, HK: "k", SEEDANCE_POLL_MS: "0", SEEDANCE_MAX_POLLS: "3" }, { fetch: f.fetch, cwd: dir });
    assert.equal(await run(args(dir), cap.io), 0, cap.err());
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    assert.match(cap.out(), /^running seedance-2-fast/m);
    assert.match(cap.out(), new RegExp(`lumen runs resume ${id}`));
    const file = path.join(dir, ".lumen/runs", id, "record.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    assert.equal(rec.status, "running");
    assert.equal(rec.pending.taskId, "cgt-1");

    const later = fakeFetch(["processing", "succeeded"]);
    const res = capture({ ...process.env, HK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: later.fetch, cwd: dir });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    assert.match(res.out(), /wrote: .*v\.mp4/);
    const done = JSON.parse(await readFile(file, "utf8"));
    assert.equal(done.status, "ok");
    assert.equal(done.pending, undefined);
  });
});

test("resume recovers a pre-0.1.5 run recorded as error", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeFetch(["processing"]);
    const cap = capture({ ...process.env, HK: "k", SEEDANCE_POLL_MS: "0", SEEDANCE_MAX_POLLS: "1" }, { fetch: f.fetch, cwd: dir });
    await run(args(dir), cap.io);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const file = path.join(dir, ".lumen/runs", id, "record.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    delete rec.pending;
    Object.assign(rec, { status: "error", error: "haomao task cgt-1 processing" });
    await writeFile(file, JSON.stringify(rec));
    const res = capture({ ...process.env, HK: "k", SEEDANCE_POLL_MS: "0" }, { fetch: fakeFetch(["succeeded"]).fetch, cwd: dir });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    assert.deepEqual([...(await readFile(path.join(dir, "out/v.mp4")))], [1, 2, 3]);
  });
});
