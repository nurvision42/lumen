import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { imageSize } from "../src/clients/wire.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

interface RunFile {
  id: string;
  status: string;
  modelId: string;
  params: { prompt?: string; references?: Array<{ personReference?: boolean }> };
  binding: { provider: string; baseUrl: string; apiKeyEnv: string; group?: string; keyPresent: boolean } | null;
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: { kind: string; value?: Record<string, unknown> } }>;
  error?: string;
}

async function runs(dir: string): Promise<RunFile[]> {
  const root = path.join(dir, ".lumen", "runs");
  const names = await readdir(root);
  const files = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(root, name, "record.json"), "utf8")) as RunFile));
  return files;
}

async function bind(dir: string, model: string, provider: string, base: string, envName: string, group?: string): Promise<void> {
  const args = ["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", envName, "--project", dir];
  if (group !== undefined) args.push("--group", group);
  const cap = capture();
  assert.equal(await run(args, cap.io), 0, cap.err());
}

test("two seedance models keep separate bindings and do not fall back", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2", "haomao", "https://cat.example/api/v3", "KEY_A");
    await bind(dir, "seedance-2-fast", "haomao", "https://fast.example/api/v3", "KEY_B");
    const env = { KEY_A: "secret-a-value-xx", KEY_B: "secret-b-value-yy" };

    const slow = capture(env);
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "a cat walks", "--duration", "5", "--project", dir],
        slow.io,
      ),
      0,
      slow.err(),
    );
    const fast = capture(env);
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2-fast", "--shape", "reference", "--prompt", "match the plate", "--duration", "4", "--ref", "image|https://cdn.example/a.png|true", "--project", dir],
        fast.io,
      ),
      0,
      fast.err(),
    );
    const missing = capture(env);
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2-mini", "--shape", "text", "--prompt", "no binding", "--duration", "5", "--project", dir],
        missing.io,
      ),
      1,
    );
    assert.match(missing.err(), /no provider binding for seedance-2-mini/);

    const wrong = capture();
    assert.equal(
      await run(
        ["providers", "set", "gpt-image-2", "--provider", "kitta", "--base-url", "https://fishaudio.org", "--api-key-env", "KITTA", "--project", dir],
        wrong.io,
      ),
      1,
    );
    assert.match(wrong.err(), /provider kitta cannot serve gpt-image-2/);

    const records = await runs(dir);
    const cat = records.find((record) => record.modelId === "seedance-2");
    const plate = records.find((record) => record.modelId === "seedance-2-fast");
    assert.ok(cat);
    assert.ok(plate);
    assert.equal(cat.binding?.apiKeyEnv, "KEY_A");
    assert.match(cat.calls[0]?.url ?? "", /cat\.example\/api\/v3\/contents\/generations\/tasks$/);
    const catContent = cat.calls[0]?.body.value?.content as Array<{ text?: string }> | undefined;
    assert.equal(catContent?.[0]?.text, "a cat walks");
    assert.equal(plate.binding?.apiKeyEnv, "KEY_B");
    assert.match(plate.calls[0]?.url ?? "", /fast\.example\/api\/v3\/contents\/generations\/tasks$/);
    const plateContent = plate.calls[0]?.body.value?.content as Array<{ role?: string }> | undefined;
    assert.equal(plateContent?.some((item) => item.role === "reference_image"), true);
    assert.equal(plate.params.references?.[0]?.personReference, true);
    assert.equal(JSON.stringify(plate.calls).includes("personReference"), false);
    const dumped = JSON.stringify(records);
    assert.match(dumped, /a cat walks/);
    assert.equal(dumped.includes("secret-a-value-xx"), false);
    assert.equal(dumped.includes("secret-b-value-yy"), false);

    const listed = capture();
    assert.equal(await run(["runs", "list", "--project", dir], listed.io), 0);
    assert.match(listed.out(), new RegExp(cat.id));
    const shown = capture();
    assert.equal(await run(["runs", "show", cat.id, "--project", dir], shown.io), 0);
    assert.match(shown.out(), /a cat walks/);
    assert.equal(shown.out().includes("secret-a-value-xx"), false);
  });
});

test("gpt-image sizes use one resolution scale for every model", () => {
  assert.equal(imageSize("1:1", "1K"), "1024x1024");
  assert.equal(imageSize("1:1", "2K"), "1456x1456");
  assert.equal(imageSize("1:1", "4K"), "2048x2048");
  assert.equal(imageSize("16:9", "1K"), "1536x864");
  assert.equal(imageSize("16:9", "2K"), "2176x1216");
  assert.equal(imageSize("16:9", "4K"), "3072x1728");
  assert.equal(imageSize("auto", "1K"), "auto");
  assert.throws(() => imageSize("auto", "4K"), /aspect-ratio auto cannot be combined with resolution 2K or 4K/);
});

test("image generation and edit take different paths, and seedance rules reject bad input", async () => {
  await withDir(async (dir) => {
    await bind(dir, "gpt-image-2", "grsai", "https://grsai.example", "GRSAI");
    await bind(dir, "gpt-image-2.5-flare", "yunqiao", "https://yunqiao.example/v1", "YQ", "image-a");
    await bind(dir, "seedance-2", "haomao", "https://haomao.example/api/v3", "HAOMAO");
    await bind(dir, "seedance-2.5", "haomao", "https://haomao.example/api/v3", "HAOMAO25");

    const gen = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "a red door", "--aspect-ratio", "1:1", "--resolution", "1K", "--project", dir],
        gen.io,
      ),
      0,
      gen.err(),
    );
    const edit = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "move the door", "--ref", "https://cdn.example/a.png", "--aspect-ratio", "16:9", "--resolution", "1K", "--project", dir],
        edit.io,
      ),
      0,
      edit.err(),
    );
    const sized = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2.5-flare", "--prompt", "square sun", "--aspect-ratio", "1:1", "--resolution", "2K", "--quality", "high", "--project", dir],
        sized.io,
      ),
      0,
      sized.err(),
    );
    await bind(dir, "gpt-image-2.5-sunburst", "grsai", "https://grsai.example", "GRSAI");
    const sunburst = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2.5-sunburst", "--prompt", "sunburst max", "--aspect-ratio", "1:1", "--resolution", "4K", "--project", dir],
        sunburst.io,
      ),
      0,
      sunburst.err(),
    );
    const fourK = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "wide four k", "--aspect-ratio", "16:9", "--resolution", "4K", "--project", dir],
        fourK.io,
      ),
      0,
      fourK.err(),
    );
    const yunqiaoFourK = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2.5-flare", "--prompt", "yunqiao four k", "--aspect-ratio", "16:9", "--resolution", "4K", "--project", dir],
        yunqiaoFourK.io,
      ),
      1,
    );
    assert.match(yunqiaoFourK.err(), /provider yunqiao does not support resolution 4K/);
    const classic = capture();
    assert.equal(
      await run(
        ["providers", "set", "gpt-image-2", "--provider", "yunqiao", "--base-url", "https://yunqiao.example/v1", "--api-key-env", "YQ", "--project", dir],
        classic.io,
      ),
      0,
    );
    const wide = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "wide", "--aspect-ratio", "16:9", "--resolution", "4K", "--project", dir],
        wide.io,
      ),
      1,
    );
    assert.match(wide.err(), /provider yunqiao does not support resolution 4K/);
    const classicQuality = capture();
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "bad quality", "--quality", "max", "--project", dir],
        classicQuality.io,
      ),
      1,
    );
    assert.match(classicQuality.err(), /quality must be one of auto, low, medium, high/);

    const records = await runs(dir);
    const generated = records.find((record) => record.params.prompt === "a red door");
    const edited = records.find((record) => record.params.prompt === "move the door");
    const flare = records.find((record) => record.params.prompt === "square sun");
    const burst = records.find((record) => record.params.prompt === "sunburst max" && record.status !== "error");
    const wideFour = records.find((record) => record.params.prompt === "wide four k");
    assert.match(generated?.calls[0]?.url ?? "", /\/v1\/images\/generations$/);
    assert.equal(generated?.calls[0]?.body.value?.size, "1024x1024");
    assert.equal(generated?.calls[0]?.body.value?.quality, "high");
    assert.match(edited?.calls[0]?.url ?? "", /\/v1\/images\/generations$/);
    assert.deepEqual(edited?.calls[0]?.body.value?.image, ["https://cdn.example/a.png"]);
    assert.equal(flare?.calls[0]?.body.value?.size, "1456x1456");
    assert.equal(flare?.calls[0]?.body.value?.quality, "high");
    assert.equal(flare?.calls[0]?.headers["X-Group"], "image-a");
    assert.equal(burst?.calls[0]?.body.value?.size, "2048x2048");
    assert.equal(burst?.calls[0]?.body.value?.quality, "max");
    assert.equal(wideFour?.calls[0]?.body.value?.size, "3072x1728");
    assert.equal(wideFour?.calls[0]?.body.value?.quality, "high");

    const duration = capture();
    assert.equal(
      await run(["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "short", "--duration", "3", "--project", dir], duration.io),
      1,
    );
    assert.match(duration.err(), /duration is a whole number from 4 to 15/);
    const audio = capture();
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "reference", "--prompt", "talk", "--duration", "5", "--ref", "audio|voice.m4a", "--project", dir],
        audio.io,
      ),
      1,
    );
    assert.match(audio.err(), /m4a/);
    const search = capture();
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "frame", "--prompt", "hold", "--duration", "5", "--web-search", "--project", dir],
        search.io,
      ),
      1,
    );
    assert.match(search.err(), /web-search is only available on shape text/);
    const searchText = capture();
    assert.equal(
      await run(
        ["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "look it up", "--duration", "5", "--web-search", "--project", dir],
        searchText.io,
      ),
      1,
    );
    assert.match(searchText.err(), /does not accept web-search/);
    const frame = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "frame", "--prompt", "hold", "--duration", "5",
          "--aspect-ratio", "16:9", "--first-frame", "https://cdn.example/a.png", "--first-person", "true", "--project", dir,
        ],
        frame.io,
      ),
      1,
    );
    assert.match(frame.err(), /aspect-ratio adaptive/);
  });
});

test("kitta design sends the prompt and fishaudio provider", async () => {
  await withDir(async (dir) => {
    await bind(dir, "voice-design-1", "kitta", "https://fishaudio.org", "KITTA_KEY");
    const cap = capture({ KITTA_KEY: "kitta-secret-value" });
    assert.equal(await run(["fish", "design", "--instruction", "warm narrator", "--project", dir], cap.io), 0, cap.err());
    const [record] = await runs(dir);
    assert.equal(record?.modelId, "voice-design-1");
    assert.match(record?.calls[0]?.url ?? "", /fishaudio\.org\/api\/open\/v1\/voice-designs$/);
    assert.match(record?.calls[0]?.headers["Idempotency-Key"] ?? "", /^lumen-/);
    assert.equal(record?.calls[0]?.body.value?.prompt, "warm narrator");
    assert.deepEqual(record?.calls[0]?.body.value?.providers, ["fishaudio"]);
    assert.equal(JSON.stringify(record).includes("kitta-secret-value"), false);
  });
});

test("execute without an API key fails and still writes an error run", async () => {
  await withDir(async (dir) => {
    await bind(dir, "enhance-video-generative", "mediakit", "https://mediakit.example", "MEDIAKIT_KEY", "queue-a");
    const cap = capture({});
    assert.equal(
      await run(["enhance", "--video", "refs/in.mp4", "--execute", "--project", dir], cap.io),
      1,
    );
    assert.match(cap.err(), /missing API key env MEDIAKIT_KEY/);
    const [record] = await runs(dir);
    assert.equal(record?.status, "error");
    assert.match(record?.error ?? "", /missing API key env MEDIAKIT_KEY/);
    assert.equal(record?.calls.length, 0);
  });
});
