import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PAUSE_GAP_SEC, segmentWords } from "../src/captions/words.js";
import { draftFromWords, wordsFromSeedResult } from "../src/clients/seedasr.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const fixturePath = path.join(root, "fixtures", "seed-asr-words.json");

interface FlatWord { text: string; start_s: number; end_s: number }

test("pause draft keeps the spoken phrases and splits real pauses", async () => {
  assert.equal(PAUSE_GAP_SEC, 0.2);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { words: FlatWord[] };
  const words = fixture.words.map((word) => ({ text: word.text, start: word.start_s, end: word.end_s }));
  const cues = segmentWords(words);
  const byText = new Map(cues.map((cue) => [cue.text, cue]));
  assert.deepEqual(byText.get("先倒一点这个"), { start: 1.65, end: 2.81, text: "先倒一点这个", wordFrom: 5, wordTo: 10 });
  assert.deepEqual(byText.get("加气泡水"), { start: 3.69, end: 4.73, text: "加气泡水", wordFrom: 11, wordTo: 14 });
  assert.equal(byText.has("先倒一点"), false);
  assert.equal(byText.has("这个"), false);
  assert.deepEqual(byText.get("搅一搅"), { start: 6.72, end: 7.28, text: "搅一搅", wordFrom: 15, wordTo: 17 });
  assert.deepEqual(byText.get("一杯就做好了"), { start: 7.64, end: 8.76, text: "一杯就做好了", wordFrom: 18, wordTo: 23 });
  assert.equal(cues.some((cue) => /[，。]/.test(cue.text)), false);

  const tight = segmentWords([
    { text: "加", start: 4.05, end: 4.09 },
    { text: "气", start: 4.09, end: 4.25 },
  ]);
  assert.equal(tight.length, 1);
  assert.equal(tight[0]?.text, "加气");

  const exact = segmentWords([
    { text: "甲", start: 0, end: 1 },
    { text: "乙", start: 1.2, end: 1.4 },
  ]);
  assert.equal(exact.length, 1);
  const over = segmentWords([
    { text: "甲", start: 1, end: 1.5 },
    { text: "乙", start: 1.2, end: 1.6 },
  ]);
  assert.equal(over.length, 1);
  assert.equal(over[0]?.text, "甲乙");
  assert.equal(over[0]?.start, 1);
  assert.equal(over[0]?.end, 1.6);

  const bare = segmentWords([
    { text: "先，", start: 0, end: 0.2 },
    { text: "。", start: 0.2, end: 0.25 },
    { text: "倒", start: 0.3, end: 0.5 },
  ]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0]?.text, "先倒");
});

test("a seed result without words is not turned into timed cues", () => {
  assert.deepEqual(wordsFromSeedResult({ result: { text: "只有整句，没有逐字。", utterances: [{ text: "只有整句，没有逐字。", start_time: 0, end_time: 1000 }] } }), []);
  assert.throws(
    () => draftFromWords({ words: [], duration: 2, video: "clip.mp4", taskId: "task-1", response: {} }),
    /no captions left|no word timings|Refusing/,
  );
});

test("seed-asr dry-run does not call the network", async () => {
  await withDir(async (dir) => {
    const bind = capture();
    assert.equal(
      await run(["providers", "set", "seed-asr", "--provider", "openspeech", "--api-key-env", "DOUBAO_SPEECH_API_KEY", "--project", dir], bind.io),
      0,
      bind.err(),
    );
    const cfgPath = path.join(dir, "lumen.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.tos = {};
    await writeFile(cfgPath, JSON.stringify(cfg));
    let called = false;
    const cap = capture({
      DOUBAO_SPEECH_API_KEY: "doubao-key-value",
      VOLC_ACCESSKEY: "AKIAtestaccess",
      VOLC_SECRETKEY: "secretvalue123",
    }, {
      fetch: async () => {
        called = true;
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["captions", "transcribe", "--video", "clip.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.equal(called, false);
    assert.match(cap.out(), /engine: seed-asr/);
    assert.match(cap.out(), /pauseGapSec: 0\.2/);
    const runName = (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "";
    const record = await readFile(path.join(dir, ".lumen", "runs", runName, "record.json"), "utf8");
    assert.match(record, /volc\.seedasr\.auc/);
    assert.match(record, /bigmodel/);
    assert.equal(record.includes("doubao-key-value"), false);
    assert.equal(record.includes("secretvalue123"), false);
    await assert.rejects(readFile(path.join(dir, "refs", "missing.captions.json")));
  });
});

test("seed-asr execute stores the task before polling and resume does not submit again", async () => {
  await withDir(async (dir) => {
    assert.equal(
      await run(["providers", "set", "seed-asr", "--provider", "openspeech", "--api-key-env", "DOUBAO_SPEECH_API_KEY", "--project", dir], capture().io),
      0,
    );
    const cfgPath = path.join(dir, "lumen.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.tos = {};
    await writeFile(cfgPath, JSON.stringify(cfg));
    const video = path.join(dir, "clip.mp4");
    await exec("/usr/bin/ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      video,
    ]);
    const env = {
      ...process.env,
      DOUBAO_SPEECH_API_KEY: "doubao-key-value",
      VOLC_ACCESSKEY: "AKIAtestaccess",
      VOLC_SECRETKEY: "secretvalue123",
      SEED_ASR_MAX_POLLS: "1",
      SEED_ASR_POLL_MS: "0",
    };
    let submits = 0;
    let queries = 0;
    const pending = capture(env, {
      fetch: async (url: string) => {
        if (url.includes("/auc/bigmodel/submit")) {
          submits += 1;
          return new Response(JSON.stringify({ task_id: "task-seed" }), {
            status: 200,
            headers: { "content-type": "application/json", "x-api-status-code": "20000000", "x-api-message": "OK" },
          });
        }
        if (url.includes("/auc/bigmodel/query")) {
          queries += 1;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "x-api-status-code": "20000001", "x-api-message": "Processing" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(await run(["captions", "transcribe", "--video", "clip.mp4", "--execute", "--to", "refs/draft.json", "--project", dir], pending.io), 0, pending.err());
    assert.equal(submits, 1);
    assert.equal(queries, 1);
    assert.match(pending.out(), /running seed-asr/);
    const runName = (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "";
    const saved = await readFile(path.join(dir, ".lumen", "runs", runName, "record.json"), "utf8");
    assert.equal(saved.includes("doubao-key-value"), false);
    assert.match(saved, /openspeech/);
    const done = capture(env, {
      fetch: async (url: string) => {
        if (url.includes("/auc/bigmodel/submit")) throw new Error("resume must not submit");
        queries += 1;
        return new Response(JSON.stringify({
          result: {
            utterances: [{
              text: "先倒",
              words: [
                { text: "先", start_time: 1650, end_time: 1890 },
                { text: "倒", start_time: 1890, end_time: 2050 },
              ],
            }],
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json", "x-api-status-code": "20000000", "x-api-message": "OK" },
        });
      },
    });
    assert.equal(await run(["runs", "resume", runName, "--execute", "--project", dir], done.io), 0, done.err());
    const doc = JSON.parse(await readFile(path.join(dir, "refs", "draft.json"), "utf8")) as {
      cues: { text: string; start: number; end: number }[];
      words: { text: string; end: number }[];
    };
    assert.equal(doc.cues[0]?.text, "先倒");
    assert.equal(doc.cues[0]?.start, 1.65);
    assert.equal(doc.cues[0]?.end, 2.05);
    assert.equal(doc.words[0]?.text, "先");
    assert.equal(submits, 1);
  });
});
