import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { helpText } from "../src/help.js";
import type { IO } from "../src/io.js";
import { run } from "../src/run.js";
import { pidAlive, readRunRecord, writeRun, type RunRecord } from "../src/runs.js";
import { capture, withDir } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function env(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(dir, "home"),
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
    LUMEN_NO_SKILL_AUTOINSTALL: "1",
    SEEDANCE_POLL_MS: "0",
    SEEDANCE_MAX_POLLS: "2",
    MEDIAKIT_POLL_MS: "0",
    MEDIAKIT_MAX_POLLS: "2",
    ...extra,
  };
}

async function bind(dir: string, model: string, provider: string, base: string, keyEnv: string): Promise<void> {
  const cap = capture(env(dir));
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", keyEnv, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

function baseRecord(patch: Partial<RunRecord> & Pick<RunRecord, "id" | "status" | "modelId">): RunRecord {
  return {
    time: "2026-11-01T00:00:00.000Z",
    command: ["gen", "image", "--model", patch.modelId, "--execute"],
    mode: "execute",
    binding: { provider: "grsai", baseUrl: "https://grsai.example", apiKeyEnv: "GRSAI", keyPresent: true },
    params: { prompt: "一只猫" },
    calls: [],
    response: null,
    outputs: [],
    ...patch,
  };
}

function procIds(pid: number): { ppid: number; sid: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2);
  const fields = rest.split(" ");
  return { ppid: Number(fields[1]), sid: Number(fields[3]) };
}

async function until(fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting");
}

test("help describes detach, wait exit codes, and the assistant loop in Chinese", () => {
  const text = helpText("0.1.21");
  assert.match(text, /--detach --execute/);
  assert.match(text, /lumen runs wait <id> --timeout 60/);
  assert.match(text, /退出码：0 完成/);
  assert.match(text, /3 仍在生成/);
  assert.match(text, /lumen runs list --pending/);
  assert.match(text, /不要重新提交/);
  assert.match(text, /不要用 nohup/);
  assert.match(text, /npm postinstall installs that directory/);
});

test("--detach without --execute is a usage error", async () => {
  await withDir(async (dir) => {
    await bind(dir, "gpt-image-2", "grsai", "https://grsai.example", "GRSAI");
    const cap = capture(env(dir));
    assert.equal(
      await run(["gen", "image", "--model", "gpt-image-2", "--prompt", "一只猫", "--detach", "--project", dir], cap.io),
      2,
    );
    assert.match(cap.err(), /--detach 需要 --execute/);
  });
});

test("mock --detach child survives the parent and is a new session", { timeout: 30_000 }, async () => {
  await withDir(async (dir) => {
    await bind(dir, "gpt-image-2", "grsai", "https://grsai.example", "GRSAI");
    const parent = spawn(
      process.execPath,
      [cli, "gen", "image", "--model", "gpt-image-2", "--prompt", "一只猫", "--mock", "--detach", "--project", dir],
      { env: env(dir, { LUMEN_DETACH_HOLD_MS: "2000" }), cwd: dir },
    );
    let out = "";
    let err = "";
    parent.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    parent.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    const [code] = (await once(parent, "exit")) as [number | null];
    assert.equal(code, 0, err + out);
    const id = /run: (\S+)/.exec(out)?.[1];
    assert.ok(id);
    assert.match(out, new RegExp(`下一步: lumen runs wait ${id}`));
    const record = await readRunRecord(dir, id);
    assert.equal(record.status, "pending");
    assert.equal(typeof record.worker?.pid, "number");
    const pid = record.worker?.pid ?? 0;
    assert.equal(pidAlive(pid), true);
    const ids = procIds(pid);
    assert.notEqual(ids.ppid, parent.pid);
    assert.equal(ids.sid, pid);

    const waiting = capture(env(dir));
    assert.equal(await run(["runs", "wait", id, "--timeout", "0", "--project", dir], waiting.io), 3);
    assert.match(waiting.out(), /仍在生成/);
    assert.equal(pidAlive(pid), true);
    assert.equal((await readRunRecord(dir, id)).status, "pending");

    await until(async () => (await readRunRecord(dir, id)).status === "mock");
    const log = await readFile(path.join(dir, ".lumen", "runs", id, "worker.log"), "utf8");
    assert.match(log, /mock gpt-image-2/);
    const done = capture(env(dir));
    assert.equal(await run(["runs", "wait", id, "--timeout", "5", "--project", dir], done.io), 0, done.err());
    assert.match(done.out(), new RegExp(`run: ${id}`));
    const pending = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], pending.io), 0);
    assert.equal(pending.out().includes(id), false);
  });
});

test("execute --detach submits once and wait prints wrote", async () => {
  await withDir(async (dir) => {
    await bind(dir, "gpt-image-2", "grsai", "https://grsai.example", "GRSAI");
    const calls: string[] = [];
    const cap = capture(env(dir, { GRSAI: "grsai-key-value" }), { cwd: dir });
    let childOut = "";
    cap.io.spawnDetached = (spec) => {
      const child: IO = {
        stdout: (chunk) => {
          childOut += chunk;
        },
        stderr: (chunk) => {
          childOut += chunk;
        },
        cwd: spec.cwd,
        env: spec.env,
        fetch: cap.io.fetch,
      };
      void run(spec.args, child).then(
        (exitCode) => {
          childOut += `\nexit ${exitCode}\n`;
        },
        (err: unknown) => {
          childOut += `\n${err instanceof Error ? err.message : String(err)}\n`;
        },
      );
      return { pid: process.pid };
    };
    cap.io.fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST") return Response.json({ data: [{ url: "https://cdn.example/pic.png" }] });
      if (url === "https://cdn.example/pic.png") {
        return new Response(Uint8Array.from([9, 8, 7]), { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "一只猫", "--out", "out/pic.png", "--execute", "--detach", "--project", dir],
        cap.io,
      ),
      0,
      cap.err(),
    );
    const id = /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id, cap.out());
    assert.match(cap.out(), new RegExp(`下一步: lumen runs wait ${id}`));
    assert.equal(cap.out().includes("wrote:"), false);
    await until(async () => {
      const record = await readRunRecord(dir, id);
      return record.status === "ok" || record.status === "error";
    });
    const finished = await readRunRecord(dir, id);
    assert.equal(finished.status, "ok", childOut);
    assert.equal(calls.filter((call) => call.startsWith("POST ")).length, 1, calls.join("\n"));
    const listed = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], listed.io), 0);
    assert.match(listed.out(), new RegExp(`${id}\\s+ok\\s+gpt-image-2\\s+${finished.time}`));
    const waited = capture(env(dir), {
      fetch: async () => {
        throw new Error("wait must not fetch");
      },
    });
    assert.equal(await run(["runs", "wait", id, "--timeout", "5", "--project", dir], waited.io), 0, waited.err());
    assert.match(waited.out(), /wrote: .*out\/pic\.png/);
    assert.deepEqual([...(await readFile(path.join(dir, "out", "pic.png")))], [9, 8, 7]);
    const after = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], after.io), 0);
    assert.equal(after.out().includes(id), false);
    const shown = capture(env(dir));
    assert.equal(await run(["runs", "show", id, "--project", dir], shown.io), 0);
    assert.match(shown.out(), /已取走/);
  });
});

test("video and enhance --detach do not submit in the parent", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2", "haomao", "https://h.example/api/v3", "HK");
    await bind(dir, "enhance-video-generative", "mediakit", "https://m.example", "MK");
    const posts: string[] = [];
    const cap = capture(env(dir, { HK: "haomao-key-value", MK: "mediakit-key-value" }), { cwd: dir });
    let childOut = "";
    cap.io.fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      const target = String(url);
      if (method === "POST") posts.push(target);
      if (method === "POST" && target.endsWith("/contents/generations/tasks")) {
        return Response.json({ id: "cgt-1", status: "queued" });
      }
      if (method === "GET" && target.endsWith("/contents/generations/tasks/cgt-1")) {
        return Response.json({ id: "cgt-1", status: "succeeded", content: { video_url: "https://cdn.example/v.mp4" } });
      }
      if (target === "https://cdn.example/v.mp4") return new Response(Uint8Array.from([1, 2]), { headers: { "content-type": "video/mp4" } });
      if (method === "POST" && target.endsWith("/enhance-video-generative")) {
        return Response.json({ success: true, status: "completed", task_id: "task-mk", result: { video_url: "mediakit://clip" } });
      }
      throw new Error(`unexpected ${method} ${target}`);
    };
    cap.io.spawnDetached = (spec) => {
      const child: IO = {
        stdout: (chunk) => {
          childOut += chunk;
        },
        stderr: (chunk) => {
          childOut += chunk;
        },
        cwd: spec.cwd,
        env: spec.env,
        fetch: cap.io.fetch,
      };
      void run(spec.args, child).then(
        (exitCode) => {
          childOut += `\nexit ${exitCode}\n`;
        },
        (err: unknown) => {
          childOut += `\n${err instanceof Error ? err.message : String(err)}\n`;
        },
      );
      return { pid: process.pid };
    };
    const video = capture(env(dir, { HK: "haomao-key-value" }), { cwd: dir, fetch: cap.io.fetch, spawnDetached: cap.io.spawnDetached });
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "一只猫走路",
          "--duration", "5", "--aspect-ratio", "16:9", "--resolution", "720p",
          "--out", "out/v.mp4", "--execute", "--detach", "--project", dir,
        ],
        video.io,
      ),
      0,
      video.err(),
    );
    const videoId = /run: (\S+)/.exec(video.out())?.[1];
    assert.ok(videoId);
    await until(async () => {
      const record = await readRunRecord(dir, videoId);
      return record.status === "ok" || record.status === "error";
    });
    assert.equal((await readRunRecord(dir, videoId)).status, "ok", childOut);
    const enhance = capture(env(dir, { MK: "mediakit-key-value" }), { cwd: dir, fetch: cap.io.fetch, spawnDetached: cap.io.spawnDetached });
    assert.equal(
      await run(["enhance", "--video", "https://cdn.example/in.mp4", "--execute", "--detach", "--project", dir], enhance.io),
      0,
      enhance.err(),
    );
    assert.match(enhance.out(), /10 yuan/);
    const enhanceId = /run: (\S+)/.exec(enhance.out())?.[1];
    assert.ok(enhanceId);
    await until(async () => {
      const record = await readRunRecord(dir, enhanceId);
      return record.status === "ok" || record.status === "error";
    });
    assert.equal((await readRunRecord(dir, enhanceId)).status, "ok", childOut);
    assert.equal(posts.length, 2, posts.join("\n") + childOut);
  });
});

test("wait exit codes for timeout, failure, and success", async () => {
  await withDir(async (dir) => {
    const running = baseRecord({
      id: "20261101T000000Z-aa01",
      status: "pending",
      modelId: "gpt-image-2",
      worker: { pid: process.pid },
    });
    const failed = baseRecord({
      id: "20261101T000001Z-aa02",
      status: "error",
      modelId: "gpt-image-2",
      time: "2026-11-01T00:00:01.000Z",
      error: "上游拒绝",
    });
    const ok = baseRecord({
      id: "20261101T000002Z-aa03",
      status: "ok",
      modelId: "gpt-image-2",
      time: "2026-11-01T00:00:02.000Z",
      outputs: [path.join(dir, "out", "done.png")],
    });
    const dry = baseRecord({
      id: "20261101T000003Z-aa04",
      status: "dry-run",
      modelId: "gpt-image-2",
      time: "2026-11-01T00:00:03.000Z",
      mode: "dry-run",
    });
    const claimed = baseRecord({
      id: "20261101T000004Z-aa05",
      status: "ok",
      modelId: "seedance-2",
      time: "2026-11-01T00:00:04.000Z",
      claimed: true,
      claimedBy: "wait",
      claimedAt: "2026-11-01T00:00:05.000Z",
    });
    for (const record of [running, failed, ok, dry, claimed]) await writeRun(dir, record, []);

    const timeout = capture(env(dir), {
      fetch: async () => {
        throw new Error("wait must not fetch");
      },
    });
    assert.equal(await run(["runs", "wait", running.id, "--timeout", "0", "--project", dir], timeout.io), 3);
    assert.match(timeout.out(), /仍在生成/);
    assert.equal((await readRunRecord(dir, running.id)).claimed, undefined);

    const bad = capture(env(dir));
    assert.equal(await run(["runs", "wait", failed.id, "--project", dir], bad.io), 1);
    assert.match(bad.err(), /上游拒绝/);

    const good = capture(env(dir));
    assert.equal(await run(["runs", "wait", ok.id, "--project", dir], good.io), 0, good.err());
    assert.match(good.out(), new RegExp(`wrote: ${ok.outputs[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const pending = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], pending.io), 0);
    assert.match(pending.out(), new RegExp(`${running.id}\\s+pending\\s+gpt-image-2\\s+${running.time}`));
    assert.equal(pending.out().includes(failed.id), false);
    assert.equal(pending.out().includes(ok.id), false);
    assert.equal(pending.out().includes(dry.id), false);
    assert.equal(pending.out().includes(claimed.id), false);
  });
});

test("list --pending shows unfinished and unclaimed runs", async () => {
  await withDir(async (dir) => {
    const running = baseRecord({
      id: "20261101T000010Z-bb01",
      status: "running",
      modelId: "seedance-2",
      time: "2026-11-01T00:00:10.000Z",
    });
    const fresh = baseRecord({
      id: "20261101T000011Z-bb02",
      status: "ok",
      modelId: "gpt-image-2",
      time: "2026-11-01T00:00:11.000Z",
      outputs: ["out/a.png"],
    });
    const seen = baseRecord({
      id: "20261101T000012Z-bb03",
      status: "ok",
      modelId: "gpt-image-2",
      time: "2026-11-01T00:00:12.000Z",
      claimed: true,
    });
    for (const record of [running, fresh, seen]) await writeRun(dir, record, []);
    const cap = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], cap.io), 0);
    assert.match(cap.out(), /20261101T000010Z-bb01\s+running\s+seedance-2\s+2026-11-01T00:00:10.000Z/);
    assert.match(cap.out(), /20261101T000011Z-bb02\s+ok\s+gpt-image-2\s+2026-11-01T00:00:11.000Z/);
    assert.equal(cap.out().includes(seen.id), false);
    const all = capture(env(dir));
    assert.equal(await run(["runs", "list", "--project", dir], all.io), 0);
    assert.match(all.out(), new RegExp(`${seen.id}.*已取走`));
  });
});

test("interrupted image with no provider result cannot resume", async () => {
  await withDir(async (dir) => {
    const dead = await deadPid();
    const outFile = path.join(dir, "out", "missing.png");
    const record = baseRecord({
      id: "20261101T000020Z-cc01",
      status: "pending",
      modelId: "gpt-image-2",
      worker: { pid: dead },
      image: { provider: "grsai", outFile },
    });
    await writeRun(dir, record, []);
    const shown = capture(env(dir), {
      fetch: async () => {
        throw new Error("show must not fetch");
      },
    });
    assert.equal(await run(["runs", "show", record.id, "--project", dir], shown.io), 0, shown.err());
    assert.match(shown.out(), /已中断/);
    assert.match(shown.out(), /没有本地图像/);
    assert.match(shown.out(), /不能 resume/);
    assert.match(shown.out(), /不要重新提交/);
    const resumed = capture(env(dir), {
      fetch: async () => {
        throw new Error("resume must not fetch");
      },
    });
    assert.notEqual(await run(["runs", "resume", record.id, "--project", dir], resumed.io), 0);
    assert.match(resumed.err(), /不能 resume/);
    assert.match(resumed.err(), /不要重新提交/);
  });
});

test("interrupted image with a task id cannot be polled", async () => {
  await withDir(async (dir) => {
    const dead = await deadPid();
    const record = baseRecord({
      id: "20261101T000021Z-cc02",
      status: "running",
      modelId: "gpt-image-2",
      worker: { pid: dead },
      image: { provider: "grsai", outFile: path.join(dir, "out", "missing.png"), taskId: "img-task" },
    });
    await writeRun(dir, record, []);
    const shown = capture(env(dir));
    assert.equal(await run(["runs", "show", record.id, "--project", dir], shown.io), 0);
    assert.match(shown.out(), /已中断/);
    assert.match(shown.out(), /img-task/);
    assert.match(shown.out(), /不能续查/);
    const resumed = capture(env(dir), {
      fetch: async () => {
        throw new Error("resume must not fetch");
      },
    });
    assert.notEqual(await run(["runs", "resume", record.id, "--project", dir], resumed.io), 0);
    assert.match(resumed.err(), /不能续查/);
  });
});

test("interrupted image resume downloads the saved URL and does not submit", async () => {
  await withDir(async (dir) => {
    const dead = await deadPid();
    const id = "20261101T000022Z-cc03";
    const outFile = path.join(dir, "out", "back.png");
    const record = baseRecord({
      id,
      status: "pending",
      modelId: "gpt-image-2",
      worker: { pid: dead },
      image: { provider: "grsai", outFile, url: "https://cdn.example/pic.png?[redacted]", received: true },
    });
    await writeRun(dir, record, []);
    await writeFile(path.join(dir, ".lumen", "runs", id, "image-url.txt"), "https://cdn.example/pic.png\n");
    const shown = capture(env(dir));
    assert.equal(await run(["runs", "show", id, "--project", dir], shown.io), 0);
    assert.match(shown.out(), /已中断/);
    assert.match(shown.out(), /结果 URL/);
    assert.match(shown.out(), new RegExp(`lumen runs resume ${id}`));
    const calls: string[] = [];
    const resumed = capture(env(dir), {
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        assert.equal(method, "GET");
        assert.equal(url, "https://cdn.example/pic.png");
        return new Response(Uint8Array.from([4, 5, 6]), { headers: { "content-type": "image/png" } });
      },
    });
    assert.equal(await run(["runs", "resume", id, "--project", dir], resumed.io), 0, resumed.err());
    assert.match(resumed.out(), new RegExp(`wrote: ${outFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual([...(await readFile(outFile))], [4, 5, 6]);
    assert.deepEqual(calls, ["GET"]);
    assert.equal((await readRunRecord(dir, id)).status, "ok");
  });
});

test("foreground image keeps a result URL when download fails", async () => {
  await withDir(async (dir) => {
    await bind(dir, "gpt-image-2", "grsai", "https://grsai.example", "GRSAI");
    let posts = 0;
    const cap = capture(env(dir, { GRSAI: "grsai-key-value" }), {
      cwd: dir,
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          posts += 1;
          return Response.json({ data: [{ url: "https://cdn.example/kept.png" }] });
        }
        throw new Error(`download killed ${String(url)}`);
      },
    });
    assert.equal(
      await run(
        ["gen", "image", "--model", "gpt-image-2", "--prompt", "一只猫", "--out", "out/kept.png", "--execute", "--project", dir],
        cap.io,
      ),
      1,
    );
    const id = /run: (\S+)/.exec(cap.err())?.[1] ?? /run: (\S+)/.exec(cap.out())?.[1];
    assert.ok(id);
    assert.equal(posts, 1);
    const saved = await readFile(path.join(dir, ".lumen", "runs", id, "image-url.txt"), "utf8");
    assert.match(saved, /https:\/\/cdn\.example\/kept\.png/);
    const shown = capture(env(dir));
    assert.equal(await run(["runs", "show", id, "--project", dir], shown.io), 0);
    assert.match(shown.out(), /没有本地图像/);
    assert.match(shown.out(), /结果 URL/);
    assert.match(shown.out(), /不要重新提交/);
    const resumed = capture(env(dir), {
      fetch: async (url, init) => {
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(url, "https://cdn.example/kept.png");
        return new Response(Uint8Array.from([7]), { headers: { "content-type": "image/png" } });
      },
    });
    assert.equal(await run(["runs", "resume", id, "--project", dir], resumed.io), 0, resumed.err());
    assert.equal(posts, 1);
    assert.deepEqual([...(await readFile(path.join(dir, "out", "kept.png")))], [7]);
  });
});

test("resume --detach validates then spawns and does not poll while the worker is alive", async () => {
  await withDir(async (dir) => {
    const id = "20261101T000030Z-dd01";
    const record = baseRecord({
      id,
      status: "running",
      modelId: "seedance-2",
      binding: { provider: "haomao", baseUrl: "https://h.example/api/v3", apiKeyEnv: "HK", keyPresent: true },
      pending: {
        provider: "haomao",
        taskId: "cgt-9",
        lastStatus: "running",
        videoFile: path.join(dir, "out", "v.mp4"),
        receipt: path.join(dir, "out", "v.seedance.json"),
      },
      worker: { pid: await deadPid() },
    });
    await writeRun(dir, record, []);
    let spawned = 0;
    const cap = capture(env(dir, { HK: "haomao-key-value" }), {
      cwd: dir,
      fetch: async () => {
        throw new Error("parent resume must not fetch");
      },
    });
    cap.io.spawnDetached = () => {
      spawned += 1;
      return { pid: process.pid };
    };
    assert.equal(await run(["runs", "resume", id, "--execute", "--detach", "--project", dir], cap.io), 0, cap.err());
    assert.equal(spawned, 1);
    assert.match(cap.out(), new RegExp(`下一步: lumen runs wait ${id}`));
    const again = capture(env(dir, { HK: "haomao-key-value" }), {
      cwd: dir,
      fetch: async () => {
        throw new Error("second resume must not fetch");
      },
      spawnDetached: () => {
        spawned += 1;
        return { pid: process.pid };
      },
    });
    assert.equal(await run(["runs", "resume", id, "--execute", "--detach", "--project", dir], again.io), 0, again.err());
    assert.equal(spawned, 1);
    assert.match(again.out(), /仍在生成/);
    const usage = capture(env(dir));
    assert.equal(await run(["runs", "resume", id, "--detach", "--project", dir], usage.io), 2);
    assert.match(usage.err(), /--detach 需要 --execute/);
  });
});

test("runs list --pending is empty when nothing is waiting", async () => {
  await withDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    const cap = capture(env(dir));
    assert.equal(await run(["runs", "list", "--pending", "--project", dir], cap.io), 0);
    assert.match(cap.out(), /没有未取走的 run/);
  });
});
