import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BREAKDOWN_DEFAULT_PROMPT } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const KEY = "mediakit-test-key";
const SECRET = "supersecretvalue";

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
    const calls = record.calls as Array<{ body: { value?: { prompt?: string } } }>;
    assert.equal(calls.find((call) => call.body.value?.prompt !== undefined)?.body.value?.prompt, BREAKDOWN_DEFAULT_PROMPT);
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

test("enhance execute downloads the mp4 and redacts the presigned query", async () => {
  await withDir(async (dir) => {
    await bind(dir, "enhance-video-generative", "MEDIAKIT_ENHANCE_KEY");
    await mkdir(path.join(dir, "refs"), { recursive: true });
    await writeFile(path.join(dir, "refs", "clip.mp4"), "fake");
    const auths: string[] = [];
    const cap = capture({ MEDIAKIT_ENHANCE_KEY: KEY }, {
      fetch: async (input, init) => {
        const url = String(input);
        const header = new Headers(init?.headers);
        const auth = header.get("authorization");
        if (auth) auths.push(auth);
        if (url.includes("request-media-upload-url")) {
          return Response.json({
            result: { file_id: "mediakit://file-9", upload_url: `https://upload.example/put?auth_key=${SECRET}` },
          });
        }
        if (init?.method === "PUT") return new Response("", { status: 200 });
        if (url.includes("enhance-video-generative")) {
          const body = JSON.parse(String(init?.body)) as {
            video_url?: string;
            scene?: string;
            level?: string;
            queue_id?: string;
            prefer_models?: string[];
            manual_option?: unknown;
          };
          assert.equal(body.video_url, "mediakit://file-9");
          assert.equal(body.scene, undefined);
          assert.equal(body.level, undefined);
          assert.equal(body.queue_id, "queue-1");
          assert.equal(body.prefer_models, undefined);
          assert.equal(body.manual_option, undefined);
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
          return new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(await run(["enhance", "--execute", "--project", dir], cap.io), 0, cap.err());
    const outDir = path.join(dir, "out");
    const files = await readdir(outDir);
    const mp4 = files.find((name) => name.startsWith("enhance-") && name.endsWith(".mp4"));
    assert.ok(mp4);
    assert.equal(await readFile(path.join(outDir, mp4), "utf8"), "mp4-bytes");
    const audit = await readFile(path.join(dir, ".lumen", "runs", (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "", "record.json"), "utf8");
    assert.match(audit, /enhance-video-generative/);
    assert.equal(audit.includes(SECRET), false);
    assert.equal(audit.includes(KEY), false);
    assert.equal(audit.includes("auth_key"), false);
    assert.ok(auths.some((value) => value === `Bearer ${KEY}`));
    await access(path.join(outDir, mp4));
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

test("an empty breakdown.preferModels list is rejected", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "lumen.config.json"), understandConfig({ preferModels: [] }));
    const cap = capture({ MEDIAKIT_UNDERSTAND_KEY: KEY });
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], cap.io), 1);
    assert.match(cap.err(), /preferModels/);
  });
});
