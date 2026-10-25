import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { IO } from "../src/io.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return undefined;
  const value = headers.Authorization;
  return typeof value === "string" ? value : undefined;
}

async function bind(dir: string, model: string, provider: string, base: string, envName: string, group?: string): Promise<void> {
  const args = ["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", envName, "--project", dir];
  if (group !== undefined) args.push("--group", group);
  const cap = capture();
  assert.equal(await run(args, cap.io), 0, cap.err());
}

test("seedance aliases and dry-run include the poll plan", async () => {
  await withDir(async (dir) => {
    await bind(dir, "standard", "haomao", "https://haomao.example/api/v3", "HAOMAO");
    await bind(dir, "2.5", "haomao", "https://haomao.example/api/v3", "HAOMAO25");
    const config = JSON.parse(await readFile(path.join(dir, "lumen.config.json"), "utf8")) as {
      models: Record<string, { provider: string }>;
    };
    assert.equal(config.models["seedance-2"]?.provider, "haomao");
    assert.equal(config.models["seedance-2.5"]?.provider, "haomao");
    assert.equal(config.models.standard, undefined);

    const named = capture();
    assert.equal(await run(["models", "fast"], named.io), 0, named.err());
    assert.match(named.out(), /seedance-2-fast/);

    const text = capture();
    assert.equal(
      await run(
        ["gen", "video", "--model", "standard", "--shape", "TextVideo", "--prompt", "a cat walks", "--duration", "5", "--project", dir],
        text.io,
      ),
      0,
      text.err(),
    );
    const frame = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "2.5", "--shape", "ReferenceVideo", "--prompt", "match", "--duration", "-1",
          "--aspect-ratio", "adaptive", "--ref", "video|https://cdn.example/src.mp4|true", "--project", dir,
        ],
        frame.io,
      ),
      0,
      frame.err(),
    );
    const root = path.join(dir, ".lumen", "runs");
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(root);
    const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(root, name, "record.json"), "utf8")) as {
      modelId: string;
      params: { shape?: string };
      calls: Array<{ url: string }>;
    }));
    const cat = records.find((record) => record.modelId === "seedance-2");
    const edit = records.find((record) => record.modelId === "seedance-2.5");
    assert.equal(cat?.params.shape, "text");
    assert.ok(cat?.calls.some((call) => call.url.endsWith("/contents/generations/tasks/{{task_id}}")));
    assert.equal(edit?.params.shape, "reference");
    assert.ok(edit?.calls.some((call) => call.url.endsWith("/contents/generations/tasks/{{task_id}}")));
  });
});

test("execute polls a haomao task and saves the mp4", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2", "haomao", "https://cat.example/api/v3", "CAT");
    await bind(dir, "seedance-2-fast", "haomao", "https://fast.example/api/v3", "FAST");
    const secret = "https://cdn.example/clip.mp4?auth_key=supersecretkey";
    let slept = 0;
    let catPolls = 0;
    let fastPolls = 0;
    const fetchImpl: IO["fetch"] = async (url, init) => {
      if (url === "https://cat.example/api/v3/contents/generations/tasks") {
        assert.equal(authOf(init), "Bearer cat-secret-value");
        return jsonResponse({ id: "cgt-cat", status: "queued" });
      }
      if (url.endsWith("/contents/generations/tasks/cgt-cat")) {
        catPolls += 1;
        assert.equal(authOf(init), "Bearer cat-secret-value");
        if (catPolls === 1) return jsonResponse({ id: "cgt-cat", status: "running" });
        return jsonResponse({ id: "cgt-cat", status: "succeeded", content: { video_url: secret } });
      }
      if (url === "https://fast.example/api/v3/contents/generations/tasks") {
        assert.equal(authOf(init), "Bearer fast-secret-value");
        return jsonResponse({ id: "cgt-fast", status: "queued" });
      }
      if (url.endsWith("/contents/generations/tasks/cgt-fast")) {
        fastPolls += 1;
        assert.equal(authOf(init), "Bearer fast-secret-value");
        if (fastPolls === 1) return jsonResponse({ id: "cgt-fast", status: "running" });
        return jsonResponse({ id: "cgt-fast", status: "succeeded", content: { video_url: secret } });
      }
      if (url === secret) {
        assert.equal(authOf(init), undefined);
        return new Response(Buffer.from("cat-mp4"), { status: 200, headers: { "content-type": "video/mp4" } });
      }
      return jsonResponse({ error: url }, 404);
    };
    const env = { CAT: "cat-secret-value", FAST: "fast-secret-value", SEEDANCE_POLL_MS: "25", SEEDANCE_MAX_POLLS: "5" };
    const sleep = async (): Promise<void> => {
      slept += 1;
    };
    const cat = capture(env, { fetch: fetchImpl, sleep });
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "a cat walks", "--duration", "5", "--execute", "--project", dir, "--out", "out/cat.mp4"],
        cat.io,
      ),
      0,
      cat.err(),
    );
    const clip = capture(env, { fetch: fetchImpl, sleep });
    assert.equal(
      await run(
        ["gen", "video", "--model", "fast", "--shape", "FrameVideo", "--prompt", "hold", "--duration", "5", "--execute", "--first-frame", "https://cdn.example/a.png", "--first-person", "false", "--project", dir, "--out", "out/fast.mp4"],
        clip.io,
      ),
      0,
      clip.err(),
    );
    assert.equal(await readFile(path.join(dir, "out", "cat.mp4"), "utf8"), "cat-mp4");
    assert.equal(await readFile(path.join(dir, "out", "fast.mp4"), "utf8"), "cat-mp4");
    const catReceipt = await readFile(path.join(dir, "out", "cat.seedance.json"), "utf8");
    const fastReceipt = await readFile(path.join(dir, "out", "fast.seedance.json"), "utf8");
    assert.equal(catReceipt.includes("supersecretkey"), false);
    assert.equal(fastReceipt.includes("supersecretkey"), false);
    assert.match(catReceipt, /\?\[redacted\]/);
    assert.match(fastReceipt, /\?\[redacted\]/);
    assert.equal(catPolls, 2);
    assert.equal(fastPolls, 2);
    assert.equal(slept, 2);

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(path.join(dir, ".lumen", "runs"));
    const dumped = (await Promise.all(names.map(async (name) => readFile(path.join(dir, ".lumen", "runs", name, "record.json"), "utf8")))).join("\n");
    assert.equal(dumped.includes("supersecretkey"), false);
    assert.equal(dumped.includes("cat-secret-value"), false);
    assert.equal(dumped.includes("fast-secret-value"), false);
    assert.match(dumped, /\/contents\/generations\/tasks\/cgt-cat/);
    assert.match(dumped, /\/contents\/generations\/tasks\/cgt-fast/);
    assert.equal(dumped.includes("{{task_id}}"), false);
  });
});

test("a failed seedance job keeps the poll calls in the audit", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2-mini", "haomao", "https://haomao.example/api/v3", "HAOMAO");
    const fetchImpl: IO["fetch"] = async (url) => {
      if (url.endsWith("/contents/generations/tasks")) return jsonResponse({ id: "cgt-x", status: "queued" });
      if (url.endsWith("/contents/generations/tasks/cgt-x")) return jsonResponse({ id: "cgt-x", status: "failed" });
      return jsonResponse({ error: "unexpected" }, 500);
    };
    const cap = capture({ HAOMAO: "haomao-secret-value", SEEDANCE_POLL_MS: "0" }, { fetch: fetchImpl });
    assert.equal(
      await run(
        ["gen", "video", "--model", "mini", "--shape", "text", "--prompt", "nope", "--duration", "4", "--execute", "--project", dir],
        cap.io,
      ),
      1,
    );
    assert.match(cap.err(), /failed/);
    const { readdir } = await import("node:fs/promises");
    const [name] = await readdir(path.join(dir, ".lumen", "runs"));
    assert.ok(name);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", name, "record.json"), "utf8")) as {
      status: string;
      calls: Array<{ url: string }>;
    };
    assert.equal(record.status, "error");
    assert.equal(record.calls.length, 2);
    assert.match(record.calls[1]?.url ?? "", /\/contents\/generations\/tasks\/cgt-x$/);
  });
});

test("fish clone and synth plan the official routes", async () => {
  await withDir(async (dir) => {
    await bind(dir, "voice-clone", "kitta", "https://fishaudio.org", "KITTA");
    await bind(dir, "voice-synthesis", "kitta", "https://fishaudio.org", "KITTA");
    const clone = capture();
    assert.equal(
      await run(["fish", "clone", "--text", "hello there", "--voice", "refs/take.wav", "--project", dir], clone.io),
      0,
      clone.err(),
    );
    const synth = capture();
    assert.equal(
      await run(["fish", "synth", "--speech", "hello there", "--voice", "voice-123", "--project", dir], synth.io),
      0,
      synth.err(),
    );
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(path.join(dir, ".lumen", "runs"));
    const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(dir, ".lumen", "runs", name, "record.json"), "utf8")) as {
      modelId: string;
      calls: Array<{ url: string; headers: Record<string, string>; body: { value?: Record<string, unknown> } }>;
    }));
    const cloned = records.find((record) => record.modelId === "voice-clone");
    const spoken = records.find((record) => record.modelId === "voice-synthesis");
    assert.match(cloned?.calls[0]?.url ?? "", /\/api\/open\/v1\/voices$/);
    assert.match(cloned?.calls[1]?.url ?? "", /\/api\/open\/v3\/speech\/tts$/);
    assert.match(spoken?.calls[0]?.url ?? "", /\/api\/open\/v3\/speech\/tts$/);
    assert.equal(spoken?.calls[0]?.body.value?.voiceId, "voice-123");
    assert.equal(spoken?.calls[0]?.body.value?.format, "mp3");
    assert.equal(spoken?.calls[0]?.body.value?.text, "hello there");
  });
});
