import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { beeftvImageWireModel, planBeeftvImage } from "../src/clients/beeftv.js";
import { PROVIDER_DEFAULT_BASE_URLS, SEEDREAM_FLASH_MODEL, SEEDREAM_PRO_MODEL } from "../src/catalog.js";
import { seedreamCost } from "../src/seedream/cost.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://beef.example";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function isolatedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg-config") };
  delete env.BEEFAPI_KEY;
  return { ...env, ...extra };
}

async function bind(dir: string, model = SEEDREAM_PRO_MODEL, extra: string[] = []): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", "beeftv", "--api-key-env", "BEEFAPI_KEY", ...extra, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

test("beeftv seedream wire ids default to the dola names", () => {
  assert.equal(beeftvImageWireModel(SEEDREAM_PRO_MODEL, undefined), "dola-seedream-5-0-pro-260628");
  assert.equal(beeftvImageWireModel(SEEDREAM_FLASH_MODEL, undefined), "dola-seedream-5-0-flash-260915");
  assert.equal(beeftvImageWireModel(SEEDREAM_PRO_MODEL, "custom-dola"), "custom-dola");
  assert.equal(PROVIDER_DEFAULT_BASE_URLS.beeftv, "https://enterprise.beefapi.com");
});

test("beeftv price table includes image generation and reference fees", () => {
  const pro = (resolution: string, references = 0, aspectRatio = "auto") =>
    seedreamCost({ modelId: SEEDREAM_PRO_MODEL, resolution, provider: "beeftv", references, aspectRatio });
  const flash = (references = 0) =>
    seedreamCost({ modelId: SEEDREAM_FLASH_MODEL, resolution: "2K", provider: "beeftv", references });
  assert.equal(flash().text, `estimate: 0.04 yuan (${SEEDREAM_FLASH_MODEL} beeftv, 1 image)`);
  assert.equal(flash(2).text, `estimate: 0.04 yuan (${SEEDREAM_FLASH_MODEL} beeftv, 1 image, 2 refs free)`);
  assert.equal(flash(2).yuan, 0.04);
  assert.equal(pro("1K").text, `estimate: 0.09 yuan (${SEEDREAM_PRO_MODEL} beeftv ≤2.61M px, 1 image)`);
  assert.equal(pro("1.5K", 1, "16:9").text, `estimate: 0.09 yuan (${SEEDREAM_PRO_MODEL} beeftv ≤2.61M px, 1 image, 1 ref free)`);
  assert.equal(pro("2K").text, `estimate: 0.18 yuan (${SEEDREAM_PRO_MODEL} beeftv >2.61M px, 1 image)`);
  assert.equal(pro("2K", 3).yuan, 0.18);
  assert.match(pro("2K", 3).text, /<0\.01 yuan x 2 refs/);
  assert.match(pro("2K", 3).text, /first free/);
});

test("omitted seedream resolution is 2K and the body uses images plus the dola id", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", "seedream-5-pro", "--prompt", "一只柴犬", "--aspect-ratio", "16:9", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.match(cap.out(), new RegExp(`estimate: 0\\.18 yuan \\(${SEEDREAM_PRO_MODEL} beeftv >2\\.61M px, 1 image\\)`));
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ url: string; body: { value?: Record<string, unknown> } }>;
    };
    const body = record.calls[0]?.body.value;
    assert.equal(record.calls[0]?.url, "https://enterprise.beefapi.com/v1/images/generations");
    assert.equal(body?.model, "dola-seedream-5-0-pro-260628");
    assert.equal(body?.size, "2816x1584");
    assert.equal(body?.n, 1);
    assert.equal(body?.watermark, false);
    assert.equal(body?.images, undefined);
    assert.equal(JSON.stringify(body).includes("sequential_image_generation"), false);
  });
});

test("beeftv https and data URI refs skip upload; alias overrides the wire id", async () => {
  await withDir(async (dir) => {
    await bind(dir, SEEDREAM_FLASH_MODEL, ["--base-url", BASE, "--model-alias", "dola-custom"]);
    const seen: string[] = [];
    const cap = capture(isolatedEnv(dir), {
      fetch: (async (url: string) => {
        seen.push(url);
        throw new Error("should not send");
      }) as never,
    });
    const data = "data:image/png;base64,aaaa";
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_FLASH_MODEL, "--prompt", "雨夜",
          "--ref", "https://cdn.example/a.png", "--ref", data,
          "--resolution", "1K", "--project", dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.equal(seen.length, 0);
    assert.match(cap.out(), /0\.04 yuan/);
    assert.match(cap.out(), /2 refs free/);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ url: string; body: { value?: { model?: string; images?: string[] } } }>;
    };
    assert.equal(record.calls[0]?.url, `${BASE}/v1/images/generations`);
    assert.equal(record.calls[0]?.body.value?.model, "dola-custom");
    assert.deepEqual(record.calls[0]?.body.value?.images, ["https://cdn.example/a.png", data]);
    const planned = planBeeftvImage(
      {
        modelId: SEEDREAM_FLASH_MODEL,
        prompt: "雨夜",
        aspectRatio: "1:1",
        resolution: "1K",
        references: [],
      },
      { provider: "beeftv", baseUrl: BASE, apiKeyEnv: "BEEFAPI_KEY" },
      "1K",
    );
    assert.equal(planned[0]?.url, `${BASE}/v1/images/generations`);
  });
});

test("beeftv local image uploads, then the https url is the images entry", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.png"), "AAA");
    await bind(dir, SEEDREAM_PRO_MODEL, ["--base-url", BASE]);
    const seen: Array<{ method: string; url: string; auth: string | null; body?: Record<string, unknown> }> = [];
    const cap = capture(isolatedEnv(dir, { BEEFAPI_KEY: "beef-secret" }), {
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const method = init?.method ?? "GET";
        seen.push({
          method,
          url,
          auth: headers.get("authorization"),
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
        });
        if (method === "POST" && url === `${BASE}/v1/video-references/uploads`) {
          return Response.json({
            ticket: "t1",
            upload_url: "https://upload.example/put?sig=secret",
            upload_method: "PUT",
            required_headers: { "Content-Type": "image/png" },
          });
        }
        if (method === "PUT") return new Response(null, { status: 200 });
        if (url === `${BASE}/v1/video-references/uploads/complete`) return Response.json({ url: "https://cdn.example/ref.png" });
        if (url === `${BASE}/v1/images/generations`) return Response.json({ data: [{ url: "https://cdn.example/out.png" }] });
        if (url === "https://cdn.example/out.png") {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected ${method} ${url}`);
      }) as never,
      cwd: dir,
    });
    assert.equal(
      await run(
        [
          "gen", "image", "--model", SEEDREAM_PRO_MODEL, "--prompt", "保留图 1",
          "--ref", "a.png", "--aspect-ratio", "1:1", "--resolution", "2K",
          "--out", "out/edit.png", "--execute", "--project", dir,
        ],
        cap.io,
      ),
      0,
      cap.err(),
    );
    assert.match(cap.out(), /1 ref free/);
    const post = seen.find((item) => item.url === `${BASE}/v1/images/generations`);
    assert.equal(post?.auth, "Bearer beef-secret");
    assert.equal(post?.body?.model, "dola-seedream-5-0-pro-260628");
    assert.deepEqual(post?.body?.images, ["https://cdn.example/ref.png"]);
    assert.equal(seen.some((item) => item.method === "PUT"), true);
    assert.equal(seen.find((item) => item.method === "PUT")?.auth, null);
    assert.deepEqual(await readFile(path.join(dir, "out/edit.png")), Buffer.from([1, 2, 3]));
  });
});

test("beeftv dry-run plans the upload and does not send", async () => {
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
      calls: Array<{ method: string; url: string; body: { value?: { images?: string[]; sha256?: string } } }>;
    };
    assert.equal(record.calls[0]?.url, `${BASE}/v1/video-references/uploads`);
    assert.equal(record.calls[0]?.body.value?.sha256, sha("AAA"));
    assert.deepEqual(record.calls[1]?.body.value?.images, [`{{upload:${sha("AAA")}}}`]);
    assert.equal(record.calls[1]?.url, `${BASE}/v1/images/generations`);
  });
});
