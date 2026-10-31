import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BREAKDOWN_DEFAULT_PROMPT } from "../src/catalog.js";
import { mediakitPollLimits } from "../src/clients/mediakit.js";
import { enhanceCost } from "../src/enhance/cost.js";
import { BITRATE_FALLBACK_NOTE } from "../src/grain/apply.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

const KEY = "mediakit-test-key";
const SECRET = "supersecretvalue";
const GENERATIVE = "enhance-video-generative";

function withBin(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...extra,
  };
}

let cachedClip: Buffer | undefined;

async function tinyMp4(): Promise<Buffer> {
  if (cachedClip !== undefined) return cachedClip;
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-enhance-src-"));
  try {
    const file = path.join(dir, "clip.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.24",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      file,
    ]);
    cachedClip = await readFile(file);
    return cachedClip;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertGrained(file: string, source: Buffer): Promise<void> {
  const out = await readFile(file);
  assert.equal(out.equals(source), false);
  const { stdout } = await exec(FFPROBE, [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file,
  ]);
  assert.match(stdout, /h264/);
  assert.match(stdout, /aac/);
}

async function bind(dir: string, model: string, envName: string): Promise<void> {
  const cap = capture();
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", "mediakit", "--base-url", "https://mediakit.example", "--api-key-env", envName, "--group", "queue-1", "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

test("the built-in breakdown prompt is the 拉片表 wording", () => {
  assert.equal(
    BREAKDOWN_DEFAULT_PROMPT,
    `请对这个视频做逐镜头拉片分析，不要生成任何创作/生成用提示词。
按镜头输出表格，字段：
镜头序号｜起止时间码｜时长(秒)｜概述｜叙事作用｜景别｜画面元素｜镜头运动｜转场/剪辑｜字幕/台词｜声音/音乐｜情绪/节奏｜视觉风格｜备注/置信度
口径：
- 概述：只写画面事实和主要动作，不写长篇评论。
- 叙事作用：说明该镜头在注意力、信息推进、情绪、信任、卖点展示、转场中的作用。
- 景别：远景/全景/中景/中近景/近景/特写/大特写/屏幕录制/混合 选一。
- 镜头运动：固定、推近、拉远、横移、跟拍、环绕、摇镜、快速切换、屏幕滚动等。
- 转场/剪辑：硬切、跳切、闪白、叠化、缩放转场、字幕承接、动作承接、音频承接。
- 声音/音乐：口播、BGM、环境音、音效、停顿、重音；听不清标“未识别”。
短视频逐镜头完整分析。`,
  );
});

test("breakdown dry-run plans scene=editing and the built-in 拉片 prompt", async () => {
  await withDir(async (dir) => {
    await bind(dir, "video-understand-router", "MEDIAKIT_UNDERSTAND_KEY");
    let called = false;
    const cap = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        called = true;
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.equal(called, false);
    const names = await readdir(path.join(dir, ".lumen", "runs"));
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", names[0] ?? "", "record.json"), "utf8")) as {
      params: { prompt: string; scene: string };
      calls: unknown;
    };
    assert.equal(record.params.scene, "editing");
    assert.equal((record.params as { level?: string }).level, "Quality");
    assert.deepEqual((record.params as { preferModels?: string[] }).preferModels, ["doubao-seed-2-1-lite-260915"]);
    assert.equal((record.params as { needAudio?: boolean }).needAudio, true);
    assert.equal(record.params.prompt, BREAKDOWN_DEFAULT_PROMPT);
    const body = JSON.stringify(record.calls);
    assert.match(body, /video-understand-router/);
    assert.match(body, /"scene":"editing"/);
    assert.match(body, /"level":"Quality"/);
    assert.match(body, /"prefer_models":\["doubao-seed-2-1-lite-260915"\]/);
    assert.match(body, /"manual_option":\{"need_audio":true\}/);
    assert.equal(body.includes("prefer_endpoints"), false);
    const calls = record.calls as Array<{ url: string; body: { kind: string; value?: { prompt?: string } } }>;
    assert.equal(calls.find((call) => call.body.value?.prompt !== undefined)?.body.value?.prompt, BREAKDOWN_DEFAULT_PROMPT);
    const upload = calls.find((call) => call.url.includes("request-media-upload-url"));
    assert.deepEqual(upload?.body, { kind: "json", value: {} });
  });
});

test("a configured breakdown prompt replaces the built-in 拉片表", async () => {
  await withDir(async (dir) => {
    await bind(dir, "video-understand-router", "MEDIAKIT_UNDERSTAND_KEY");
    const configPath = path.join(dir, "lumen.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { breakdown?: Record<string, unknown> };
    config.breakdown = { ...(config.breakdown ?? {}), prompt: "only the cuts" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const cap = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    const names = await readdir(path.join(dir, ".lumen", "runs"));
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", names[0] ?? "", "record.json"), "utf8")) as {
      params: { prompt: string };
    };
    assert.equal(record.params.prompt, "only the cuts");
    assert.equal(record.params.prompt.includes("逐镜头拉片"), false);
  });
});

test("breakdown execute uploads, posts, polls, and writes a shot list", async () => {
  await withDir(async (dir) => {
    await bind(dir, "video-understand-router", "MEDIAKIT_UNDERSTAND_KEY");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    await writeFile(path.join(dir, "refs", "clip.mp4"), "fake");
    const seen: string[] = [];
    const cap = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async (input, init) => {
        const url = String(input);
        seen.push(`${init?.method ?? "GET"} ${url}`);
        const header = new Headers(init?.headers);
        if (url.includes("mediakit.example")) assert.equal(header.get("authorization"), `Bearer ${KEY}`);
        else assert.equal(header.get("authorization"), null);
        if (url.includes("request-media-upload-url")) {
          assert.equal(String(init?.body), "{}");
          assert.match(header.get("content-type") ?? "", /application\/json/);
          return Response.json({
            success: true,
            result: { file_id: "abc123", upload_url: `https://upload.example/put?auth_key=${SECRET}`, method: "PUT", upload_headers: [] },
          });
        }
        if (init?.method === "PUT") return new Response("", { status: 200 });
        if (url.includes("video-understand-router")) {
          const body = JSON.parse(String(init?.body)) as {
            scene?: string;
            level?: string;
            video_urls?: string[];
            prompt?: string;
            prefer_models?: string[];
            prefer_endpoints?: string[];
            manual_option?: { need_audio?: boolean };
          };
          assert.equal(body.scene, "editing");
          assert.equal(body.level, "Quality");
          assert.deepEqual(body.video_urls, ["mediakit://abc123"]);
          assert.equal(body.prompt, "find the cuts");
          assert.deepEqual(body.prefer_models, ["doubao-seed-2-1-lite-260915"]);
          assert.equal(body.prefer_endpoints, undefined);
          assert.deepEqual(body.manual_option, { need_audio: true });
          return Response.json({ success: true, task_id: "task-1" });
        }
        if (url.includes("/api/v1/tasks/")) {
          return Response.json({
            success: true,
            status: "completed",
            result: { shots: [{ "#": 1, durationSec: 1.5, frame: "door", vo: "" }] },
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(
      await run(["breakdown", "--prompt", "find the cuts", "--execute", "--project", dir], cap.io),
      0,
      cap.err(),
    );
    assert.ok(seen.some((line) => line.includes("request-media-upload-url")));
    assert.ok(seen.some((line) => line.startsWith("PUT ")));
    assert.ok(seen.some((line) => line.includes("video-understand-router")));
    assert.ok(seen.some((line) => line.includes("/api/v1/tasks/task-1")));
    const shotlist = JSON.parse(await readFile(path.join(dir, "shotlist.json"), "utf8")) as Array<{ frame: string }>;
    assert.equal(shotlist[0]?.frame, "door");
    const refs = await readdir(path.join(dir, "refs"));
    assert.ok(refs.some((name) => name.endsWith(".video-understand.json")));
    const audit = await readFile(path.join(dir, ".lumen", "runs", (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "", "record.json"), "utf8");
    assert.equal(audit.includes(SECRET), false);
    assert.equal(audit.includes(KEY), false);
  });
});

test("enhance execute downloads the mp4, grains it, and redacts the presigned query", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    await writeFile(path.join(dir, "refs", "clip.mp4"), "fake");
    const source = await tinyMp4();
    const auths: string[] = [];
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY }), {
      fetch: async (input, init) => {
        const url = String(input);
        const header = new Headers(init?.headers);
        const auth = header.get("authorization");
        if (auth) auths.push(auth);
        if (url.includes("request-media-upload-url")) {
          assert.equal(String(init?.body), "{}");
          assert.match(header.get("content-type") ?? "", /application\/json/);
          return Response.json({
            result: { file_id: "mediakit://file-9", upload_url: `https://upload.example/put?auth_key=${SECRET}` },
          });
        }
        if (init?.method === "PUT") return new Response("", { status: 200 });
        if (url.includes("/api/v1/tools/enhance-video-generative")) {
          const body = JSON.parse(String(init?.body)) as {
            video_url?: string;
            tool_version?: string;
            scene?: string;
            resolution?: string;
            fps?: number;
            bitrate_level?: string;
            enhance_style?: string;
            level?: string;
            queue_id?: string;
          };
          assert.equal(body.video_url, "mediakit://file-9");
          assert.equal(body.resolution, "2k");
          assert.equal(body.fps, 30);
          assert.equal(body.tool_version, undefined);
          assert.equal(body.scene, undefined);
          assert.equal(body.bitrate_level, undefined);
          assert.equal(body.enhance_style, undefined);
          assert.equal(body.level, undefined);
          assert.equal(body.queue_id, "queue-1");
          return Response.json({ success: true, task_id: "task-e" });
        }
        if (url.includes("/api/v1/tasks/")) {
          return Response.json({
            success: true,
            status: "completed",
            result: { video_url: `https://cdn.example/out.mp4?auth_key=${SECRET}` },
          });
        }
        if (url.includes("cdn.example")) {
          assert.equal(header.get("authorization"), null);
          return new Response(source, { status: 200, headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    assert.match(cap.out(), /estimate: 10 yuan\/min \(enhance-video-generative 2k 30fps\)/);
    assert.equal(cap.out().includes(BITRATE_FALLBACK_NOTE), false);
    const outDir = path.join(dir, "out");
    const files = await readdir(outDir);
    const mp4 = files.find((name) => name.startsWith("enhance-") && name.endsWith(".mp4"));
    assert.ok(mp4);
    await assertGrained(path.join(outDir, mp4), source);
    const audit = await readFile(path.join(dir, ".lumen", "runs", (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "", "record.json"), "utf8");
    assert.match(audit, /\/api\/v1\/tools\/enhance-video-generative/);
    assert.equal(audit.includes(SECRET), false);
    assert.equal(audit.includes(KEY), false);
    assert.equal(audit.includes("auth_key"), false);
    assert.ok(auths.some((value) => value === `Bearer ${KEY}`));
  });
});

interface PlannedCall {
  url: string;
  body: { kind: string; value?: Record<string, unknown> };
}

async function plannedCalls(dir: string, runId: string): Promise<PlannedCall[]> {
  const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", runId, "record.json"), "utf8")) as {
    calls: PlannedCall[];
  };
  return record.calls;
}

test("enhance dry-run plans 2k 30fps and a json upload body", async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY }), {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["enhance", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.match(cap.out(), /estimate: 10 yuan\/min \(enhance-video-generative 2k 30fps\)/);
    const runId = /run: (\S+)/.exec(cap.out())?.[1] ?? "";
    const calls = await plannedCalls(dir, runId);
    const upload = calls.find((call) => call.url.includes("request-media-upload-url"));
    assert.equal(upload?.url, "https://mediakit.example/api/v1/tools-sync/request-media-upload-url");
    assert.deepEqual(upload?.body, { kind: "json", value: {} });
    const submit = calls.find((call) => call.url.endsWith("/enhance-video-generative"));
    assert.equal(submit?.url, "https://mediakit.example/api/v1/tools/enhance-video-generative");
    assert.deepEqual(submit?.body.value, {
      video_url: "mediakit://{{file_id}}",
      client_token: runId,
      resolution: "2k",
      fps: 30,
      queue_id: "queue-1",
    });
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", runId, "record.json"), "utf8")) as {
      modelId: string;
      params: { yuanPerMin?: number; minutes?: number };
    };
    assert.equal(record.modelId, GENERATIVE);
    assert.equal(record.params.yuanPerMin, 10);
    assert.equal(record.params.minutes, undefined);
  });
});

test("enhance prices a readable local file before submit", async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    const video = path.join(dir, "refs", "in.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:d=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
      video,
    ]);
    const { stdout } = await exec(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video,
    ]);
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY }), {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["enhance", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.match(cap.out(), new RegExp(enhanceCost(Number(stdout.trim())).text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const runId = /run: (\S+)/.exec(cap.out())?.[1] ?? "";
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", runId, "record.json"), "utf8")) as {
      params: { yuanPerMin: number; yuan: number; resolution: string; fps: number };
    };
    assert.equal(record.params.yuanPerMin, 10);
    assert.equal(record.params.resolution, "2k");
    assert.equal(record.params.fps, 30);
    assert.ok(record.params.yuan > 0);
  });
});

test("enhance says when grain uses the container bitrate", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    await writeFile(path.join(dir, "refs", "clip.mp4"), "fake");
    const rawDir = await mkdtemp(path.join(tmpdir(), "lumen-ffv1-"));
    const raw = path.join(rawDir, "raw.mkv");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=0.16",
      "-c:v", "ffv1", "-an", raw,
    ]);
    const bytes = await readFile(raw);
    await rm(rawDir, { recursive: true, force: true });
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY }), {
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("request-media-upload-url")) {
          return Response.json({ result: { file_id: "file-9", upload_url: "https://upload.example/put" } });
        }
        if (init?.method === "PUT") return new Response("", { status: 200 });
        if (url.includes("/enhance-video-generative")) return Response.json({ success: true, task_id: "task-e" });
        if (url.includes("/api/v1/tasks/")) {
          return Response.json({ success: true, status: "completed", result: { video_url: "https://cdn.example/out.mkv" } });
        }
        if (url.includes("cdn.example")) return new Response(bytes, { status: 200 });
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    assert.match(cap.out(), new RegExp(BITRATE_FALLBACK_NOTE));
    const files = await readdir(path.join(dir, "out"));
    const mp4 = files.find((name) => name.endsWith(".mp4"));
    assert.ok(mp4);
    const { stdout } = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", path.join(dir, "out", mp4)]);
    assert.match(stdout, /h264/);
    assert.match(stdout, /yuv420p/);
  });
});

test("enhance rejects model, resolution, and grain flags", async () => {
  await withDir(async (dir) => {
    for (const args of [
      ["--model", "enhance-video"],
      ["--resolution", "4k"],
      ["--fps", "60"],
      ["--tool-version", "professional"],
      ["--bitrate-level", "high"],
      ["--enhance-style", "natural"],
      ["--strength", "0.2"],
    ]) {
      const cap = capture();
      assert.equal(await run(["enhance", "--video", "refs/in.mp4", ...args, "--project", dir], cap.io), 2);
      assert.match(cap.err(), /unknown option/);
    }
    await assert.rejects(access(path.join(dir, ".lumen", "runs")));
  });
});

const LITE = "doubao-seed-2-1-lite-260915";
const OTHER = "doubao-seed-2-0-other";

function understandConfig(extra: { preferModels?: string[]; level?: string; needAudio?: boolean } = {}): string {
  return `${JSON.stringify({
    models: {
      "video-understand-router": {
        provider: "mediakit",
        baseUrl: "https://mediakit.example",
        apiKeyEnv: "MEDIAKIT_UNDERSTAND_KEY",
        group: "queue-1",
      },
    },
    breakdown: {
      prompt: "",
      ...extra,
    },
  }, null, 2)}\n`;
}

test("breakdown prefer_models follows project config over the global file", async () => {
  await withDir(async (dir) => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".config", "lumen"), { recursive: true });
    await writeFile(path.join(home, ".config", "lumen", "providers.json"), understandConfig({ preferModels: [OTHER, LITE] }));
    await writeFile(path.join(dir, "lumen.config.json"), understandConfig());
    const globalOnly = capture({ HOME: home, MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], globalOnly.io), 0, globalOnly.err());
    const globalId = /run: (\S+)/.exec(globalOnly.out())?.[1] ?? "";
    const globalRecord = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", globalId, "record.json"), "utf8")) as {
      calls: unknown;
    };
    assert.match(JSON.stringify(globalRecord.calls), new RegExp(`"prefer_models":\\["${OTHER}","${LITE}"\\]`));

    await writeFile(path.join(dir, "lumen.config.json"), understandConfig({ preferModels: ["doubao-seed-2-0-project"] }));
    const project = capture({ HOME: home, MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], project.io), 0, project.err());
    const projectId = /run: (\S+)/.exec(project.out())?.[1] ?? "";
    const projectRecord = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", projectId, "record.json"), "utf8")) as { calls: unknown };
    const body = JSON.stringify(projectRecord.calls);
    assert.match(body, /"prefer_models":\["doubao-seed-2-0-project"\]/);
    assert.equal(body.includes(OTHER), false);
  });
});

test("breakdown level and needAudio follow project config over the global file", async () => {
  await withDir(async (dir) => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".config", "lumen"), { recursive: true });
    await writeFile(path.join(home, ".config", "lumen", "providers.json"), understandConfig({ level: "Fast", needAudio: false }));
    await writeFile(path.join(dir, "lumen.config.json"), understandConfig());
    const globalOnly = capture({ HOME: home, MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], globalOnly.io), 0, globalOnly.err());
    const globalId = /run: (\S+)/.exec(globalOnly.out())?.[1] ?? "";
    const globalRecord = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", globalId, "record.json"), "utf8")) as {
      params: { level: string; needAudio: boolean };
      calls: Array<{ body: { value?: { level?: string; manual_option?: { need_audio?: boolean } } } }>;
    };
    assert.equal(globalRecord.params.level, "Fast");
    assert.equal(globalRecord.params.needAudio, false);
    const globalSubmit = globalRecord.calls.find((call) => call.body.value?.level !== undefined);
    assert.equal(globalSubmit?.body.value?.level, "Fast");
    assert.equal(globalSubmit?.body.value?.manual_option?.need_audio, false);

    await writeFile(path.join(dir, "lumen.config.json"), understandConfig({ level: "Quality", needAudio: true }));
    const project = capture({ HOME: home, MEDIAKIT_UNDERSTAND_KEY: KEY }, {
      fetch: async () => {
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], project.io), 0, project.err());
    const projectId = /run: (\S+)/.exec(project.out())?.[1] ?? "";
    const projectRecord = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", projectId, "record.json"), "utf8")) as {
      params: { level: string; needAudio: boolean };
      calls: Array<{ body: { value?: { level?: string; manual_option?: { need_audio?: boolean } } } }>;
    };
    assert.equal(projectRecord.params.level, "Quality");
    assert.equal(projectRecord.params.needAudio, true);
    const projectSubmit = projectRecord.calls.find((call) => call.body.value?.level !== undefined);
    assert.equal(projectSubmit?.body.value?.level, "Quality");
    assert.equal(projectSubmit?.body.value?.manual_option?.need_audio, true);
  });
});

test("mediakit poll budget defaults to 30 minutes and floors shorter windows", () => {
  assert.deepEqual(mediakitPollLimits({}), { max: 180, ms: 10_000 });
  assert.deepEqual(mediakitPollLimits({ MEDIAKIT_MAX_POLLS: "90", MEDIAKIT_POLL_MS: "2000" }), { max: 900, ms: 2000 });
  assert.deepEqual(mediakitPollLimits({ MEDIAKIT_MAX_POLLS: "2", MEDIAKIT_POLL_MS: "0" }), { max: 2, ms: 0 });
  assert.equal(mediakitPollLimits({ MEDIAKIT_MAX_POLLS: "400", MEDIAKIT_POLL_MS: "10000" }).max, 400);
});

function assertNoSecrets(audit: string): void {
  assert.equal(audit.includes(SECRET), false, audit);
  assert.equal(audit.includes(KEY), false, audit);
  assert.equal(audit.includes("auth_key"), false, audit);
}

function mediakitFetch(opts: {
  tool: string;
  taskId: string;
  polls: Array<string | number>;
  videoUrl?: string;
  shots?: boolean;
}) {
  let polls = 0;
  const auths: Array<string | null> = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const header = new Headers(init?.headers);
    const auth = header.get("authorization");
    if (url.includes("mediakit.example")) auths.push(auth);
    if (url.includes("request-media-upload-url")) {
      return Response.json({
        result: { file_id: "file-9", upload_url: `https://upload.example/put?auth_key=${SECRET}` },
      });
    }
    if (init?.method === "PUT") {
      assert.equal(auth, null);
      return new Response("", { status: 200 });
    }
    if (url.includes(`/api/v1/tools/${opts.tool}`)) return Response.json({ success: true, task_id: opts.taskId });
    if (url.includes("/api/v1/tasks/")) {
      const step = opts.polls[Math.min(polls, opts.polls.length - 1)]!;
      polls += 1;
      if (typeof step === "number") return new Response("busy", { status: step });
      if (step === "completed" && opts.shots) {
        return Response.json({
          success: true,
          status: "completed",
          result: { shots: [{ "#": 1, durationSec: 1.5, frame: "door", vo: "" }] },
        });
      }
      if (step === "completed") {
        return Response.json({
          success: true,
          status: "completed",
          result: { video_url: opts.videoUrl ?? `https://cdn.example/out.mp4?auth_key=${SECRET}` },
        });
      }
      if (step === "failed") return Response.json({ success: false, status: "failed" });
      return Response.json({ success: true, status: step, task_id: opts.taskId });
    }
    if (url.includes("cdn.example")) {
      assert.equal(auth, null);
      return new Response(await tinyMp4(), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  };
  return { fetch: fetch as never, polls: () => polls, auths };
}

async function seedClip(dir: string): Promise<void> {
  await mkdir(path.join(dir, "refs"), { recursive: true });
  await writeFile(path.join(dir, "refs", "clip.mp4"), "fake");
}

test("enhance poll exhaustion stays running and resume downloads the mp4", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const first = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["running"] });
    const cap = capture(
      { MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "2" },
      { fetch: first.fetch },
    );
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    assert.equal(cap.err(), "");
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    assert.match(cap.out(), /^running enhance-video/m);
    assert.match(cap.out(), /poll: https:\/\/mediakit\.example\/api\/v1\/tasks\/task-e/);
    assert.match(cap.out(), new RegExp(`lumen runs resume ${id}`));
    assert.equal(first.polls(), 2);
    const file = path.join(dir, ".lumen", "runs", id, "record.json");
    const rec = JSON.parse(await readFile(file, "utf8")) as {
      status: string;
      error?: string;
      pending: { provider: string; taskId: string; lastStatus: string; pollUrl: string; videoFile: string; receipt: string };
    };
    assert.equal(rec.status, "running");
    assert.equal(rec.error, undefined);
    assert.equal(rec.pending.provider, "mediakit");
    assert.equal(rec.pending.taskId, "task-e");
    assert.equal(rec.pending.lastStatus, "running");
    assert.equal(rec.pending.pollUrl, "https://mediakit.example/api/v1/tasks/task-e");
    assert.match(rec.pending.videoFile, /enhance-.*\.mp4$/);
    assert.match(rec.pending.receipt, /\.enhance\.json$/);
    assertNoSecrets(await readFile(file, "utf8"));
    const md = await readFile(path.join(dir, ".lumen", "runs", id, "record.md"), "utf8");
    assert.match(md, new RegExp(`lumen runs resume ${id}`));
    assert.match(md, /\/api\/v1\/tasks\/task-e/);
    assertNoSecrets(md);
    const show = capture();
    assert.equal(await run(["runs", "show", id, "--project", dir], show.io), 0, show.err());
    assert.match(show.out(), new RegExp(`lumen runs resume ${id}`));

    const mid = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["processing"] });
    const again = capture(
      { MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "1" },
      { fetch: mid.fetch },
    );
    assert.equal(await run(["runs", "resume", id, "--project", dir], again.io), 0, again.err());
    assert.match(again.out(), /still running on the server/);
    const midRec = JSON.parse(await readFile(file, "utf8")) as { status: string; pending: { lastStatus: string }; resumedAt: string[] };
    assert.equal(midRec.status, "running");
    assert.equal(midRec.pending.lastStatus, "processing");
    assert.equal(midRec.resumedAt.length, 1);
    assertNoSecrets(await readFile(file, "utf8"));

    const done = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["completed"] });
    const res = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: done.fetch });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    assert.match(res.out(), /wrote: .*enhance-.*\.mp4/);
    await assertGrained(rec.pending.videoFile, await tinyMp4());
    const finished = JSON.parse(await readFile(file, "utf8")) as { status: string; pending?: unknown };
    assert.equal(finished.status, "ok");
    assert.equal(finished.pending, undefined);
    assertNoSecrets(await readFile(file, "utf8"));
    assert.ok(done.auths.some((value) => value === `Bearer ${KEY}`));
  });
});

test("generative enhance resumes the same task and can retarget --out", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, "enhance-video-generative", "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const first = mediakitFetch({ tool: "enhance-video-generative", taskId: "task-g", polls: ["running"] });
    const cap = capture(
      { MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "1" },
      { fetch: first.fetch },
    );
    assert.equal(
      await run(["enhance", "--execute", "--project", dir], cap.io),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    assert.match(cap.out(), /^running enhance-video-generative/m);
    const done = mediakitFetch({ tool: "enhance-video-generative", taskId: "task-g", polls: ["completed"] });
    const res = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: done.fetch });
    assert.equal(await run(["runs", "resume", id, "--out", "out/final.mp4", "--project", dir], res.io), 0, res.err());
    await assertGrained(path.join(dir, "out", "final.mp4"), await tinyMp4());
    assertNoSecrets(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8"));
    assert.ok(done.auths.some((value) => value === `Bearer ${KEY}`));
  });
});

test("resume writes enhance.json when the result is not https and redacts the audit", async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const videoUrl = `mediakit://out-file?auth_key=${SECRET}`;
    const first = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["running"] });
    const cap = capture(
      { MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "1" },
      { fetch: first.fetch },
    );
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const done = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["completed"], videoUrl });
    const res = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: done.fetch });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    const note = JSON.parse(await readFile(path.join(dir, "refs", `${id}.enhance.json`), "utf8")) as { video_url: string };
    assert.equal(note.video_url, videoUrl);
    assert.equal(await access(path.join(dir, "out")).then(() => true, () => false), false);
    assertNoSecrets(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8"));
  });
});

test("a failed mediakit task is still an error", async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const fetch = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: ["failed"] });
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: fetch.fetch });
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 1);
    assert.match(cap.err(), /MediaKit task task-e failed/);
    const id = /run: (\S+)/.exec(cap.err())?.[1];
    assert.ok(id);
    const rec = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8")) as { status: string };
    assert.equal(rec.status, "error");
  });
});

test("transient 503 during a mediakit poll is retried", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const fetch = mediakitFetch({ tool: GENERATIVE, taskId: "task-e", polls: [503, "completed"] });
    const cap = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: fetch.fetch });
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    assert.equal(fetch.polls(), 2);
    const files = await readdir(path.join(dir, "out"));
    const mp4 = files.find((name) => name.startsWith("enhance-") && name.endsWith(".mp4"));
    assert.ok(mp4);
    await assertGrained(path.join(dir, "out", mp4), await tinyMp4());
  });
});

test("breakdown poll exhaustion stays running and resume writes the shot list", async () => {
  await withDir(async (dir) => {
    await bind(dir, "video-understand-router", "MEDIAKIT_UNDERSTAND_KEY");
    await seedClip(dir);
    const first = mediakitFetch({ tool: "video-understand-router", taskId: "task-b", polls: ["running"], shots: true });
    const cap = capture(
      { MEDIAKIT_UNDERSTAND_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "1" },
      { fetch: first.fetch },
    );
    assert.equal(await run(["breakdown", "--prompt", "find the cuts", "--execute", "--project", dir], cap.io), 0, cap.err());
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    assert.match(cap.out(), /^running video-understand-router/m);
    assert.match(cap.out(), /poll: https:\/\/mediakit\.example\/api\/v1\/tasks\/task-b/);
    assert.equal(await access(path.join(dir, "shotlist.json")).then(() => true, () => false), false);
    const raw = await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8");
    assertNoSecrets(raw);
    assert.match(raw, /\/api\/v1\/tasks\/task-b/);

    const done = mediakitFetch({ tool: "video-understand-router", taskId: "task-b", polls: ["completed"], shots: true });
    const res = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY, MEDIAKIT_POLL_MS: "0" }, { fetch: done.fetch });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    const shotlist = JSON.parse(await readFile(path.join(dir, "shotlist.json"), "utf8")) as Array<{ frame: string }>;
    assert.equal(shotlist[0]?.frame, "door");
    const refs = await readdir(path.join(dir, "refs"));
    assert.ok(refs.some((name) => name === `${id}.video-understand.json`));
    const finished = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8")) as { status: string };
    assert.equal(finished.status, "ok");
    assertNoSecrets(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8"));
  });
});

test("resume recovers a pre-0.1.9 mediakit run recorded as error", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, GENERATIVE, "MEDIAKIT_GENERATIVE_KEY");
    await seedClip(dir);
    const first = mediakitFetch({ tool: GENERATIVE, taskId: "task-old", polls: ["running"] });
    const cap = capture(
      { MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0", MEDIAKIT_MAX_POLLS: "1" },
      { fetch: first.fetch },
    );
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const file = path.join(dir, ".lumen", "runs", id, "record.json");
    const rec = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete rec.pending;
    Object.assign(rec, { status: "error", error: `MediaKit task task-old did not finish\nrun: ${id}` });
    await writeFile(file, JSON.stringify(rec));
    const done = mediakitFetch({ tool: GENERATIVE, taskId: "task-old", polls: ["completed"] });
    const res = capture(withBin({ MEDIAKIT_GENERATIVE_KEY: KEY, MEDIAKIT_POLL_MS: "0" }), { fetch: done.fetch });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    await assertGrained(path.join(dir, "out", `enhance-${id}.mp4`), await tinyMp4());
    assertNoSecrets(await readFile(file, "utf8"));
  });
});

test("an empty breakdown.preferModels list is rejected", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "lumen.config.json"), understandConfig({ preferModels: [] }));
    const cap = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], cap.io), 1);
    assert.match(cap.err(), /preferModels/);
  });
});
