import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_DEFAULT_BASE_URLS,
  SEEDREAM_55_MODEL,
  SEEDREAM_PRO_MODEL,
  assertProviderServes,
  canonicalModel,
  modelInfo,
  validateImage,
} from "../src/catalog.js";
import { yirImageWireModel, yirTaskState } from "../src/clients/yir.js";
import { seedreamCost } from "../src/seedream/cost.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const BASE = "https://yir.example";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function isolatedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg-config") };
  delete env.YIR_API_KEY;
  return { ...env, ...extra };
}

async function bind(dir: string, extra: string[] = []): Promise<void> {
  const cap = capture(isolatedEnv(dir));
  assert.equal(
    await run(
      ["providers", "set", SEEDREAM_55_MODEL, "--provider", "yir", "--base-url", BASE, "--api-key-env", "YIR_API_KEY", ...extra, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

function imageArgs(dir: string, extra: string[] = []): string[] {
  return [
    "gen", "image", "--model", "seedream-5.5", "--prompt", "一只杯子",
    "--aspect-ratio", "1:1", "--resolution", "2K", "--out", "out/t.png",
    ...extra, "--project", dir,
  ];
}

function jsonBody(init?: RequestInit): unknown | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return undefined;
  }
}

function fakeYir(opts?: { statuses?: string[]; failUpload?: boolean }) {
  const statuses = opts?.statuses ?? ["queued", "succeeded"];
  const seen: Array<{ method: string; url: string; auth?: string | null; idem?: string | null; body?: unknown }> = [];
  let polls = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({
      method,
      url,
      auth: headers.get("authorization"),
      idem: headers.get("idempotency-key"),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (method === "POST" && url === `${BASE}/v1/images/generations`) {
      return Response.json({ id: "job_1", object: "job", status: "queued", error: null }, { status: 202 });
    }
    if (url === `${BASE}/v1/jobs/job_1/status`) {
      const status = statuses[Math.min(polls, statuses.length - 1)]!;
      polls += 1;
      const error = status === "failed" ? { code: "YIR_EXECUTION_FAILED", message: "upstream failed", retryable: false } : null;
      return Response.json({ id: "job_1", status, error });
    }
    if (url === `${BASE}/v1/jobs/job_1`) {
      return Response.json({
        id: "job_1",
        object: "job",
        status: "succeeded",
        error: null,
        result: { availability: "available", files: [{ url: "https://cdn.example/out.png", media_type: "image/png", width: 1024, height: 1024 }] },
      });
    }
    if (url === "https://cdn.example/out.png") {
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (method === "POST" && url === `${BASE}/v1/files`) {
      const body = jsonBody(init) as { files?: Array<{ name?: string; size?: number; media_type?: string }> } | undefined;
      const files = (body?.files ?? [{}]).map((file, i) => ({
        id: `file_11111111-1111-4111-8111-11111111111${i}`,
        object: "file",
        status: "pending_upload",
        name: file.name ?? "ref.png",
        media_type: file.media_type ?? "image/png",
        size: file.size ?? 1,
        upload: {
          type: "multipart",
          expires_at: 1_790_000_900,
          parts: [{ part_number: 1, size: file.size ?? 1, url: "https://upload.example/part" }],
        },
      }));
      return Response.json({ files });
    }
    if (method === "PUT" && url === "https://upload.example/part") {
      if (opts?.failUpload) return new Response("no", { status: 500 });
      assert.equal(headers.get("authorization"), null);
      return new Response(null, { status: 200 });
    }
    if (url.includes("/v1/files/") && url.endsWith("/complete")) {
      return Response.json({
        id: "file_11111111-1111-4111-8111-111111111110",
        object: "file",
        status: "processing",
        name: "ref.png",
        media_type: "image/png",
        size: 1,
      });
    }
    if (url.includes("/v1/files/file_")) {
      return Response.json({
        id: "file_11111111-1111-4111-8111-111111111110",
        object: "file",
        status: "ready",
        name: "ref.png",
        media_type: "image/png",
        size: 1,
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch: fetch as never, seen };
}

test("yir default base url is the official gateway", () => {
  assert.equal(PROVIDER_DEFAULT_BASE_URLS.yir, "https://gateway.yir.ai");
});

test("yir wire model is bytedance/seedream-5.5 unless aliased", () => {
  assert.equal(yirImageWireModel(SEEDREAM_55_MODEL, undefined), "bytedance/seedream-5.5");
  assert.equal(yirImageWireModel(SEEDREAM_55_MODEL, "custom-5.5"), "custom-5.5");
});

test("seedream-5.5 aliases fold to the lumen id", () => {
  assert.equal(canonicalModel("seedream-5.5"), SEEDREAM_55_MODEL);
  assert.equal(canonicalModel("seedream-5-5"), SEEDREAM_55_MODEL);
  assert.equal(canonicalModel("bytedance/seedream-5.5"), SEEDREAM_55_MODEL);
});

test("seedream-5.5 accepts yir and volcark, and yir stays the listed default", () => {
  assert.doesNotThrow(() => assertProviderServes("yir", SEEDREAM_55_MODEL));
  assert.doesNotThrow(() => assertProviderServes("volcark", SEEDREAM_55_MODEL));
  assert.throws(() => assertProviderServes("beeftv", SEEDREAM_55_MODEL), /cannot serve/);
  assert.throws(() => assertProviderServes("yir", SEEDREAM_PRO_MODEL), /cannot serve/);
  assert.deepEqual(modelInfo(SEEDREAM_55_MODEL)?.providers, ["yir", "volcark"]);
});

test("yir job statuses: succeeded ends ok; failed and cancelled fail; others pending", () => {
  for (const s of ["queued", "running", "delivering", "unknown", ""]) assert.equal(yirTaskState({ status: s }), "pending", s);
  assert.equal(yirTaskState({ status: "succeeded" }), "ok");
  for (const s of ["failed", "cancelled"]) assert.equal(yirTaskState({ status: s }), "fail");
});

test("seedream-5.5 validation: 1K/2K only, auto becomes 1:1, no background, no 1.5K", () => {
  const base = { modelId: "seedream-5-5", prompt: "一只杯子", references: [] as string[] };
  const auto = validateImage({ ...base, aspectRatio: "auto", resolution: "2K", background: undefined, quality: undefined });
  assert.equal(auto.aspectRatio, "1:1");
  assert.equal(auto.resolution, "2K");
  assert.equal(auto.modelId, SEEDREAM_55_MODEL);
  const oneK = validateImage({ ...base, aspectRatio: "16:9", resolution: "1K", background: undefined, quality: undefined });
  assert.equal(oneK.resolution, "1K");
  assert.throws(
    () => validateImage({ ...base, aspectRatio: "1:1", resolution: "1.5K", background: undefined, quality: undefined }),
    /resolution/,
  );
  assert.throws(
    () => validateImage({ ...base, aspectRatio: "9:21", resolution: "2K", background: undefined, quality: undefined }),
    /aspect-ratio/,
  );
  assert.throws(
    () => validateImage({ ...base, aspectRatio: "1:1", resolution: "2K", background: "transparent", quality: undefined }),
    /does not take --background/,
  );
  assert.throws(
    () => validateImage({ ...base, aspectRatio: "1:1", resolution: "2K", background: undefined, quality: "high" }),
    /does not take --quality/,
  );
});

test("yir price table uses sourced APIMart USD amounts", () => {
  const twoK = seedreamCost({ modelId: SEEDREAM_55_MODEL, resolution: "2K", provider: "yir" });
  assert.equal(twoK.usd, 0.028);
  assert.equal(twoK.yuan, undefined);
  assert.equal(twoK.text, "estimate: $0.0280 (seedream-5.5 yir APIMart 2K, 1 image)");
  const oneK = seedreamCost({ modelId: SEEDREAM_55_MODEL, resolution: "1K", provider: "yir", references: 2 });
  assert.equal(oneK.usd, 0.0182);
  assert.match(oneK.text, /\$0\.0182/);
  assert.match(oneK.text, /2 refs extra, amount unpublished/);
});

test("yir providers set uses the official default base url", async () => {
  await withDir(async (dir) => {
    const set = capture(isolatedEnv(dir));
    assert.equal(
      await run(["providers", "set", "seedream-5.5", "--provider", "yir", "--api-key-env", "YIR_API_KEY", "--project", dir], set.io),
      0,
      set.err(),
    );
    assert.match(set.out(), /https:\/\/gateway\.yir\.ai \(default\)/);
  });
});

test("omitted seedream-5.5 resolution is 2K and auto aspect becomes 1:1; dry-run posts the Standard body", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(["gen", "image", "--model", "seedream-5-5", "--prompt", "一只杯子", "--project", dir], cap.io),
      0,
      cap.err(),
    );
    assert.match(cap.out(), /estimate: \$0\.0280 \(seedream-5\.5 yir APIMart 2K, 1 image\)/);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ url: string; headers?: Record<string, string>; body: { value?: Record<string, unknown> } }>;
    };
    const call = record.calls[0];
    assert.equal(call?.url, `${BASE}/v1/images/generations`);
    assert.ok(call?.headers?.["Idempotency-Key"]);
    const body = call?.body.value;
    assert.equal(body?.model, "bytedance/seedream-5.5");
    assert.deepEqual(body?.input, { type: "text", prompt: "一只杯子" });
    assert.deepEqual(body?.parameters, { resolution: "2K", aspect_ratio: "1:1", n: 1 });
  });
});

test("yir https refs skip upload; modelAlias overrides the wire id; data URIs are rejected", async () => {
  await withDir(async (dir) => {
    await bind(dir, ["--model-alias", "custom-5.5"]);
    const cap = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_55_MODEL, "--prompt", "改这张图", "--ref", "https://cdn.example/a.png", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      calls: Array<{ url: string; body: { value?: { model?: string; input?: { type?: string; references?: unknown } } } }>;
    };
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0]?.body.value?.model, "custom-5.5");
    assert.equal(record.calls[0]?.body.value?.input?.type, "image");
    assert.deepEqual(record.calls[0]?.body.value?.input?.references, [
      { role: "reference_image", url: "https://cdn.example/a.png" },
    ]);

    const bad = capture(isolatedEnv(dir));
    assert.equal(
      await run(
        ["gen", "image", "--model", SEEDREAM_55_MODEL, "--prompt", "x", "--ref", "data:image/png;base64,aaaa", "--project", dir],
        bad.io,
      ),
      1,
    );
    assert.match(bad.err(), /data URIs are not accepted/);
  });
});

test("yir execute: submits Standard job, polls status, fetches the job, downloads the file", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeYir({ statuses: ["queued", "running", "succeeded"] });
    const cap = capture(isolatedEnv(dir, { YIR_API_KEY: "secret-yir", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(await run([...imageArgs(dir), "--execute"], cap.io), 0, cap.err());
    const bytes = await readFile(path.join(dir, "out/t.png"));
    assert.deepEqual([...bytes], [...PNG]);
    const submit = f.seen.find((item) => item.url.endsWith("/v1/images/generations"));
    assert.equal(submit?.auth, "Bearer secret-yir");
    assert.ok(submit?.idem);
    assert.equal((submit?.body as { model?: string })?.model, "bytedance/seedream-5.5");
    assert.ok(f.seen.some((item) => item.url === `${BASE}/v1/jobs/job_1/status`));
    assert.ok(f.seen.some((item) => item.url === `${BASE}/v1/jobs/job_1`));
    const download = f.seen.find((item) => item.url === "https://cdn.example/out.png");
    assert.equal(download?.auth, null);
    assert.match(cap.out(), /\$0\.0280/);
  });
});

test("yir local jpeg/png/webp uploads then the file_id is the reference", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const local = path.join(dir, "refs/cup.png");
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, PNG);
    const f = fakeYir();
    const cap = capture(isolatedEnv(dir, { YIR_API_KEY: "k", SEEDANCE_POLL_MS: "0" }), { fetch: f.fetch, cwd: dir });
    assert.equal(
      await run([...imageArgs(dir), "--ref", "refs/cup.png", "--execute"], cap.io),
      0,
      cap.err(),
    );
    const create = f.seen.find((item) => item.method === "POST" && item.url === `${BASE}/v1/files`);
    assert.ok(create?.idem);
    const files = (create?.body as { files?: Array<{ name?: string; media_type?: string; size?: number }> })?.files;
    assert.equal(files?.[0]?.name, "cup.png");
    assert.equal(files?.[0]?.media_type, "image/png");
    assert.equal(files?.[0]?.size, PNG.byteLength);
    const put = f.seen.find((item) => item.url === "https://upload.example/part");
    assert.equal(put?.auth, null);
    const submit = f.seen.find((item) => item.url.endsWith("/v1/images/generations"));
    assert.deepEqual((submit?.body as { input?: { references?: unknown } })?.input?.references, [
      { role: "reference_image", file_id: "file_11111111-1111-4111-8111-111111111110" },
    ]);
  });
});

test("yir dry-run with a local ref plans the Files API upload and does not send", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const local = path.join(dir, "refs/cup.png");
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, PNG);
    const seen: string[] = [];
    const cap = capture(isolatedEnv(dir), {
      fetch: (async (url: string) => {
        seen.push(url);
        throw new Error("should not send");
      }) as never,
      cwd: dir,
    });
    assert.equal(await run([...imageArgs(dir), "--ref", "refs/cup.png"], cap.io), 0, cap.err());
    assert.equal(seen.length, 0);
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    const record = JSON.parse(await readFile(path.join(dir, ".lumen/runs", id, "record.json"), "utf8")) as {
      response?: { plannedUploads?: Array<{ name?: string }> };
      calls: Array<{ url: string }>;
    };
    assert.equal(record.response?.plannedUploads?.[0]?.name, "cup.png");
    assert.ok(record.calls.some((call) => call.url === `${BASE}/v1/files`));
    assert.ok(record.calls.some((call) => call.url === `${BASE}/v1/images/generations`));
  });
});

test("yir poll timeout leaves the run running and runs resume finishes it", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const f = fakeYir({ statuses: ["queued"] });
    const cap = capture(isolatedEnv(dir, { YIR_API_KEY: "k", SEEDANCE_POLL_MS: "0", SEEDANCE_MAX_POLLS: "2" }), {
      fetch: f.fetch,
      cwd: dir,
    });
    assert.equal(await run([...imageArgs(dir), "--execute"], cap.io), 0, cap.err());
    assert.match(cap.out(), /^running seedream-5\.5/m);
    const id = /run: (\S+)/.exec(cap.out())![1]!;
    const later = fakeYir({ statuses: ["succeeded"] });
    const res = capture(isolatedEnv(dir, { YIR_API_KEY: "k", SEEDANCE_POLL_MS: "0" }), { fetch: later.fetch, cwd: dir });
    assert.equal(await run(["runs", "resume", id, "--project", dir], res.io), 0, res.err());
    assert.match(res.out(), /wrote: .*t\.png/);
    assert.deepEqual([...(await readFile(path.join(dir, "out/t.png")))], [...PNG]);
    assert.equal(later.seen[0]?.url, `${BASE}/v1/jobs/job_1/status`);
  });
});
