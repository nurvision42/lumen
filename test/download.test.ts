import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BREAKDOWN_DEFAULT_PROMPT } from "../src/catalog.js";
import { downloadDouyinVideo, isDouyinUrl } from "../src/download/douyin.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const SHARE = "https://v.douyin.com/clip/";
const CDN = "https://cdn.example/original.mp4";
const BYTES = Buffer.from("mp4-bytes");

function secret(): string {
  return randomBytes(24).toString("hex");
}

function homeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env.PATH ?? "", ...extra };
}

type Seen = { url: string; authorization?: string; userAgent?: string };

function scriptedFetch(body: unknown, bytes: Uint8Array = BYTES, status = 200): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  seen: () => readonly Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen: () => seen,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: input,
        ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization") ?? undefined }),
        ...(headers.get("user-agent") === null ? {} : { userAgent: headers.get("user-agent") ?? undefined }),
      });
      if (input.includes("api.tikhub.io")) {
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });
    },
  };
}

function payload(fileSize = BYTES.length, asString = false): { code: number; data: unknown } {
  const data = {
    original_video_url: CDN,
    video_id: "vid-1",
    content_type: "video/mp4",
    file_size: fileSize,
  };
  return { code: 200, data: asString ? JSON.stringify(data) : data };
}

async function tree(dir: string): Promise<string> {
  let text = "";
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const full = path.join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else text += `\n${full}\n${await readFile(full, "utf8")}`;
    }
  };
  await walk(dir);
  return text;
}

test("douyin hosts are accepted and other sites are not", () => {
  assert.equal(isDouyinUrl("https://v.douyin.com/abc"), true);
  assert.equal(isDouyinUrl("https://www.douyin.com/video/1"), true);
  assert.equal(isDouyinUrl("http://douyin.com/video/1"), true);
  assert.equal(isDouyinUrl("https://example.com/video/1"), false);
  assert.equal(isDouyinUrl("https://douyin.com.example/video/1"), false);
  assert.equal(isDouyinUrl("ftp://v.douyin.com/abc"), false);
  assert.equal(isDouyinUrl("not a url"), false);
});

test("download names the setup command when no key is configured", async () => {
  await withDir(async (dir) => {
    const project = path.join(dir, "project");
    const home = path.join(dir, "home");
    await mkdir(project);
    let called = false;
    const cap = capture(homeEnv(home), {
      fetch: async () => {
        called = true;
        throw new Error("missing key must not fetch");
      },
    });
    assert.equal(await run(["download", SHARE, "--to", "refs/source.mp4", "--project", project], cap.io), 1);
    assert.match(cap.err(), /lumen setup --key tikhub/);
    assert.match(cap.err(), /TIKHUB_API_KEY/);
    assert.equal(called, false);
    await assert.rejects(access(path.join(home, ".config", "lumen", "credentials", "tikhub.api")));
    await assert.rejects(access(path.join(project, "refs", "source.mp4")));
  });
});

test("setup stores the key outside the project and does not print it", async () => {
  await withDir(async (dir) => {
    const project = path.join(dir, "project");
    const home = path.join(dir, "home");
    await mkdir(project);
    const value = secret();
    const cap = capture(homeEnv(home), { readLine: async () => `${value}\n` });
    assert.equal(await run(["setup", "--key", "tikhub", "--project", project], cap.io), 0, cap.err());
    const file = path.join(home, ".config", "lumen", "credentials", "tikhub.api");
    assert.equal(await readFile(file, "utf8"), `${value}\n`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal(file.startsWith(project), false);
    assert.equal(cap.out().includes(value), false);
    assert.equal(cap.err().includes(value), false);
    assert.match(cap.out(), /saved tikhub\.api/);
    assert.equal((await tree(project)).includes(value), false);
    const doctor = capture(homeEnv(home));
    assert.equal(await run(["doctor", "--project", project], doctor.io), 0, doctor.err());
    assert.match(doctor.out(), /tikhub key: present/);
    assert.equal(doctor.out().includes(value), false);
    assert.equal(doctor.err().includes(value), false);
  });
});

test("setup rejects a command-line secret without echoing it", async () => {
  await withDir(async (dir) => {
    const value = secret();
    const home = path.join(dir, "home");
    const extra = capture(homeEnv(home));
    assert.equal(await run(["setup", "--key", "tikhub", value], extra.io), 2);
    assert.match(extra.err(), /does not take a key on the command line/);
    assert.equal(extra.err().includes(value), false);
    assert.equal(extra.out().includes(value), false);
    const inline = capture(homeEnv(home));
    assert.equal(await run(["download", SHARE, "--to", "refs/a.mp4", "--api-key", value, "--project", dir], inline.io), 2);
    assert.match(inline.err(), /unknown option: --api-key/);
    assert.equal(inline.err().includes(value), false);
    const missing = capture(homeEnv(home));
    assert.equal(await run(["setup"], missing.io), 2);
    assert.match(missing.err(), /lumen setup needs --key tikhub/);
    const unknown = capture(homeEnv(home));
    assert.equal(await run(["setup", "--key", "other"], unknown.io), 2);
    assert.match(unknown.err(), /unknown setup key other/);
    const empty = capture(homeEnv(home), { readLine: async () => "  " });
    assert.equal(await run(["setup", "--key", "tikhub"], empty.io), 1);
    assert.match(empty.err(), /TikHub API key is required/);
    const tty = capture(homeEnv(home));
    assert.equal(await run(["setup", "--key", "tikhub"], tty.io), 1);
    assert.match(tty.err(), /needs a terminal, or set TIKHUB_API_KEY/);
  });
});

test("download uses the credential store, then the env var, and keeps the key out of output", async () => {
  await withDir(async (dir) => {
    const project = path.join(dir, "project");
    const home = path.join(dir, "home");
    await mkdir(project);
    const stored = secret();
    const fromEnv = secret();
    const setup = capture(homeEnv(home), { readLine: async () => stored });
    assert.equal(await run(["setup", "--key", "tikhub"], setup.io), 0, setup.err());

    const viaStore = scriptedFetch(payload());
    const saved = capture(homeEnv(home, { TIKHUB_API_KEY: fromEnv }), { fetch: viaStore.fetch });
    assert.equal(await run(["download", SHARE, "--to", "refs/source.mp4", "--project", project], saved.io), 0, saved.err());
    const target = path.join(project, "refs", "source.mp4");
    assert.equal(await readFile(target, "utf8"), BYTES.toString());
    assert.match(saved.out(), new RegExp(`已保存到 ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(saved.out().includes(stored), false);
    assert.equal(saved.out().includes(fromEnv), false);
    assert.equal(saved.out().includes(CDN), false);
    assert.equal(saved.err().includes(stored), false);
    assert.equal((await tree(project)).includes(stored), false);
    assert.equal((await tree(project)).includes(fromEnv), false);
    await assert.rejects(access(path.join(project, ".lumen")));
    const calls = viaStore.seen();
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /api\.tikhub\.io/);
    assert.match(calls[0]?.url ?? "", /share_url=/);
    assert.match(calls[0]?.url ?? "", /v\.douyin\.com/);
    assert.match(calls[0]?.url ?? "", /region=CN/);
    assert.equal(calls[0]?.authorization, `Bearer ${stored}`);
    assert.equal(calls[1]?.url, CDN);
    assert.equal(calls[1]?.userAgent, "lumen-douyin-downloader/1.0");
    assert.equal(calls[1]?.authorization, undefined);

    const xdg = path.join(dir, "xdg");
    const envOnly = scriptedFetch(payload(BYTES.length, true));
    const json = capture(homeEnv(home, { XDG_CONFIG_HOME: xdg, TIKHUB_API_KEY: fromEnv }), { fetch: envOnly.fetch });
    assert.equal(
      await run(["download", SHARE, "--to", "refs/from-env.mp4", "--region", "US", "--json", "--project", project], json.io),
      0,
      json.err(),
    );
    const parsed = JSON.parse(json.out()) as { format: string; path: string; url: string; videoId: string; fileSize: number; originalVideoUrl?: string };
    assert.equal(parsed.format, "lumen.cli-download@1");
    assert.equal(parsed.path, path.join(project, "refs", "from-env.mp4"));
    assert.equal(parsed.url, SHARE);
    assert.equal(parsed.videoId, "vid-1");
    assert.equal(parsed.fileSize, BYTES.length);
    assert.equal(parsed.originalVideoUrl, undefined);
    assert.equal(json.out().includes(fromEnv), false);
    assert.equal(json.out().includes(CDN), false);
    assert.equal(envOnly.seen()[0]?.authorization, `Bearer ${fromEnv}`);
    assert.match(envOnly.seen()[0]?.url ?? "", /region=US/);
    await assert.rejects(access(path.join(xdg, "lumen", "credentials", "tikhub.api")));
  });
});

test("a size mismatch deletes the file and an existing file is not overwritten", async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, "clip.mp4");
    const value = secret();
    const mismatch = scriptedFetch(payload(99));
    await assert.rejects(
      downloadDouyinVideo(SHARE, target, { apiKey: value, fetchImpl: mismatch.fetch }),
      /download size mismatch/,
    );
    await assert.rejects(access(target));
    assert.equal(JSON.stringify(mismatch.seen()).includes(value), true);
    const again = scriptedFetch(payload());
    const info = await downloadDouyinVideo(SHARE, target, { apiKey: value, fetchImpl: again.fetch });
    assert.equal(info.fileSize, BYTES.length);
    await assert.rejects(
      downloadDouyinVideo(SHARE, target, { apiKey: value, fetchImpl: again.fetch }),
      /refused to overwrite/,
    );
    assert.equal(await readFile(target, "utf8"), BYTES.toString());
  });
});

test("a saved douyin file is a breakdown video and the lookup key stays out of the run", async () => {
  await withDir(async (dir) => {
    const project = path.join(dir, "project");
    const home = path.join(dir, "home");
    await mkdir(project);
    const value = secret();
    const media = scriptedFetch(payload());
    const saved = capture(homeEnv(home, { TIKHUB_API_KEY: value }), { fetch: media.fetch });
    assert.equal(await run(["download", SHARE, "--to", "refs/source.mp4", "--project", project], saved.io), 0, saved.err());
    const bind = capture(homeEnv(home));
    assert.equal(
      await run(
        ["providers", "set", "video-understand-router", "--provider", "mediakit", "--base-url", "https://mediakit.example", "--api-key-env", "MEDIAKIT_UNDERSTAND_KEY", "--project", project],
        bind.io,
      ),
      0,
      bind.err(),
    );
    const understand = secret();
    let called = false;
    const breakdown = capture(homeEnv(home, { TIKHUB_API_KEY: value, MEDIAKIT_UNDERSTAND_KEY: understand }), {
      fetch: async () => {
        called = true;
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["breakdown", "--video", "refs/source.mp4", "--project", project], breakdown.io), 0, breakdown.err());
    assert.equal(called, false);
    const names = await readdir(path.join(project, ".lumen", "runs"));
    const record = JSON.parse(await readFile(path.join(project, ".lumen", "runs", names[0] ?? "", "record.json"), "utf8")) as {
      params: { video: string; prompt: string };
    };
    assert.equal(record.params.video, path.join(project, "refs", "source.mp4"));
    assert.equal(record.params.prompt, BREAKDOWN_DEFAULT_PROMPT);
    const dumped = await tree(project);
    assert.equal(dumped.includes(value), false);
    assert.equal(dumped.includes(understand), false);
    assert.equal(breakdown.out().includes(value), false);
  });
});

test("other sites are refused before any lookup", async () => {
  await withDir(async (dir) => {
    let called = false;
    const cap = capture(homeEnv(dir), {
      fetch: async () => {
        called = true;
        throw new Error("other sites must not fetch");
      },
    });
    assert.equal(await run(["download", "https://example.com/watch", "--to", "refs/a.mp4", "--project", dir], cap.io), 1);
    assert.match(cap.err(), /douyin\.com links only/);
    assert.equal(called, false);
    const usage = capture(homeEnv(dir));
    assert.equal(await run(["download", SHARE, "--project", dir], usage.io), 2);
    assert.match(usage.err(), /requires --to/);
  });
});
