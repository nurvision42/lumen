import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SEEDREAM_PRO_MODEL } from "../src/catalog.js";
import { run } from "../src/run.js";
import { readRunRecord, writeRun, type RunRecord } from "../src/runs.js";
import { capture, withDir } from "./helpers.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x77, 0x65, 0x62, 0x6d, 0x00]);
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0, 0, 0, 0,
]);

function isolatedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg-config") };
  return { ...env, ...extra };
}

async function bind(dir: string, model: string, provider: string, base: string, envName: string): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", envName, "--project", dir], cap.io),
    0,
    cap.err(),
  );
}

async function recordOf(dir: string, id: string): Promise<RunRecord> {
  return JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as RunRecord;
}

test("default image path follows JPEG bytes; --out with an extension is kept", async () => {
  await withDir(async (dir) => {
    await bind(dir, SEEDREAM_PRO_MODEL, "volcark", "https://ark.example/api/v3", "ARK_API_KEY");
    const fetchImpl = async (url: string) => {
      if (url.endsWith("/images/generations")) return Response.json({ data: [{ url: "https://cdn.example/out.jpg" }] });
      if (url === "https://cdn.example/out.jpg") return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
      return new Response("missing", { status: 404 });
    };
    const env = isolatedEnv(dir, { ARK_API_KEY: "k" });
    const cap = capture(env, { fetch: fetchImpl, cwd: dir });
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--aspect-ratio", "1:1", "--resolution", "1K", "--execute", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const jpg = path.join(dir, "out", `${id}.jpg`);
    const png = path.join(dir, "out", `${id}.png`);
    assert.match(cap.out(), new RegExp(`wrote: ${jpg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual([...(await readFile(jpg))], [...JPEG]);
    await assert.rejects(access(png));
    const record = await recordOf(dir, id);
    assert.deepEqual(record.outputs, [jpg]);
    assert.equal(record.image?.outFile, jpg);

    const kept = capture(env, { fetch: fetchImpl, cwd: dir });
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--aspect-ratio", "1:1",
          "--resolution", "1K", "--out", "out/keep.png", "--execute", "--project", dir,
        ],
        kept.io,
      ),
      0,
      kept.err(),
    );
    assert.match(kept.out(), /warning: --out 以 \.png 结尾，但文件是 JPEG/);
    assert.match(kept.out(), /wrote: .*out\/keep\.png/);
    assert.deepEqual([...(await readFile(path.join(dir, "out/keep.png")))], [...JPEG]);

    const bare = capture(env, { fetch: fetchImpl, cwd: dir });
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--aspect-ratio", "1:1",
          "--resolution", "1K", "--out", "out/bare", "--execute", "--project", dir,
        ],
        bare.io,
      ),
      0,
      bare.err(),
    );
    assert.match(bare.out(), /wrote: .*out\/bare\.jpg/);
    assert.deepEqual([...(await readFile(path.join(dir, "out/bare.jpg")))], [...JPEG]);
  });
});

test("resume downloads JPEG to the sniffed filename and updates the record", async () => {
  await withDir(async (dir) => {
    const id = "20261111T000001Z-aa01";
    const planned = path.join(dir, "out", `${id}.png`);
    const record: RunRecord = {
      id,
      time: "2026-11-11T00:00:01.000Z",
      command: ["gen", "image", "--model", "gpt-image-2", "--prompt", "一只猫", "--execute", "--project", dir],
      modelId: "gpt-image-2",
      mode: "execute",
      status: "pending",
      binding: { provider: "grsai", baseUrl: "https://grsai.example", apiKeyEnv: "GRSAI", keyPresent: true },
      params: {},
      calls: [],
      response: null,
      outputs: [],
      image: { provider: "grsai", outFile: planned, url: "https://cdn.example/pic.jpg?[redacted]", received: true },
    };
    await writeRun(dir, record, []);
    await writeFile(path.join(dir, ".lumen", "runs", id, "image-url.txt"), "https://cdn.example/pic.jpg\n");
    const cap = capture(isolatedEnv(dir), {
      cwd: dir,
      fetch: async (url) => {
        assert.equal(url, "https://cdn.example/pic.jpg");
        return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
      },
    });
    assert.equal(await run(["runs", "resume", id, "--project", dir], cap.io), 0, cap.err());
    const jpg = path.join(dir, "out", `${id}.jpg`);
    assert.match(cap.out(), new RegExp(`wrote: ${jpg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual([...(await readFile(jpg))], [...JPEG]);
    await assert.rejects(access(planned));
    const saved = await readRunRecord(dir, id);
    assert.equal(saved.status, "ok");
    assert.deepEqual(saved.outputs, [jpg]);
    assert.equal(saved.image?.outFile, jpg);
  });
});

test("default video path follows WebM bytes; receipt stays beside it", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2", "haomao", "https://cat.example/api/v3", "CAT");
    let polls = 0;
    const cap = capture(isolatedEnv(dir, { CAT: "secret", SEEDANCE_POLL_MS: "0", SEEDANCE_MAX_POLLS: "5" }), {
      cwd: dir,
      fetch: async (url) => {
        if (url === "https://cat.example/api/v3/contents/generations/tasks") {
          return new Response(JSON.stringify({ id: "cgt-webm", status: "queued" }), { headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/contents/generations/tasks/cgt-webm")) {
          polls += 1;
          if (polls === 1) return new Response(JSON.stringify({ id: "cgt-webm", status: "running" }), { headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ id: "cgt-webm", status: "succeeded", content: { video_url: "https://cdn.example/v.webm" } }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://cdn.example/v.webm") return new Response(WEBM, { headers: { "content-type": "video/webm" } });
        return new Response("missing", { status: 404 });
      },
    });
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "a cat walks", "--duration", "5", "--execute", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const webm = path.join(dir, "out", `${id}.webm`);
    assert.match(cap.out(), new RegExp(`wrote: ${webm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual([...(await readFile(webm))], [...WEBM]);
    await assert.rejects(access(path.join(dir, "out", `${id}.mp4`)));
    const receipt = await readFile(path.join(dir, "out", `${id}.seedance.json`), "utf8");
    assert.match(receipt, /cgt-webm/);
    const record = await recordOf(dir, id);
    assert.equal(record.outputs.includes(webm), true);
  });
});

test("default voice path follows WAV bytes", async () => {
  await withDir(async (dir) => {
    await bind(dir, "voice-synthesis", "kitta", "https://fishaudio.org", "KITTA");
    const cap = capture(isolatedEnv(dir, { KITTA: "k" }), {
      cwd: dir,
      fetch: async (url) => {
        if (String(url).endsWith("/api/open/v3/speech/tts")) {
          return new Response(WAV, { headers: { "content-type": "audio/wav" } });
        }
        return new Response(JSON.stringify({ error: url }), { status: 404, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(
      await run(
        ["gen", "voice", "--model", "voice-synthesis", "--text", "你好", "--voice", "demo", "--execute", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const wav = path.join(dir, "out", `${id}.wav`);
    assert.match(cap.out(), new RegExp(`wrote: ${wav.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual([...(await readFile(wav))], [...WAV]);
  });
});
