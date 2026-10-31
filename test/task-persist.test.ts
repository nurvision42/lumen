import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

/**
 * Submit returns a remote id, then the first poll read of record.json must already
 * contain it. The poll then dies. Restoring that pre-poll snapshot simulates a kill
 * before settle's final write; resume must download the video from the saved id.
 */

interface Snap {
  id: string;
  json: string;
  md: string;
  record: {
    status: string;
    pending?: { provider: string; taskId: string; videoFile: string };
    calls: Array<{ method: string; url: string }>;
  };
}

function isolated(dir: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    HOME: path.join(dir, ".home"),
    XDG_CONFIG_HOME: path.join(dir, ".xdg"),
    SEEDANCE_POLL_MS: "0",
    MEDIAKIT_POLL_MS: "0",
  };
}

async function readSnap(dir: string): Promise<Snap> {
  const names = await readdir(path.join(dir, ".lumen", "runs"));
  const id = names.find((name) => !name.startsWith("."));
  if (id === undefined) throw new Error(`no run directory under ${dir}`);
  const root = path.join(dir, ".lumen", "runs", id);
  const json = await readFile(path.join(root, "record.json"), "utf8");
  const md = await readFile(path.join(root, "record.md"), "utf8");
  return { id, json, md, record: JSON.parse(json) as Snap["record"] };
}

async function bind(dir: string, env: NodeJS.ProcessEnv, model: string, provider: string, base: string, keyEnv: string): Promise<void> {
  const cap = capture(env);
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", keyEnv, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

const VIDEO = new Uint8Array([4, 5, 6]);

test("video providers persist the remote task id before the first poll", async () => {
  const cases: Array<{
    name: string;
    model: string;
    provider: string;
    base: string;
    keyEnv: string;
    taskId: string;
    args: (dir: string) => string[];
    submit: (url: string, method: string) => boolean;
    poll: (url: string, method: string) => boolean;
    resume: (url: string, method: string) => Response;
  }> = [
    {
      name: "haomao",
      model: "seedance-2-fast",
      provider: "haomao",
      base: "https://h.example/api/v3",
      keyEnv: "HK",
      taskId: "cgt-persist",
      args: (dir) => [
        "gen", "video", "--model", "seedance-2-fast", "--shape", "text", "--prompt", "p",
        "--aspect-ratio", "16:9", "--resolution", "720p", "--duration", "5", "--out", "out/v.mp4",
        "--execute", "--project", dir,
      ],
      submit: (url, method) => method === "POST" && url.endsWith("/contents/generations/tasks"),
      poll: (url, method) => method === "GET" && url.endsWith("/contents/generations/tasks/cgt-persist"),
      resume: (url, method) => {
        if (method === "GET" && url.endsWith("/contents/generations/tasks/cgt-persist")) {
          return Response.json({ id: "cgt-persist", status: "succeeded", content: { video_url: "https://cdn.example/v.mp4" } });
        }
        if (url === "https://cdn.example/v.mp4") return new Response(VIDEO, { headers: { "content-type": "video/mp4" } });
        throw new Error(`unexpected resume ${method} ${url}`);
      },
    },
    {
      name: "beeftv",
      model: "seedance-2-fast",
      provider: "beeftv",
      base: "https://b.example",
      keyEnv: "BK",
      taskId: "task_beef",
      args: (dir) => [
        "gen", "video", "--model", "seedance-2-fast", "--shape", "text", "--prompt", "p",
        "--aspect-ratio", "16:9", "--resolution", "720p", "--duration", "5", "--out", "out/v.mp4",
        "--execute", "--project", dir,
      ],
      submit: (url, method) => method === "POST" && url.endsWith("/v1/videos"),
      poll: (url, method) => method === "GET" && url.endsWith("/v1/videos/task_beef"),
      resume: (url, method) => {
        if (method === "GET" && url.endsWith("/v1/videos/task_beef")) return Response.json({ id: "task_beef", status: "completed" });
        if (url.endsWith("/v1/videos/task_beef/content")) return new Response(VIDEO, { headers: { "content-type": "video/mp4" } });
        throw new Error(`unexpected resume ${method} ${url}`);
      },
    },
    {
      name: "ycyapi",
      model: "seedance-2.5",
      provider: "ycyapi",
      base: "https://y.example",
      keyEnv: "YK",
      taskId: "task_ycy",
      args: (dir) => [
        "gen", "video", "--model", "seedance-2.5", "--shape", "text", "--prompt", "p",
        "--aspect-ratio", "16:9", "--resolution", "720p", "--duration", "4", "--out", "out/v.mp4",
        "--execute", "--project", dir,
      ],
      submit: (url, method) => method === "POST" && url.endsWith("/v1/videos"),
      poll: (url, method) => method === "GET" && url.endsWith("/v1/videos/task_ycy"),
      resume: (url, method) => {
        if (method === "GET" && url.endsWith("/v1/videos/task_ycy")) return Response.json({ id: "task_ycy", status: "completed" });
        if (url.endsWith("/v1/videos/task_ycy/content")) return new Response(VIDEO, { headers: { "content-type": "video/mp4" } });
        throw new Error(`unexpected resume ${method} ${url}`);
      },
    },
    {
      name: "mediakit",
      model: "enhance-video",
      provider: "mediakit",
      base: "https://m.example",
      keyEnv: "MK",
      taskId: "task_mk",
      args: (dir) => ["enhance", "--video", "https://cdn.example/in.mp4", "--out", "out/v.mp4", "--execute", "--project", dir],
      submit: (url, method) => method === "POST" && url.endsWith("/api/v1/tools/enhance-video"),
      poll: (url, method) => method === "GET" && url.endsWith("/api/v1/tasks/task_mk"),
      resume: (url, method) => {
        if (method === "GET" && url.endsWith("/api/v1/tasks/task_mk")) {
          return Response.json({ success: true, status: "completed", result: { video_url: "https://cdn.example/out.mp4" } });
        }
        if (url === "https://cdn.example/out.mp4") return new Response(VIDEO, { headers: { "content-type": "video/mp4" } });
        throw new Error(`unexpected resume ${method} ${url}`);
      },
    },
  ];

  for (const item of cases) {
    await withDir(async (dir) => {
      const env = isolated(dir, { [item.keyEnv]: "persist-key" });
      await bind(dir, env, item.model, item.provider, item.base, item.keyEnv);
      let snap: Snap | undefined;
      const killed = capture(env, {
        cwd: dir,
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          if (item.submit(String(url), method)) {
            const body = item.provider === "mediakit"
              ? { success: true, task_id: item.taskId }
              : { id: item.taskId, status: "queued" };
            return Response.json(body);
          }
          if (item.poll(String(url), method)) {
            // The poll request has started. The id must already be on disk.
            snap ??= await readSnap(dir);
            throw new Error("killed");
          }
          throw new Error(`unexpected submit ${method} ${url}`);
        },
      });
      assert.equal(await run(item.args(dir), killed.io), 1, `${item.name}\n${killed.err()}`);
      assert.ok(snap, `${item.name}: record.json was not readable when the first poll started`);
      assert.equal(snap.record.status, "running", item.name);
      assert.equal(snap.record.pending?.provider, item.provider, item.name);
      assert.equal(snap.record.pending?.taskId, item.taskId, item.name);
      assert.equal(snap.record.calls.some((call) => call.method === "GET"), false, `${item.name}: poll was recorded before the flush`);
      assert.match(snap.md, new RegExp(`task: ${item.provider} ${item.taskId}`));
      assert.match(snap.json, new RegExp(item.taskId));

      const settled = await readSnap(dir);
      assert.equal(settled.record.pending?.taskId, item.taskId, `${item.name}: final error record dropped the task id`);

      const root = path.join(dir, ".lumen", "runs", snap.id);
      await writeFile(path.join(root, "record.json"), snap.json);
      await writeFile(path.join(root, "record.md"), snap.md);

      const listed = capture(env, { cwd: dir });
      assert.equal(await run(["runs", "list", "--project", dir], listed.io), 0, listed.err());
      assert.match(listed.out(), new RegExp(`${snap.id}\\s+running\\s+${item.model}\\s+execute\\s+task ${item.taskId}`));
      const shown = capture(env, { cwd: dir });
      assert.equal(await run(["runs", "show", snap.id, "--project", dir], shown.io), 0, shown.err());
      assert.match(shown.out(), new RegExp(`task: ${item.provider} ${item.taskId}`));

      const resumed = capture(env, {
        cwd: dir,
        fetch: async (url, init) => item.resume(String(url), init?.method ?? "GET"),
      });
      assert.equal(await run(["runs", "resume", snap.id, "--project", dir], resumed.io), 0, `${item.name}\n${resumed.err()}`);
      const video = snap.record.pending?.videoFile;
      assert.ok(video, item.name);
      assert.deepEqual([...(await readFile(video))], [...VIDEO], item.name);
    });
  }
});
