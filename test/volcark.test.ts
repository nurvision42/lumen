import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planVolcarkImage, seedreamSize } from "../src/clients/volcark.js";
import {
  IMAGE_ASPECTS,
  PROVIDER_DEFAULT_BASE_URLS,
  SEEDREAM_FLASH_MODEL,
  SEEDREAM_PRO_MODEL,
  SEEDREAM_RESOLUTIONS,
  validateImage,
} from "../src/catalog.js";
import type { ModelBinding } from "../src/config.js";
import { seedreamCost } from "../src/seedream/cost.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const BASE = "https://ark.example/api/v3";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const OFFICIAL: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1424x800",
    "9:16": "800x1424",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1568x672",
  },
  "1.5K": {
    "1:1": "1536x1536",
    "4:3": "1792x1344",
    "3:4": "1344x1792",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "1872x1248",
    "2:3": "1248x1872",
    "21:9": "2352x1008",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2368x1776",
    "3:4": "1776x2368",
    "16:9": "2816x1584",
    "9:16": "1584x2816",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
};

function isolatedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg-config") };
  delete env.ARK_API_KEY;
  delete env.VOLC_ACCESSKEY;
  delete env.VOLC_SECRETKEY;
  delete env.VOLCENGINE_ACCESS_KEY;
  delete env.VOLCENGINE_SECRET_KEY;
  return { ...env, ...extra };
}

async function bind(dir: string, model = SEEDREAM_PRO_MODEL, extra: string[] = []): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", "volcark", "--api-key-env", "ARK_API_KEY", ...extra, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

function binding(alias?: string): ModelBinding {
  return {
    provider: "volcark",
    baseUrl: BASE,
    apiKeyEnv: "ARK_API_KEY",
    ...(alias === undefined ? {} : { modelAlias: alias }),
  };
}

test("volcark default base url is the Ark Beijing endpoint", () => {
  assert.equal(PROVIDER_DEFAULT_BASE_URLS.volcark, "https://ark.cn-beijing.volces.com/api/v3");
});

test("seedream sizes use the official pixel table, and auto sends the tier", () => {
  for (const resolution of SEEDREAM_RESOLUTIONS) {
    assert.equal(seedreamSize("auto", resolution), resolution);
    for (const [aspect, size] of Object.entries(OFFICIAL[resolution] ?? {})) {
      assert.equal(seedreamSize(aspect, resolution), size, `${resolution} ${aspect}`);
    }
  }
  assert.throws(() => seedreamSize("1:1", "4K"), /1K, 1.5K, 2K/);
  for (const resolution of SEEDREAM_RESOLUTIONS) {
    for (const aspect of IMAGE_ASPECTS) {
      if (aspect === "auto") continue;
      const size = seedreamSize(aspect, resolution);
      const [width, height] = size.split("x").map(Number);
      assert.ok(width !== undefined && height !== undefined && width % 16 === 0 && height % 16 === 0, size);
      const pixels = width * height;
      assert.ok(pixels >= 1280 * 720 && pixels <= Math.floor(2048 * 2048 * 1.1025), `${resolution} ${aspect} ${size}`);
      assert.ok(Math.max(width, height) / Math.min(width, height) <= 16, size);
    }
  }
});

test("seedream price table: Pro ≤1.5K 0.30, Pro 2K 0.60, Flash 0.12", () => {
  assert.equal(seedreamCost(SEEDREAM_PRO_MODEL, "1K").text, `estimate: 0.30 yuan (${SEEDREAM_PRO_MODEL} ≤1.5K, 1 image)`);
  assert.equal(seedreamCost(SEEDREAM_PRO_MODEL, "1.5K").text, `estimate: 0.30 yuan (${SEEDREAM_PRO_MODEL} ≤1.5K, 1 image)`);
  assert.equal(seedreamCost(SEEDREAM_PRO_MODEL, "2K").text, `estimate: 0.60 yuan (${SEEDREAM_PRO_MODEL} 2K, 1 image)`);
  assert.equal(seedreamCost(SEEDREAM_PRO_MODEL, "2K").yuan, 0.6);
  assert.equal(seedreamCost(SEEDREAM_FLASH_MODEL, "1K").text, `estimate: 0.12 yuan (${SEEDREAM_FLASH_MODEL}, 1 image)`);
  assert.equal(seedreamCost(SEEDREAM_FLASH_MODEL, "2K").yuan, 0.12);
});

function jsonBody(call: ReturnType<typeof planVolcarkImage>[number] | undefined): Record<string, unknown> {
  if (call?.body.kind !== "json") return {};
  return call.body.value as Record<string, unknown>;
}

test("volcark body closes watermark, skips group images, and shapes image", () => {
  const one = validateImage({
    modelId: SEEDREAM_PRO_MODEL,
    prompt: "一只柴犬",
    aspectRatio: "16:9",
    resolution: "2K",
    background: undefined,
    quality: undefined,
    references: ["https://cdn.example/a.png"],
  });
  const call = planVolcarkImage(one, binding());
  const body = jsonBody(call[0]);
  assert.equal(call[0]?.url, `${BASE}/images/generations`);
  assert.equal(body.model, SEEDREAM_PRO_MODEL);
  assert.equal(body.size, "2816x1584");
  assert.equal(body.watermark, false);
  assert.equal(body.response_format, "url");
  assert.equal(body.output_format, "png");
  assert.equal(body.image, "https://cdn.example/a.png");
  assert.equal(JSON.stringify(body).includes("sequential_image_generation"), false);
  assert.equal(JSON.stringify(body).includes("stream"), false);
  assert.equal(body.quality, undefined);

  const many = validateImage({
    modelId: "seedream-5-flash",
    prompt: one.prompt,
    aspectRatio: one.aspectRatio,
    resolution: one.resolution,
    background: undefined,
    quality: undefined,
    references: ["https://cdn.example/a.png", "data:image/png;base64,aaaa"],
  });
  assert.equal(many.modelId, SEEDREAM_FLASH_MODEL);
  const value = jsonBody(planVolcarkImage(many, binding("custom-seedream"))[0]);
  assert.equal(value.model, "custom-seedream");
  assert.deepEqual(value.image, ["https://cdn.example/a.png", "data:image/png;base64,aaaa"]);

  const auto = validateImage({
    modelId: SEEDREAM_PRO_MODEL,
    prompt: one.prompt,
    aspectRatio: "auto",
    resolution: "1.5K",
    background: undefined,
    quality: undefined,
    references: [],
  });
  assert.equal(jsonBody(planVolcarkImage(auto, binding())[0]).size, "1.5K");
});

test("seedream rejects 4K, quality, auto background, too many refs, and gpt-image rejects 1.5K", () => {
  const base = {
    modelId: SEEDREAM_PRO_MODEL,
    prompt: "一只柴犬",
    aspectRatio: "1:1" as const,
    resolution: "1K",
    background: undefined,
    quality: undefined,
    references: [] as string[],
  };
  assert.throws(() => validateImage({ ...base, resolution: "4K" }), /1K, 1.5K, 2K/);
  assert.throws(() => validateImage({ ...base, quality: "high" }), /does not take --quality/);
  assert.throws(() => validateImage({ ...base, background: "auto" }), /transparent or opaque/);
  assert.throws(() => validateImage({ ...base, background: "transparent", references: [] }), /exactly one reference/);
  assert.throws(() => validateImage({ ...base, references: Array.from({ length: 11 }, () => "https://cdn.example/a.png") }), /limited to 10/);
  assert.throws(() => validateImage({ ...base, modelId: "gpt-image-2", resolution: "1.5K" }), /1K, 2K, 4K/);
});

test("models list names both Seedream ids on volcark, and aliases resolve", async () => {
  const listed = capture();
  assert.equal(await run(["models"], listed.io), 0, listed.err());
  assert.match(listed.out(), new RegExp(`${SEEDREAM_PRO_MODEL}  image  volcark`));
  assert.match(listed.out(), new RegExp(`${SEEDREAM_FLASH_MODEL}  image  volcark`));
  assert.match(listed.out(), /0\.30 yuan/);
  assert.match(listed.out(), /0\.12 yuan/);
  const alias = capture();
  assert.equal(await run(["models", "seedream-5-pro"], alias.io), 0, alias.err());
  assert.match(alias.out(), new RegExp(`^${SEEDREAM_PRO_MODEL}  image  volcark`, "m"));
  assert.equal(alias.out().includes(SEEDREAM_FLASH_MODEL), false);
});

test("providers set uses the official Ark base url", async () => {
  await withDir(async (dir) => {
    const set = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["providers", "set", "seedream-5-flash", "--provider", "volcark", "--api-key-env", "ARK_API_KEY", "--project", dir],
        set.io,
      ),
      0,
      set.err(),
    );
    assert.match(set.out(), new RegExp(`${SEEDREAM_FLASH_MODEL} volcark https://ark.cn-beijing.volces.com/api/v3 \\(default\\)`));
  });
});

test("dry-run prints the estimate and does not send sequential_image_generation", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", "seedream-5-pro", "--prompt", "一只柴犬", "--aspect-ratio", "16:9", "--resolution", "2K", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.match(cap.out(), new RegExp(`estimate: 0\\.60 yuan \\(${SEEDREAM_PRO_MODEL} 2K, 1 image\\)`));
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      modelId: string;
      params: { yuan?: number };
      calls: Array<{ url: string; headers: Record<string, string>; body: { value?: Record<string, unknown> } }>;
    };
    assert.equal(record.modelId, SEEDREAM_PRO_MODEL);
    assert.equal(record.params.yuan, 0.6);
    assert.equal(record.calls[0]?.url, `${BASE}/images/generations`.replace(BASE, "https://ark.cn-beijing.volces.com/api/v3"));
    const body = record.calls[0]?.body.value;
    assert.equal(body?.size, "2816x1584");
    assert.equal(body?.watermark, false);
    assert.equal(JSON.stringify(body).includes("sequential_image_generation"), false);
    assert.equal(record.calls[0]?.headers["X-Group"], undefined);
  });
});

test("missing ARK_API_KEY fails in Chinese before any request", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const seen: string[] = [];
    const cap = capture(isolatedEnv(dir), {
      fetch: (async (url: string) => {
        seen.push(url);
        throw new Error("should not send");
      }) as never,
    });
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--resolution", "1.5K", "--execute", "--project", dir],
        cap.io,
      ),
      1,
    );
    assert.match(cap.out(), /estimate: 0\.30 yuan/);
    assert.match(cap.err(), /缺少火山方舟 API Key/);
    assert.match(cap.err(), /ARK_API_KEY/);
    assert.equal(seen.length, 0);
  });
});

test("a custom key env still names ARK_API_KEY", async () => {
  await withDir(async (dir) => {
    const set = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["providers", "set", SEEDREAM_PRO_MODEL, "--provider", "volcark", "--api-key-env", "OTHER_KEY", "--project", dir],
        set.io,
      ),
      0,
      set.err(),
    );
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--execute", "--project", dir],
        cap.io,
      ),
      1,
    );
    assert.match(cap.err(), /OTHER_KEY/);
    assert.match(cap.err(), /ARK_API_KEY/);
  });
});

test("https reference is a string and two references are an array; flash price is flat", async () => {
  await withDir(async (dir) => {
    await bind(dir, SEEDREAM_FLASH_MODEL);
    const cap = capture(isolatedEnv(dir, { ARK_API_KEY: "ark-secret" }));
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_FLASH_MODEL, "--prompt", "雨夜街道",
          "--aspect-ratio", "1:1", "--resolution", "2K",
          "--ref", "https://cdn.example/a.png", "--ref", "https://cdn.example/b.png",
          "--project", dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.match(cap.out(), new RegExp(`estimate: 0\\.12 yuan \\(${SEEDREAM_FLASH_MODEL}, 1 image\\)`));
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ body: { value?: { image?: unknown; watermark?: boolean } } }>;
    };
    assert.deepEqual(record.calls[0]?.body.value?.image, ["https://cdn.example/a.png", "https://cdn.example/b.png"]);
    assert.equal(record.calls[0]?.body.value?.watermark, false);
  });
});

test("execute downloads the url and sends Bearer ARK_API_KEY", async () => {
  await withDir(async (dir) => {
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const seen: Array<{ url: string; auth: string | null; body?: Record<string, unknown> }> = [];
    const cap = capture(isolatedEnv(dir, { ARK_API_KEY: "ark-secret-value" }), {
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          auth: headers.get("authorization"),
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
        });
        if (url === `${BASE}/images/generations`) {
          return Response.json({ data: [{ url: "https://cdn.example/out.png" }] });
        }
        if (url === "https://cdn.example/out.png") {
          return new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected ${url}`);
      }) as never,
      cwd: dir,
    });
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--aspect-ratio", "1:1", "--resolution", "1K", "--out", "out/dog.png", "--execute", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.equal(seen[0]?.auth, "Bearer ark-secret-value");
    assert.equal(seen[0]?.body?.watermark, false);
    assert.equal(seen[0]?.body?.size, "1024x1024");
    assert.equal(seen[1]?.url, "https://cdn.example/out.png");
    assert.equal(seen[1]?.auth, null);
    assert.deepEqual(await readFile(path.join(dir, "out/dog.png")), Buffer.from([9, 8, 7]));
    assert.equal(JSON.stringify(seen).includes("ark-secret-value"), true);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const dumped = await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8");
    assert.equal(dumped.includes("ark-secret-value"), false);
  });
});

test("local reference uploads to lumen42 and the presigned url is the image field", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const file = path.join(dir, "lumen.config.json");
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    current.tos = {};
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
    const seen: Array<{ method: string; url: string; auth: string | null; body?: Record<string, unknown> }> = [];
    const cap = capture(
      isolatedEnv(dir, { ARK_API_KEY: "ark-secret", VOLC_ACCESSKEY: "AKIDlumen42test", VOLC_SECRETKEY: "tos-secret-key-value" }),
      {
        fetch: (async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const method = init?.method ?? "GET";
          seen.push({
            method,
            url,
            auth: headers.get("authorization"),
            ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
          });
          if (method === "PUT" && url.includes(".tos-cn-beijing.volces.com/")) return new Response(null, { status: 200 });
          if (url === `${BASE}/images/generations`) return Response.json({ data: [{ b64_json: Buffer.from("png").toString("base64") }] });
          throw new Error(`unexpected ${method} ${url}`);
        }) as never,
        cwd: dir,
      },
    );
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "保留图 1", "--ref", "a.png", "--aspect-ratio", "1:1", "--resolution", "1.5K", "--out", "out/edit.png", "--execute", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const put = seen.find((item) => item.method === "PUT");
    assert.equal(put?.url, `https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png`);
    assert.match(put?.auth ?? "", /TOS4-HMAC-SHA256/);
    assert.equal((put?.auth ?? "").includes("ark-secret"), false);
    const post = seen.find((item) => item.url === `${BASE}/images/generations`);
    assert.equal(post?.auth, "Bearer ark-secret");
    assert.equal(post?.body?.size, "1536x1536");
    assert.equal(typeof post?.body?.image, "string");
    assert.match(String(post?.body?.image), new RegExp(`^https://lumen42\\.tos-cn-beijing\\.volces\\.com/lumen-${sha("AAA")}\\.png\\?`));
    assert.deepEqual(await readFile(path.join(dir, "out/edit.png")), Buffer.from("png"));
  });
});

test("local reference without tos fails in Chinese and does not send", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bind(dir);
    const seen: string[] = [];
    const cap = capture(isolatedEnv(dir, { ARK_API_KEY: "ark-secret" }), {
      fetch: (async (url: string) => {
        seen.push(url);
        throw new Error("should not send");
      }) as never,
      cwd: dir,
    });
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--ref", "a.png", "--execute", "--project", dir],
        cap.io,
      ),
      1,
    );
    assert.match(cap.err(), /lumen42/);
    assert.match(cap.err(), /VOLC_ACCESSKEY/);
    assert.match(cap.err(), /"tos": \{\}/);
    assert.equal(seen.length, 0);
  });
});

test("dry-run plans the TOS put and does not send", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const file = path.join(dir, "lumen.config.json");
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    current.tos = {};
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
    const seen: string[] = [];
    const cap = capture(
      isolatedEnv(dir, { VOLC_ACCESSKEY: "AKIDlumen42test", VOLC_SECRETKEY: "tos-secret-key-value" }),
      {
        fetch: (async (url: string) => {
          seen.push(url);
          throw new Error("should not send");
        }) as never,
        cwd: dir,
      },
    );
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--ref", "a.png", "--dry-run", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.equal(seen.length, 0);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ method: string; url: string; body: { value?: { image?: string } } }>;
    };
    assert.equal(record.calls[0]?.method, "PUT");
    assert.equal(record.calls[0]?.url, `https://lumen42.tos-cn-beijing.volces.com/lumen-${sha("AAA")}.png`);
    assert.equal(record.calls[1]?.body.value?.image, `{{upload:${sha("AAA")}}}`);
  });
});

test("http references are rejected", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "一只柴犬", "--ref", "http://cdn.example/a.png", "--project", dir],
        cap.io,
      ),
      1,
    );
    assert.match(cap.err(), /https:\/\//);
  });
});

test("volcark cannot serve gpt-image and the skill is Chinese", async () => {
  await withDir(async (dir) => {
    const wrong = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["providers", "set", "gpt-image-2", "--provider", "volcark", "--api-key-env", "ARK_API_KEY", "--project", dir],
        wrong.io,
      ),
      1,
    );
    assert.match(wrong.err(), /cannot serve gpt-image-2/);
  });
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  assert.match(skill, /references\/seedream\/SKILL\.md/);
  assert.match(skill, /references\/seedream-提示词写法\/SKILL\.md/);
  assert.match(skill, /提示词用中文写/);
  const usage = await readFile(path.join(root, "skills", "lumen", "references", "seedream", "SKILL.md"), "utf8");
  const pe = await readFile(path.join(root, "skills", "lumen", "references", "seedream-提示词写法", "SKILL.md"), "utf8");
  assert.match(usage, /name:\s*seedream/);
  assert.match(usage, /提示词用中文写/);
  assert.match(usage, /不要把提示词翻译成英文/);
  assert.match(usage, /ARK_API_KEY/);
  assert.match(usage, /0\.30/);
  assert.match(usage, /0\.60/);
  assert.match(usage, /0\.12/);
  assert.match(usage, /1\.5K/);
  assert.match(usage, /lumen42/);
  assert.match(usage, /watermark|水印/);
  assert.equal(/images\/generations/.test(usage), false);
  assert.match(pe, /提示词用中文写/);
  assert.match(pe, /不要把中文提示词再翻译成英文/);
  assert.match(pe, /图 1/);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /volcark/);
  assert.match(readme, new RegExp(SEEDREAM_PRO_MODEL));
  assert.match(readme, /watermark: false/);
});
