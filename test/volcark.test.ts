import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VOLCARK_SEEDREAM_55_WIRE, planVolcarkImage, seedreamSize, volcarkImageRef, volcarkImageWireModel } from "../src/clients/volcark.js";
import {
  IMAGE_ASPECTS,
  PROVIDER_DEFAULT_BASE_URLS,
  SEEDREAM_55_MODEL,
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
  const volc = (modelId: string, resolution: string) => seedreamCost({ modelId, resolution, provider: "volcark" });
  assert.equal(volc(SEEDREAM_PRO_MODEL, "1K").text, `estimate: 0.30 yuan (${SEEDREAM_PRO_MODEL} ≤1.5K, 1 image)`);
  assert.equal(volc(SEEDREAM_PRO_MODEL, "1.5K").text, `estimate: 0.30 yuan (${SEEDREAM_PRO_MODEL} ≤1.5K, 1 image)`);
  assert.equal(volc(SEEDREAM_PRO_MODEL, "2K").text, `estimate: 0.60 yuan (${SEEDREAM_PRO_MODEL} 2K, 1 image)`);
  assert.equal(volc(SEEDREAM_PRO_MODEL, "2K").yuan, 0.6);
  assert.equal(volc(SEEDREAM_FLASH_MODEL, "1K").text, `estimate: 0.12 yuan (${SEEDREAM_FLASH_MODEL}, 1 image)`);
  assert.equal(volc(SEEDREAM_FLASH_MODEL, "2K").yuan, 0.12);
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
  assert.match(listed.out(), new RegExp(`${SEEDREAM_PRO_MODEL}  image  beeftv,volcark`));
  assert.match(listed.out(), new RegExp(`${SEEDREAM_FLASH_MODEL}  image  beeftv,volcark`));
  assert.match(listed.out(), /0\.30 yuan/);
  assert.match(listed.out(), /0\.12 yuan/);
  const alias = capture();
  assert.equal(await run(["models", "seedream-5-pro"], alias.io), 0, alias.err());
  assert.match(alias.out(), new RegExp(`^${SEEDREAM_PRO_MODEL}  image  beeftv,volcark`, "m"));
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

test("a local reference is a data URI and nothing is uploaded", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await writeFile(path.join(dir, "b.jpg"), "BBB");
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    const cap = capture(isolatedEnv(dir, { ARK_API_KEY: "ark-secret" }), {
      fetch: (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        seen.push({
          method,
          url,
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
        });
        if (url === `${BASE}/images/generations`) return Response.json({ data: [{ b64_json: Buffer.from("png").toString("base64") }] });
        throw new Error(`unexpected ${method} ${url}`);
      }) as never,
      cwd: dir,
    });
    const png = `data:image/png;base64,${Buffer.from("AAA").toString("base64")}`;
    const jpeg = `data:image/jpeg;base64,${Buffer.from("BBB").toString("base64")}`;
    assert.equal(await volcarkImageRef("a.png", dir), png);
    assert.equal(await volcarkImageRef("b.jpg", dir), jpeg);
    assert.equal(await volcarkImageRef("https://cdn.example/a.png", dir), "https://cdn.example/a.png");
    assert.equal(await volcarkImageRef(png, dir), png);
    await assert.rejects(volcarkImageRef("missing.png", dir), /本地参考图不存在/);
    await writeFile(path.join(dir, "c.txt"), "nope");
    await assert.rejects(volcarkImageRef("c.txt", dir), /格式不支持/);
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "保留图 1",
          "--ref", "a.png", "--ref", "b.jpg", "--ref", "https://cdn.example/c.png",
          "--aspect-ratio", "1:1", "--resolution", "1.5K", "--out", "out/edit.png",
          "--execute", "--project", dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, `${BASE}/images/generations`);
    assert.deepEqual(seen[0]?.body?.image, [png, jpeg, "https://cdn.example/c.png"]);
    assert.deepEqual(await readFile(path.join(dir, "out/edit.png")), Buffer.from("png"));
  });
});

test("dry-run encodes a local reference and does not send", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const seen: string[] = [];
    const cap = capture(isolatedEnv(dir), {
      fetch: (async (url: string) => {
        seen.push(url);
        throw new Error("should not send");
      }) as never,
      cwd: dir,
    });
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
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0]?.method, "POST");
    assert.equal(record.calls[0]?.url, `${BASE}/images/generations`);
    assert.equal(record.calls[0]?.body.value?.image, `data:image/png;base64,${Buffer.from("AAA").toString("base64")}`);
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
  assert.match(skill, /references\/生图-提示词写法\/SKILL\.md/);
  assert.match(skill, /提示词用中文写/);
  const usage = await readFile(path.join(root, "skills", "lumen", "references", "seedream", "SKILL.md"), "utf8");
  const pe = await readFile(path.join(root, "skills", "lumen", "references", "生图-提示词写法", "SKILL.md"), "utf8");
  assert.match(usage, /name:\s*seedream/);
  assert.match(usage, /提示词用中文写/);
  assert.match(usage, /不要把提示词翻译成英文/);
  assert.match(usage, /ARK_API_KEY/);
  assert.match(usage, /0\.30/);
  assert.match(usage, /0\.60/);
  assert.match(usage, /0\.12/);
  assert.match(usage, /1\.5K/);
  assert.match(usage, /data:image/);
  assert.equal(/lumen42|VOLC_ACCESSKEY|VOLC_SECRETKEY/.test(usage), false);
  assert.match(usage, /watermark|水印/);
  assert.equal(/images\/generations/.test(usage), false);
  assert.match(skill, /默认供应商是 `beeftv`/);
  assert.match(skill, /本地参考图读成 data URI/);
  assert.match(usage, /默认供应商是 `beeftv`/);
  assert.match(usage, /省略时是 `2K`/);
  assert.equal(skill.includes("本地参考图上传到火山引擎 TOS"), false);
  assert.match(pe, /提示词用中文写/);
  assert.match(pe, /不要把中文正文另译成英文/);
  assert.match(pe, /图 1/);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /volcark/);
  assert.match(readme, new RegExp(SEEDREAM_PRO_MODEL));
  assert.match(readme, /watermark: false/);
  assert.match(readme, /不上传 TOS/);
  assert.equal(readme.includes("本地文件走现有 TOS"), false);
  const help = await readFile(path.join(root, "src", "help.ts"), "utf8");
  assert.match(help, /Local files are read and sent/);
  assert.match(help, /data:image\/\.\.\.;base64/);
  assert.match(help, /Volcark does not upload them/);
  assert.equal(help.includes("volcark local") && help.includes("lumen42"), false);
});

test("volcark seedream-5.5 wire id is the Ark id unless aliased", () => {
  assert.equal(volcarkImageWireModel(SEEDREAM_55_MODEL, undefined), VOLCARK_SEEDREAM_55_WIRE);
  assert.equal(volcarkImageWireModel("seedream-5-5", undefined), VOLCARK_SEEDREAM_55_WIRE);
  assert.equal(volcarkImageWireModel(SEEDREAM_55_MODEL, "custom-5.5"), "custom-5.5");
  assert.equal(volcarkImageWireModel(SEEDREAM_PRO_MODEL, undefined), SEEDREAM_PRO_MODEL);
});

test("volcark seedream-5.5 allows 1K/1.5K/2K, background, and ten refs", () => {
  const base = {
    modelId: SEEDREAM_55_MODEL,
    prompt: "一只杯子",
    aspectRatio: "auto" as const,
    resolution: "2K",
    background: undefined as string | undefined,
    quality: undefined,
    references: [] as string[],
    provider: "volcark",
  };
  const auto = validateImage(base);
  assert.equal(auto.aspectRatio, "auto");
  assert.equal(auto.resolution, "2K");
  assert.equal(auto.background, undefined);
  const mid = validateImage({ ...base, resolution: "1.5K", background: "auto" });
  assert.equal(mid.resolution, "1.5K");
  assert.equal(mid.background, "auto");
  const clear = validateImage({
    ...base,
    aspectRatio: "9:16",
    background: "transparent",
    references: Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.jpg`),
  });
  assert.equal(clear.background, "transparent");
  assert.equal(clear.references.length, 10);
  assert.equal(clear.outputFormat, undefined);

  assert.throws(() => validateImage({ ...base, resolution: "4K" }), /1K, 1.5K, 2K/);
  assert.throws(() => validateImage({ ...base, resolution: "3K" }), /1K, 1.5K, 2K/);
  assert.throws(() => validateImage({ ...base, quality: "high" }), /does not take --quality/);
  assert.throws(
    () => validateImage({ ...base, references: Array.from({ length: 11 }, () => "https://cdn.example/a.png") }),
    /limited to 10/,
  );
  assert.throws(
    () => validateImage({ ...base, background: "transparent", outputFormat: "jpeg" }),
    /transparent requires png/,
  );
  assert.throws(() => validateImage({ ...base, outputFormat: "webp" }), /png or jpeg/);
  const jpeg = validateImage({ ...base, background: "opaque", outputFormat: "jpeg" });
  assert.equal(jpeg.outputFormat, "jpeg");
  assert.equal(jpeg.background, "opaque");
});

test("volcark seedream-5.5 body uses the Ark id, size, background, and refs", () => {
  const one = validateImage({
    modelId: "seedream-5-5",
    prompt: "一只杯子",
    aspectRatio: "16:9",
    resolution: "2K",
    background: "transparent",
    quality: undefined,
    references: ["https://cdn.example/a.jpg", "data:image/jpeg;base64,aaaa"],
    provider: "volcark",
  });
  const call = planVolcarkImage(one, binding());
  const body = jsonBody(call[0]);
  assert.equal(call[0]?.url, `${BASE}/images/generations`);
  assert.equal(body.model, VOLCARK_SEEDREAM_55_WIRE);
  assert.equal(body.size, "2816x1584");
  assert.equal(body.background, "transparent");
  assert.equal(body.output_format, "png");
  assert.equal(body.watermark, false);
  assert.equal(body.response_format, "url");
  assert.deepEqual(body.image, ["https://cdn.example/a.jpg", "data:image/jpeg;base64,aaaa"]);
  assert.equal(JSON.stringify(body).includes("sequential_image_generation"), false);
  assert.equal(JSON.stringify(body).includes("stream"), false);

  const tier = validateImage({
    modelId: SEEDREAM_55_MODEL,
    prompt: "一只杯子",
    aspectRatio: "auto",
    resolution: "1.5K",
    background: "auto",
    quality: undefined,
    references: ["https://cdn.example/only.png"],
    provider: "volcark",
  });
  const tierBody = jsonBody(planVolcarkImage(tier, binding("custom-5.5"))[0]);
  assert.equal(tierBody.model, "custom-5.5");
  assert.equal(tierBody.size, "1.5K");
  assert.equal(tierBody.background, "auto");
  assert.equal(tierBody.image, "https://cdn.example/only.png");

  const jpeg = validateImage({
    modelId: SEEDREAM_55_MODEL,
    prompt: "一只杯子",
    aspectRatio: "1:1",
    resolution: "1K",
    background: "opaque",
    quality: undefined,
    references: [],
    provider: "volcark",
    outputFormat: "jpeg",
  });
  assert.equal(jsonBody(planVolcarkImage(jpeg, binding())[0]).output_format, "jpeg");
  assert.throws(
    () => planVolcarkImage({ ...jpeg, background: "transparent", outputFormat: "jpeg" }, binding()),
    /transparent requires png/,
  );
});

test("volcark seedream-5.5 price uses pixels and charges every input image", () => {
  const cost = (resolution: string, aspectRatio = "auto", references = 0) =>
    seedreamCost({ modelId: SEEDREAM_55_MODEL, resolution, aspectRatio, provider: "volcark", references });
  assert.equal(cost("1K").yuan, 0.13);
  assert.equal(cost("1K").text, "estimate: 0.13 yuan (seedream-5.5 volcark ≤2.61M px, 1 image)");
  assert.equal(cost("1.5K").yuan, 0.13);
  assert.equal(cost("1K", "16:9").yuan, 0.13);
  assert.equal(cost("2K").yuan, 0.23);
  assert.equal(cost("2K", "16:9").text, "estimate: 0.23 yuan (seedream-5.5 volcark >2.61M px, 1 image)");
  assert.equal(cost("2K", "16:9", 2).yuan, 0.33);
  assert.equal(
    cost("1K", "1:1", 1).text,
    "estimate: 0.18 yuan (seedream-5.5 volcark ≤2.61M px, 1 image + 0.05 yuan x 1 input image)",
  );
  assert.equal(seedreamCost({ modelId: SEEDREAM_PRO_MODEL, resolution: "2K", provider: "volcark" }).yuan, 0.6);
});

test("dry-run seedream-5.5 on volcark posts the Ark body and the pixel estimate", async () => {
  await withDir(async (dir) => {
    await bind(dir, SEEDREAM_55_MODEL, ["--base-url", BASE]);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        [
          "gen", "image", "--model", "seedream-5.5", "--prompt", "一只杯子",
          "--aspect-ratio", "16:9", "--resolution", "2K", "--background", "transparent",
          "--ref", "https://cdn.example/a.jpg", "--ref", "data:image/png;base64,aaaa",
          "--project", dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.match(cap.out(), /estimate: 0\.33 yuan \(seedream-5\.5 volcark >2\.61M px, 1 image \+ 0\.05 yuan x 2 input images\)/);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      modelId: string;
      params: { yuan?: number; background?: string };
      calls: Array<{ url: string; body: { value?: Record<string, unknown> } }>;
    };
    assert.equal(record.modelId, SEEDREAM_55_MODEL);
    assert.equal(record.params.yuan, 0.33);
    assert.equal(record.params.background, "transparent");
    const body = record.calls[0]?.body.value;
    assert.equal(record.calls[0]?.url, `${BASE}/images/generations`);
    assert.equal(body?.model, VOLCARK_SEEDREAM_55_WIRE);
    assert.equal(body?.size, "2816x1584");
    assert.equal(body?.background, "transparent");
    assert.equal(body?.output_format, "png");
    assert.equal(body?.watermark, false);
    assert.deepEqual(body?.image, ["https://cdn.example/a.jpg", "data:image/png;base64,aaaa"]);
    assert.equal(JSON.stringify(body).includes("sequential_image_generation"), false);

    const tier = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_55_MODEL, "--prompt", "一只杯子", "--resolution", "1.5K", "--project", dir],
        tier.io,
      ),
      0,
      tier.err(),
    );
    assert.match(tier.out(), /estimate: 0\.13 yuan \(seedream-5\.5 volcark ≤2\.61M px, 1 image\)/);
    const tierId = /run: (\S+)/.exec(tier.out())?.[1];
    assert.ok(tierId);
    const tierRecord = JSON.parse(await readFile(path.join(dir, ".lumen/runs", tierId, "record.json"), "utf8")) as {
      calls: Array<{ body: { value?: { model?: string; size?: string; background?: string } } }>;
    };
    assert.equal(tierRecord.calls[0]?.body.value?.model, VOLCARK_SEEDREAM_55_WIRE);
    assert.equal(tierRecord.calls[0]?.body.value?.size, "1.5K");
    assert.equal(tierRecord.calls[0]?.body.value?.background, undefined);

    const alias = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["providers", "set", SEEDREAM_55_MODEL, "--provider", "volcark", "--base-url", BASE, "--api-key-env", "ARK_API_KEY", "--model-alias", "custom-5.5", "--project", dir],
        alias.io,
      ),
      0,
      alias.err(),
    );
    const aliased = capture(isolatedEnv(dir));
    assert.equal(
      await run(["gen", "image", "--model", "bytedance/seedream-5.5", "--prompt", "一只杯子", "--project", dir], aliased.io),
      0,
      aliased.err(),
    );
    const aliasId = /run: (\S+)/.exec(aliased.out())?.[1];
    assert.ok(aliasId);
    const aliasRecord = JSON.parse(await readFile(path.join(dir, ".lumen/runs", aliasId, "record.json"), "utf8")) as {
      calls: Array<{ body: { value?: { model?: string; size?: string } } }>;
    };
    assert.equal(aliasRecord.calls[0]?.body.value?.model, "custom-5.5");
    assert.equal(aliasRecord.calls[0]?.body.value?.size, "2K");

    const bad = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_55_MODEL, "--prompt", "一只杯子", "--resolution", "4K", "--project", dir],
        bad.io,
      ),
      1,
    );
    assert.match(bad.err(), /1K, 1\.5K, 2K/);
    const many = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_55_MODEL, "--prompt", "一只杯子",
          ...Array.from({ length: 11 }, () => ["--ref", "https://cdn.example/a.png"]).flat(),
          "--project", dir,
        ],
        many.io,
      ),
      1,
    );
    assert.match(many.err(), /limited to 10/);
  });
});

test("models list and docs name seedream-5.5 on yir and volcark", async () => {
  const listed = capture();
  assert.equal(await run(["models", SEEDREAM_55_MODEL], listed.io), 0, listed.err());
  assert.match(listed.out(), new RegExp(`^${SEEDREAM_55_MODEL}  image  yir,volcark`, "m"));
  assert.match(listed.out(), /doubao-seedream-5-5-261028/);
  assert.match(listed.out(), /0\.13 yuan/);
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  const usage = await readFile(path.join(root, "skills", "lumen", "references", "seedream", "SKILL.md"), "utf8");
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const help = await readFile(path.join(root, "src", "help.ts"), "utf8");
  for (const text of [skill, usage, readme, help]) {
    assert.match(text, /doubao-seedream-5-5-261028/);
    assert.match(text, /0\.13/);
    assert.match(text, /0\.05/);
    assert.match(text, /transparent/);
  }
  assert.match(skill, /默认供应商是 `yir`/);
  assert.match(usage, /默认 `yir`/);
  assert.match(readme, /yir（默认）、volcark/);
});
