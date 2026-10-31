import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { enhanceCost } from "../src/enhance/cost.js";
import {
  applyFilmGrain,
  bitrateToken,
  chooseBitrate,
  grainFilter,
  grainFfmpegArgs,
  grainGeometry,
  planFromProbe,
} from "../src/grain/apply.js";

const exec = promisify(execFile);
const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

const PROVEN = "[0:v]split[base][n];[n]scale=1280:720,format=gray,geq=lum=128,noise=c0s=60:c0f=t+u,gblur=sigma=0.6,scale=2560:1440:flags=bicubic,format=yuv420p[g];[base][g]blend=all_mode=overlay:c0_opacity=0.55:c1_opacity=0:c2_opacity=0";

test("grain matches the proven 2560x1440 graph and keeps sizes even", () => {
  assert.equal(grainFilter(2560, 1440), PROVEN);
  assert.deepEqual(grainGeometry(2560, 1440), { frameWidth: 2560, frameHeight: 1440, grainWidth: 1280, grainHeight: 720 });
  assert.equal(
    grainFilter(641, 361),
    "[0:v]scale=640:360[src];[src]split[base][n];[n]scale=320:180,format=gray,geq=lum=128,noise=c0s=60:c0f=t+u,gblur=sigma=0.6,scale=640:360:flags=bicubic,format=yuv420p[g];[base][g]blend=all_mode=overlay:c0_opacity=0.55:c1_opacity=0:c2_opacity=0",
  );
  assert.deepEqual(grainGeometry(3, 5), { frameWidth: 2, frameHeight: 4, grainWidth: 2, grainHeight: 2 });
  assert.equal(grainFilter(2560, 1440).includes("c1_opacity=0:c2_opacity=0"), true);
});

test("bitrate uses the stream value, then the format value, and keeps the exact rate", () => {
  assert.equal(bitrateToken(10_672_000), "10672k");
  assert.equal(bitrateToken(21_344_000), "21344k");
  assert.equal(bitrateToken(18080), "18080");
  assert.deepEqual(chooseBitrate("10672000", "999"), { bps: 10_672_000, source: "stream" });
  assert.deepEqual(chooseBitrate(10_672_000, "1"), { bps: 10_672_000, source: "stream" });
  assert.deepEqual(chooseBitrate(undefined, "35320"), { bps: 35320, source: "format" });
  assert.deepEqual(chooseBitrate("N/A", "8000"), { bps: 8000, source: "format" });
  assert.deepEqual(chooseBitrate("0", "8000"), { bps: 8000, source: "format" });
  assert.throws(() => chooseBitrate(undefined, undefined), /stream bit_rate and format bit_rate were missing/);
  const plan = planFromProbe({
    streams: [{ width: 2560, height: 1440, bit_rate: "10672000" }],
    format: { bit_rate: "1" },
  });
  assert.equal(plan.filter, PROVEN);
  assert.equal(plan.rate, "10672k");
  assert.equal(plan.bufsize, "21344k");
  assert.equal(plan.bitrate.source, "stream");
  const args = grainFfmpegArgs("in.mp4", "out.mp4", plan);
  assert.deepEqual(args.slice(args.indexOf("-b:v"), args.indexOf("-tune")), ["-b:v", "10672k", "-maxrate", "10672k", "-bufsize", "21344k"]);
  assert.equal(args.includes("slow"), true);
  assert.equal(args.includes("copy"), true);
  const fallback = planFromProbe({ streams: [{ width: 64, height: 64 }], format: { bit_rate: "35320" } });
  assert.equal(fallback.bitrate.source, "format");
  assert.equal(fallback.rate, "35320");
});

test("the 2k30 large-model estimate is 10 yuan per minute", () => {
  assert.equal(enhanceCost(undefined).text, "estimate: 10 yuan/min (enhance-video-generative 2k 30fps)");
  assert.equal(enhanceCost(6).text, "estimate: 1.00 yuan (0.100 min × 10 yuan/min, enhance-video-generative 2k 30fps)");
  assert.equal(enhanceCost(90).text, "estimate: 15.00 yuan (1.500 min × 10 yuan/min, enhance-video-generative 2k 30fps)");
  assert.equal(enhanceCost(600).yuan, 100);
  assert.equal(enhanceCost(0).text, enhanceCost(undefined).text);
});

test("film grain keeps audio and names a format-bitrate fallback", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lumen-grain-"));
  try {
    const source = path.join(dir, "in.mp4");
    const grained = path.join(dir, "out.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.24",
      "-c:v", "libx264", "-b:v", "200k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      source,
    ]);
    const plan = await applyFilmGrain({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, output: grained });
    assert.equal(plan.bitrate.source, "stream");
    assert.equal(plan.filter.includes("c0_opacity=0.55"), true);
    const { stdout } = await exec(FFPROBE, [
      "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "csv=p=0", grained,
    ]);
    assert.match(stdout, /h264/);
    assert.match(stdout, /yuv420p/);
    assert.match(stdout, /aac/);
    assert.equal((await readFile(grained)).equals(await readFile(source)), false);

    const raw = path.join(dir, "raw.mkv");
    const fromFormat = path.join(dir, "format.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=0.16",
      "-c:v", "ffv1", "-an", raw,
    ]);
    const fallback = await applyFilmGrain({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source: raw, output: fromFormat });
    assert.equal(fallback.bitrate.source, "format");
    assert.equal(fallback.rate, String(fallback.bitrate.bps));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
