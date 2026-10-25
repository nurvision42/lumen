import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";
import { parseSceneLog, probeNumbers, uniqueTimes } from "../src/sprite/media.js";
import { pagePaths } from "../src/sprite/layout.js";
import {
  everyTimes,
  midpointTimes,
  parseTime,
  samplesForSpan,
  shotTimes,
} from "../src/sprite/select.js";
import {
  discoverShots,
  loadSpans,
  parseRanges,
  parseSrt,
  spansFromCuts,
  spansFromText,
} from "../src/sprite/shots.js";
import { FFMPEG_SHA256, platformId, SHARP_VERSION } from "../src/tools/catalog.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
let live: Promise<void> = Promise.resolve();

function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function fakeToolEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
  };
  delete env.LUMEN_FFMPEG;
  delete env.LUMEN_FFPROBE;
  delete env.NODE_PATH;
  return env;
}

async function pathWithoutFfmpeg(pathValue: string): Promise<string> {
  const kept: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    let blocked = false;
    for (const name of ["ffmpeg", "ffprobe"]) {
      try {
        await access(path.join(dir, name), constants.X_OK);
        blocked = true;
      } catch {
        // this directory does not provide the binary
      }
    }
    if (!blocked) kept.push(dir);
  }
  return kept.join(path.delimiter);
}

async function makeVideo(args: readonly string[], dest: string): Promise<void> {
  await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, dest]);
}

test("frame selection, shot parsing, and scene scores", async () => {
  assert.equal(parseTime("1,5"), 1.5);
  assert.equal(parseTime("01:02.5"), 62.5);
  assert.equal(parseTime("01:02:03"), 3723);
  assert.deepEqual(midpointTimes(0, 2, 4), [0.25, 0.75, 1.25, 1.75]);
  assert.deepEqual(everyTimes(0, 2, 1), [0, 1]);
  assert.deepEqual(shotTimes(0, 2), [0, 1, 1.967]);
  assert.equal(shotTimes(0, 3).length, 3);
  assert.deepEqual(shotTimes(0, 4), [0, 1, 2, 3, 3.967]);
  assert.deepEqual(samplesForSpan({ start: 0, end: 1, frames: 4, every: 0.5 }).map((sample) => sample.time), [0, 0.5]);
  assert.deepEqual(probeNumbers("0.000000,\n0.040000\n"), [0, 0.04]);
  assert.deepEqual(uniqueTimes([0, 0.04, 0.04, 0.08]), [0, 0.04, 0.08]);
  assert.deepEqual(pagePaths("/tmp/sheet.png", 2), ["/tmp/sheet.png", "/tmp/sheet-2.png"]);

  const cuts = parseSceneLog([
    "[Parsed_metadata_1 @ 0x1] frame:0    pts:12800   pts_time:1",
    "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.400000",
  ].join("\n"));
  assert.deepEqual(cuts, [{ time: 1, score: 0.4 }]);
  const spans = spansFromCuts(2, cuts);
  assert.equal(spans?.length, 2);
  assert.equal(spansFromCuts(2, []), undefined);

  const prose = spansFromText("镜头 2\n起止时间码：00:00:01.000-00:00:03.500\n字幕/台词：第二句\n");
  assert.equal(prose?.[0]?.id, "2");
  assert.equal(prose?.[0]?.start, 1);
  assert.equal(prose?.[0]?.end, 3.5);
  assert.equal(prose?.[0]?.text, "第二句");
  const cues = parseSrt("1\n00:00:00,000 --> 00:00:01,000\n你好世界\n");
  assert.equal(cues[0]?.text, "你好世界");
  assert.equal(parseRanges("[{\"start\":0,\"end\":1,\"id\":\"A\",\"frames\":2}]")[0]?.id, "A");
  assert.throws(() => parseRanges("{"), /not valid JSON/);

  await withDir(async (dir) => {
    const refs = path.join(dir, "refs");
    await mkdir(refs, { recursive: true });
    const older = path.join(refs, "old.video-understand.json");
    const newer = path.join(refs, "new.video-understand.json");
    await writeFile(older, `${JSON.stringify({ shots: [{ id: "1", start: 0, end: 1 }] })}\n`);
    await writeFile(newer, `${JSON.stringify({ result: { shots: [{ id: "9", start: 1, end: 2, 台词: "新" }] } })}\n`);
    const early = new Date("2020-01-01T00:00:00Z");
    const late = new Date("2024-01-01T00:00:00Z");
    await utimes(older, early, early);
    await utimes(newer, late, late);
    await writeFile(path.join(dir, "shotlist.md"), "| # | durationSec | frame | vo |\n| --- | --- | --- | --- |\n| 1 | 1.5 | a | 你好 |\n| 2 | 2 | b | 世界 |\n");
    const found = await discoverShots(dir);
    assert.equal(found?.file, newer);
    assert.equal(found?.spans[0]?.id, "9");
    assert.equal(found?.spans[0]?.text, "新");
    const table = await loadSpans(path.join(dir, "shotlist.md"));
    assert.equal(table[0]?.end, 1.5);
    assert.equal(table[1]?.start, 1.5);
    assert.equal(table[1]?.text, "世界");
  });
});

test("sprite usage fails before touching ffmpeg", async () => {
  await withDir(async (dir) => {
    const missing = capture();
    assert.equal(await run(["sprite", "--project", dir], missing.io), 2);
    assert.match(missing.err(), /--video/);
    const both = capture();
    assert.equal(await run(["sprite", "--video", "a.mp4", "--to", "a.png", "--every", "1", "--frames", "2", "--project", dir], both.io), 2);
    assert.match(both.err(), /choose one of/);
    const shots = capture();
    assert.equal(await run(["sprite", "--video", "a.mp4", "--to", "a.png", "--shots", "shotlist.json", "--at", "1", "--project", dir], shots.io), 2);
    assert.match(shots.err(), /--shots cannot be combined/);
    const window = capture();
    assert.equal(await run(["sprite", "--video", "a.mp4", "--to", "a.png", "--start", "2", "--end", "1", "--project", dir], window.io), 2);
    assert.match(window.err(), /--end must be after --start/);
    const cell = capture();
    assert.equal(await run(["sprite", "--video", "a.mp4", "--to", "a.png", "--cell", "0", "--project", dir], cell.io), 2);
    assert.match(cell.err(), /positive integer/);
    const absent = capture();
    assert.equal(await run(["sprite", "--video", "missing.mp4", "--to", "a.png", "--project", dir], absent.io), 1);
    assert.match(absent.err(), /video not found/);
    const cuts = capture();
    assert.equal(await run(["cuts", "--project", dir], cuts.io), 2);
    assert.match(cuts.err(), /--video/);
  });
});

test("sprite and cuts on this machine, with PATH binaries and with a hashed download", { timeout: 360_000 }, async () => {
  const runLive = live.then(() => liveSheet());
  live = runLive.then(() => undefined, () => undefined);
  await runLive;
});

async function liveSheet(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "lumen-live-"));
  try {
    const cut = path.join(scratch, "cut.mp4");
    const solid = path.join(scratch, "solid.mp4");
    const tiny = path.join(scratch, "tiny.mp4");
    await makeVideo([
      "-f", "lavfi", "-i", "color=c=red:s=160x90:d=1",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=1",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0",
      "-r", "25",
    ], cut);
    await makeVideo(["-f", "lavfi", "-i", "color=c=gray:s=160x90:d=2", "-r", "25"], solid);
    await makeVideo(["-f", "lavfi", "-i", "color=c=green:s=80x45:r=25", "-frames:v", "4"], tiny);
    await withPathBinaries(cut, solid, tiny);
    await withoutPathBinaries(cut);
    await assert.rejects(access(path.join(root, "node_modules", "sharp")));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function withPathBinaries(cut: string, solid: string, tiny: string): Promise<void> {
  await withDir(async (dir) => {
    const env = await fakeToolEnv(dir);
    env.PATH = process.env.PATH ?? "";
    const home = capture(env, { cwd: dir });
    assert.equal(await run(["doctor", "--project", dir], home.io), 0, home.err());
    assert.match(home.out(), /^ffmpeg: \S+ \S+ source=path$/m);
    assert.match(home.out(), /^ffprobe: \S+ \S+ source=path$/m);
    assert.match(home.out(), /^sharp: missing$/m);
    assert.equal(home.err().includes("downloading"), false);
    const setup = capture(env, { cwd: dir });
    assert.equal(await run(["setup", "ffmpeg", "--project", dir], setup.io), 0, setup.err());
    assert.match(setup.out(), /source=path/);
    assert.equal(setup.err().includes("downloading"), false);

    const transcript = path.join(dir, "lines.srt");
    await writeFile(transcript, "1\n00:00:00,000 --> 00:00:02,000\n画面里的人说你好\n");
    const sheet = path.join(dir, "sheet.png");
    const plain = path.join(dir, "plain.png");
    const labeled = capture(env, { cwd: dir });
    assert.equal(await run([
      "sprite", "--video", cut, "--to", sheet, "--at", "0.2",
      "--columns", "2", "--rows", "1", "--cell", "80",
      "--transcript", transcript, "--json", "--project", dir,
    ], labeled.io), 0, labeled.err());
    assert.match(labeled.err(), /downloading sharp/);
    assert.equal(labeled.err().includes("downloading ffmpeg"), false);
    const body = JSON.parse(labeled.out()) as {
      format: string;
      mode: string;
      pages: string[];
      frames: { time: number; transcript?: string }[];
      ffmpeg: { path: string; version: string; source: string };
      ffprobe: { source: string; version: string };
      sharp: { version: string; source: string; path: string };
    };
    assert.equal(body.format, "lumen.sprite@1");
    assert.equal(body.mode, "at");
    assert.equal(body.pages[0], sheet);
    assert.equal(body.frames[0]?.transcript, "画面里的人说你好");
    assert.equal(body.ffmpeg.source, "path");
    assert.equal(body.ffprobe.source, "path");
    assert.equal(body.sharp.version, SHARP_VERSION, body.sharp.path);
    assert.equal(body.sharp.source, "download");
    assert.equal(body.ffmpeg.path.includes("/usr/bin/ffmpeg") || body.ffmpeg.path.endsWith("/ffmpeg"), true);
    assert.equal(JSON.stringify(body).includes("lumen-sprite-"), false);
    const withText = pngSize(await readFile(sheet));
    assert.equal(withText.width, 192);

    const unlabeled = capture(env, { cwd: dir });
    assert.equal(await run([
      "sprite", "--video", cut, "--to", plain, "--at", "0.2",
      "--columns", "2", "--rows", "1", "--cell", "80", "--project", dir,
    ], unlabeled.io), 0, unlabeled.err());
    const withoutText = pngSize(await readFile(plain));
    assert.equal(withoutText.width, withText.width);
    assert.notEqual(withoutText.height, withText.height);
    const again = capture(env, { cwd: dir });
    const before = await readFile(plain);
    assert.equal(await run(["sprite", "--video", cut, "--to", plain, "--at", "0.2", "--project", dir], again.io), 1);
    assert.match(again.err(), /refused to overwrite/);
    assert.deepEqual(await readFile(plain), before);

    const blocked = path.join(dir, "blocked-2.png");
    await writeFile(blocked, "keep");
    const refuse = capture(env, { cwd: dir });
    assert.equal(await run([
      "sprite", "--video", cut, "--to", path.join(dir, "blocked.png"),
      "--at", "0,0.5", "--columns", "1", "--rows", "1", "--cell", "40", "--project", dir,
    ], refuse.io), 1);
    assert.equal(await readFile(blocked, "utf8"), "keep");
    await assert.rejects(access(path.join(dir, "blocked.png")));

    await writeFile(path.join(dir, "shotlist.json"), `${JSON.stringify([
      { "#": 1, durationSec: 1, frame: "a", vo: "甲" },
      { "#": 2, durationSec: 1, frame: "b", vo: "乙" },
    ])}\n`);
    const shots = capture(env, { cwd: dir });
    assert.equal(await run(["sprite", "--video", cut, "--to", path.join(dir, "shots.png"), "--cell", "40", "--json", "--project", dir], shots.io), 0, shots.err());
    const shotBody = JSON.parse(shots.out()) as { mode: string; frames: { shot?: string; transcript?: string }[] };
    assert.equal(shotBody.mode, "shots");
    assert.equal(shotBody.frames.some((frame) => frame.shot === "1"), true);
    assert.equal(shotBody.frames.some((frame) => frame.shot === "2"), true);
    assert.equal(shotBody.frames.every((frame) => frame.transcript === undefined), true);

    await rm(path.join(dir, "shotlist.json"));
    const scene = capture(env, { cwd: dir });
    assert.equal(await run(["sprite", "--video", cut, "--to", path.join(dir, "scene.png"), "--cell", "40", "--json", "--project", dir], scene.io), 0, scene.err());
    const sceneBody = JSON.parse(scene.out()) as { mode: string };
    assert.equal(sceneBody.mode, "scene");

    const interval = capture(env, { cwd: dir });
    assert.equal(await run(["sprite", "--video", solid, "--to", path.join(dir, "interval.png"), "--cell", "40", "--json", "--project", dir], interval.io), 0, interval.err());
    const intervalBody = JSON.parse(interval.out()) as { mode: string; frames: { time: number }[] };
    assert.equal(intervalBody.mode, "interval");
    assert.equal(intervalBody.frames.length >= 2, true);

    const everyFrame = capture(env, { cwd: dir });
    assert.equal(await run(["sprite", "--video", tiny, "--to", path.join(dir, "every.png"), "--every-frame", "--cell", "40", "--rows", "2", "--json", "--project", dir], everyFrame.io), 0, everyFrame.err());
    const everyBody = JSON.parse(everyFrame.out()) as { mode: string; frames: unknown[]; pages: string[] };
    assert.equal(everyBody.mode, "every-frame");
    assert.equal(everyBody.frames.length, 4);
    assert.equal(everyBody.pages.length, 1);

    const ranged = capture(env, { cwd: dir });
    assert.equal(await run([
      "sprite", "--video", cut, "--to", path.join(dir, "ranges.png"), "--cell", "40", "--json",
      "--ranges", "[{\"start\":0,\"end\":1,\"id\":\"A\",\"frames\":2}]", "--project", dir,
    ], ranged.io), 0, ranged.err());
    const rangeBody = JSON.parse(ranged.out()) as { mode: string; frames: { shot?: string }[] };
    assert.equal(rangeBody.mode, "ranges");
    assert.equal(rangeBody.frames.length, 2);
    assert.equal(rangeBody.frames[0]?.shot, "A");

    const cuts = capture(env, { cwd: dir });
    assert.equal(await run(["cuts", "--video", cut, "--json", "--project", dir], cuts.io), 0, cuts.err());
    const cutBody = JSON.parse(cuts.out()) as { format: string; cuts: { time: number; score: number }[]; ffmpeg: { source: string } };
    assert.equal(cutBody.format, "lumen.cuts@1");
    assert.equal(cutBody.ffmpeg.source, "path");
    assert.equal(cutBody.cuts.some((item) => item.time > 0.9 && item.time < 1.1 && item.score >= 0.4), true);
    const human = capture(env, { cwd: dir });
    assert.equal(await run(["cuts", "--video", solid, "--project", dir], human.io), 0, human.err());
    assert.match(human.out(), /no cuts/);

    const after = capture(env, { cwd: dir });
    assert.equal(await run(["doctor", "--project", dir], after.io), 0, after.err());
    assert.match(after.out(), /^ffmpeg: \S+ \S+ source=path$/m);
    assert.match(after.out(), new RegExp(`^sharp: ${SHARP_VERSION.replaceAll(".", "\\.")} \\S+ source=cache$`, "m"));
    console.log(`PATH_ENV ffmpeg=${body.ffmpeg.version} source=${body.ffmpeg.source} sharp=${body.sharp.version} source=${body.sharp.source} sheet=${withText.width}x${withText.height}`);
  });
}

async function withoutPathBinaries(cut: string): Promise<void> {
  await withDir(async (dir) => {
    const env = await fakeToolEnv(dir);
    env.PATH = await pathWithoutFfmpeg(process.env.PATH ?? "");
    await exec("npm", ["--version"], { env });
    const before = capture(env, { cwd: dir });
    assert.equal(await run(["doctor", "--project", dir], before.io), 0, before.err());
    assert.match(before.out(), /^ffmpeg: missing$/m);
    assert.match(before.out(), /^ffprobe: missing$/m);
    assert.match(before.out(), /^sharp: missing$/m);
    assert.equal(before.err().includes("downloading"), false);

    const setup = capture(env, { cwd: dir });
    assert.equal(await run(["setup", "ffmpeg", "--project", dir], setup.io), 0, `${setup.err()}\n${setup.out()}`);
    assert.match(setup.err(), /downloading ffmpeg/);
    assert.match(setup.err(), /downloading ffprobe/);
    assert.match(setup.out(), /^ffmpeg: \S+ \S+ source=download$/m);
    assert.match(setup.out(), /^ffprobe: \S+ \S+ source=download$/m);
    const platform = platformId();
    const ffmpegPath = path.join(dir, "cache", "lumen", "bin", platform, "ffmpeg");
    const ffprobePath = path.join(dir, "cache", "lumen", "bin", platform, "ffprobe");
    assert.equal(createHash("sha256").update(await readFile(ffmpegPath)).digest("hex"), FFMPEG_SHA256[`ffmpeg-${platform}`]);
    assert.equal(createHash("sha256").update(await readFile(ffprobePath)).digest("hex"), FFMPEG_SHA256[`ffprobe-${platform}`]);

    const sheet = path.join(dir, "downloaded.png");
    const sprite = capture(env, { cwd: dir });
    assert.equal(await run([
      "sprite", "--video", cut, "--to", sheet, "--at", "0.5,1.2",
      "--columns", "2", "--rows", "1", "--cell", "80", "--json", "--project", dir,
    ], sprite.io), 0, `${sprite.err()}\n${sprite.out()}`);
    assert.match(sprite.err(), /downloading sharp/);
    assert.equal(sprite.err().includes("downloading ffmpeg"), false);
    const body = JSON.parse(sprite.out()) as {
      mode: string;
      frames: { time: number }[];
      ffmpeg: { path: string; version: string; source: string };
      ffprobe: { path: string; source: string; version: string };
      sharp: { version: string; source: string; path: string };
    };
    assert.equal(body.mode, "at");
    assert.equal(body.frames.length, 2);
    assert.equal(body.ffmpeg.source, "cache");
    assert.equal(body.ffprobe.source, "cache");
    assert.equal(body.ffmpeg.path, ffmpegPath);
    assert.equal(body.sharp.version, SHARP_VERSION, body.sharp.path);
    assert.equal(body.sharp.source, "download");
    assert.equal(pngSize(await readFile(sheet)).width, 192);
    const cuts = capture(env, { cwd: dir });
    assert.equal(await run(["cuts", "--video", cut, "--sample-rate", "8", "--threshold", "0.4", "--json", "--project", dir], cuts.io), 0, cuts.err());
    const cutBody = JSON.parse(cuts.out()) as { sampleRate: number; cuts: { time: number }[]; ffmpeg: { source: string } };
    assert.equal(cutBody.sampleRate, 8);
    assert.equal(cutBody.ffmpeg.source, "cache");
    assert.equal(cutBody.cuts.some((item) => item.time > 0.9 && item.time < 1.1), true);
    const after = capture(env, { cwd: dir });
    assert.equal(await run(["doctor", "--project", dir], after.io), 0, after.err());
    assert.match(after.out(), /^ffmpeg: \S+ \S+ source=cache$/m);
    assert.match(after.out(), /^ffprobe: \S+ \S+ source=cache$/m);
    assert.match(after.out(), new RegExp(`^sharp: ${SHARP_VERSION.replaceAll(".", "\\.")} \\S+ source=cache$`, "m"));
    assert.equal(after.err().includes("downloading"), false);
    console.log(`DOWNLOAD_ENV ffmpeg=${body.ffmpeg.version} source=${body.ffmpeg.source} ffprobe=${body.ffprobe.version} sharp=${body.sharp.version} source=${body.sharp.source} video=${cut}`);
  });
}
