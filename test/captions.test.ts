import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { burnVideoArgs, overlayGraph, probeVideo } from "../src/captions/burn.js";
import { BITRATE_FALLBACK_NOTE } from "../src/grain/apply.js";
import { clampCues } from "../src/captions/cues.js";
import { composePill, encodePng, roundedCoverage } from "../src/captions/png.js";
import { discoverScript } from "../src/captions/script.js";
import { wrapSubtitle } from "../src/captions/render.js";
import {
  BACKGROUND_COLOR,
  LANDSCAPE_BOTTOM_MARGIN,
  PORTRAIT_TOP_MARGIN,
  defaultPosition,
  edgeMarginPx,
  fontSizeFor,
  pillTop,
} from "../src/captions/style.js";
import { run } from "../src/run.js";
import { findCjkFont } from "../src/sprite/layout.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
// 用本机实际存在的中文字体，避免写死某台机器的字体路径
const FONT = (await findCjkFont()) ?? "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc";

test("default caption layout follows the short side and the safe-area ratios", () => {
  assert.equal(fontSizeFor(1440, 2560), 56);
  assert.equal(defaultPosition(1440, 2560), "top_center");
  assert.equal(edgeMarginPx(2560, "top_center"), 317);
  assert.equal(PORTRAIT_TOP_MARGIN, 317 / 2560);
  assert.equal(fontSizeFor(2560, 1440), 56);
  assert.equal(defaultPosition(2560, 1440), "bottom_center");
  assert.equal(edgeMarginPx(1440, "bottom_center"), 225);
  assert.equal(LANDSCAPE_BOTTOM_MARGIN, 225 / 1440);
  assert.equal(defaultPosition(1080, 1080), "bottom_center");
  assert.equal(edgeMarginPx(1000, "top_center"), Math.round(1000 * 317 / 2560));
  assert.equal(fontSizeFor(720, 1280), 28);
  assert.equal(BACKGROUND_COLOR.a, 0.51);
  const top = pillTop(2560, 80, "top_center");
  assert.equal(top, 317);
  const bottom = pillTop(1440, 80, "bottom_center");
  assert.equal(bottom, 1440 - 225 - 80);
});

test("clamp keeps cue ends inside the picture", () => {
  const kept = clampCues([
    { start: 0.2, end: 1.2, text: "留着" },
    { start: 1.5, end: 5, text: "裁尾" },
    { start: 4.2, end: 6, text: "丢掉" },
  ], 3);
  assert.equal(kept.clamped, true);
  assert.equal(kept.cues.length, 2);
  assert.equal(kept.cues[1]?.end, 3);
  assert.equal(kept.cues[1]?.text, "裁尾");
  const clean = clampCues([{ start: 0, end: 1, text: "刚好" }], 1);
  assert.equal(clean.clamped, false);
  assert.equal(clean.cues[0]?.end, 1);
});

test("ink sits in the optical center of a rounded translucent pill", () => {
  const textWidth = 20;
  const textHeight = 20;
  const text = Buffer.alloc(textWidth * textHeight * 4);
  for (let y = 2; y < 8; y += 1) {
    for (let x = 5; x < 13; x += 1) {
      const index = (y * textWidth + x) * 4;
      text[index] = 255;
      text[index + 1] = 255;
      text[index + 2] = 255;
      text[index + 3] = 255;
    }
  }
  const pill = composePill({
    text,
    textWidth,
    textHeight,
    ink: { x: 5, y: 2, w: 8, h: 6 },
    fontSize: 20,
    background: BACKGROUND_COLOR,
    radiusFactor: 0.45,
    padXFactor: 0.25,
    padYFactor: 0.25,
  });
  let minX = pill.width;
  let minY = pill.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < pill.height; y += 1) {
    for (let x = 0; x < pill.width; x += 1) {
      const index = (y * pill.width + x) * 4;
      if ((pill.rgba[index] ?? 0) > 200 && (pill.rgba[index + 3] ?? 0) > 200) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  assert.equal(minX, pill.width - 1 - maxX);
  assert.equal(minY, pill.height - 1 - maxY);
  const center = pill.rgba[((Math.floor(pill.height / 2) * pill.width) + Math.floor(pill.width / 2)) * 4 + 3] ?? 0;
  const corner = pill.rgba[3] ?? 0;
  assert.ok(center > 100, `center alpha ${center}`);
  assert.ok(corner < 20, `corner alpha ${corner}`);
  assert.ok(roundedCoverage(0, 0, pill.width, pill.height, 8) < roundedCoverage(pill.width / 2, pill.height / 2, pill.width, pill.height, 8));
  const png = encodePng(pill.rgba, pill.width, pill.height);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("subtitle wrap uses em width and the overlay graph escapes commas", () => {
  assert.equal(wrapSubtitle("你好世界啊", 10, 40), "你好世界\n啊");
  assert.equal(wrapSubtitle("hello", 10, 40), "hello");
  const graph = overlayGraph([{ x: 10, y: 20, start: 0.2, end: 1.5 }]);
  assert.match(graph, /between\(t\\,0\.200\\,1\.500\)/);
  assert.match(graph, /\[vout\]/);
  assert.match(overlayGraph([{ x: 1, y: 2, start: 0, end: 1 }], { even: true }), /scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function asrFetch(subtitles: { start_time: number; end_time: number; subtitle_text: string }[], duration = 4): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("request-media-upload-url")) {
      return jsonResponse({ success: true, result: { file_id: "file-1", upload_url: "https://upload.example/put" } });
    }
    if (init?.method === "PUT") return jsonResponse({ ok: true });
    if (url.includes("asr-subtitles")) {
      return jsonResponse({
        success: true,
        status: "completed",
        task_id: "task-asr",
        result: { duration, subtitles },
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

test("transcribe dry-run plans asr-subtitles and writes no caption file", async () => {
  await withDir(async (dir) => {
    const bind = capture();
    assert.equal(
      await run(
        ["providers", "set", "asr-subtitles", "--provider", "mediakit", "--base-url", "https://mediakit.example", "--api-key-env", "MEDIAKIT_ASR_KEY", "--group", "queue-1", "--project", dir],
        bind.io,
      ),
      0,
      bind.err(),
    );
    let called = false;
    const cap = capture({ MEDIAKIT_ASR_KEY: "secret-value" }, {
      fetch: async () => {
        called = true;
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["captions", "transcribe", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.equal(called, false);
    assert.match(cap.out(), /dry-run asr-subtitles/);
    assert.equal(cap.out().includes("secret-value"), false);
    const runName = (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "";
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", runName, "record.json"), "utf8")) as {
      calls: { url: string; body: { kind: string; value?: { video_url?: string; queue_id?: string } } }[];
    };
    const body = JSON.stringify(record.calls);
    assert.match(body, /asr-subtitles/);
    assert.match(body, /request-media-upload-url/);
    assert.match(body, /mediakit:\/\/\{\{file_id\}\}/);
    assert.match(body, /queue-1/);
    assert.equal(body.includes("secret-value"), false);
    await assert.rejects(readFile(path.join(dir, "refs", "missing.captions.json"), "utf8"));
  });
});

test("execute clamps to the file duration and ignores a project script", async () => {
  await withDir(async (dir) => {
    const bind = capture();
    assert.equal(
      await run(
        ["providers", "set", "asr-subtitles", "--provider", "mediakit", "--api-key-env", "MEDIAKIT_ASR_KEY", "--project", dir],
        bind.io,
      ),
      0,
      bind.err(),
    );
    const video = path.join(dir, "clip.mp4");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video]);
    await writeFile(
      path.join(dir, "shotlist.md"),
      "| # | durationSec | frame | vo |\n| --- | --- | --- | --- |\n| 1 | 2 | a | 这不就瓶普通矿泉水吗 |\n",
    );
    const fetch = asrFetch([{ start_time: 0.2, end_time: 9, subtitle_text: "这不就瓶普通矿泉谁吗" }], 9);
    const loose = capture({ ...process.env, MEDIAKIT_ASR_KEY: "secret-value" }, { fetch });
    assert.equal(
      await run(["captions", "transcribe", "--video", "clip.mp4", "--no-script", "--execute", "--to", "refs/loose.json", "--project", dir], loose.io),
      0,
      loose.err(),
    );
    assert.match(loose.out(), /clamped: yes/);
    assert.match(loose.out(), /confirmed: no/);
    const looseDoc = JSON.parse(await readFile(path.join(dir, "refs", "loose.json"), "utf8")) as {
      duration: number;
      clamped: boolean;
      confirmed: boolean;
      cues: { start: number; end: number; text: string }[];
    };
    assert.ok(looseDoc.duration < 2.1);
    assert.equal(looseDoc.clamped, true);
    assert.equal(looseDoc.cues[0]?.text, "这不就瓶普通矿泉谁吗");
    assert.ok((looseDoc.cues[0]?.end ?? 99) <= looseDoc.duration + 0.001);
    const looseText = await readFile(path.join(dir, "refs", "loose.txt"), "utf8");
    assert.equal(looseText.includes("-->"), false);

    const matched = capture({ ...process.env, MEDIAKIT_ASR_KEY: "secret-value" }, { fetch });
    assert.equal(
      await run(["captions", "transcribe", "--video", "clip.mp4", "--execute", "--to", "refs/matched.json", "--project", dir], matched.io),
      0,
      matched.err(),
    );
    assert.match(matched.out(), /confirmed: no/);
    assert.match(matched.out(), /script: none/);
    assert.equal(matched.out().includes("secret-value"), false);
    const doc = JSON.parse(await readFile(path.join(dir, "refs", "matched.json"), "utf8")) as {
      confirmed: boolean;
      cues: { start: number; end: number; text: string }[];
      script: null;
      duration: number;
    };
    assert.equal(doc.confirmed, false);
    assert.equal(doc.script, null);
    assert.equal(doc.cues[0]?.text, "这不就瓶普通矿泉谁吗");
    assert.equal(doc.cues[0]?.start, looseDoc.cues[0]?.start);
    assert.equal(doc.cues[0]?.end, looseDoc.cues[0]?.end);
    assert.ok((doc.cues[0]?.end ?? 99) <= doc.duration + 0.001);
    assert.equal(doc.cues.length, looseDoc.cues.length);

    const rejected = capture({ ...process.env, MEDIAKIT_ASR_KEY: "secret-value" }, { fetch });
    assert.equal(
      await run(["captions", "transcribe", "--video", "clip.mp4", "--script", "shotlist.md", "--execute", "--project", dir], rejected.io),
      2,
      rejected.err(),
    );
    assert.match(rejected.err(), /does not take --script/);
    assert.match(rejected.err(), /captions burn --subs/);
  });
});

test("a loose video stays unconfirmed until burn is told to proceed", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "refs"), { recursive: true });
    const video = path.join(dir, "wide.mp4");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video]);
    const subs = path.join(dir, "refs", "loose.json");
    await writeFile(subs, `${JSON.stringify({
      format: "lumen.captions@1",
      confirmed: false,
      cues: [{ start: 0.2, end: 1, text: "哎这水喝着挺顺" }],
    })}\n`);
    const before = await readFile(subs, "utf8");
    const denied = capture();
    const removed = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/loose.json", "--to", "out.mp4", "--font", FONT, "--confirm", "--speech", "哎这水喝着挺顺", "--project", dir], removed.io),
      2,
    );
    assert.match(removed.err(), /does not take --speech/);
    assert.match(removed.err(), /--subs/);
    await assert.rejects(readFile(path.join(dir, "out.mp4")));
    await writeFile(path.join(dir, "refs", "cues.srt"), "1\n00:00:00,000 --> 00:00:01,000\n校对后的一句\n");
    const srt = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/cues.srt", "--to", "srt.mp4", "--font", FONT, "--dry-run", "--project", dir], srt.io),
      0,
      srt.err(),
    );
    assert.match(srt.out(), /cues: 1/);
    assert.equal(srt.out().includes("burned:"), false);
    await writeFile(path.join(dir, "refs", "reviewed.json"), `${JSON.stringify({
      cues: [{ start: 0.2, end: 0.9, text: "校对后的一句" }],
    })}\n`);
    const reviewed = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/reviewed.json", "--to", "reviewed.mp4", "--font", FONT, "--dry-run", "--project", dir], reviewed.io),
      0,
      reviewed.err(),
    );
    assert.match(reviewed.out(), /cues: 1/);
    assert.equal(await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/loose.json", "--to", "out.mp4", "--font", FONT, "--project", dir], denied.io), 1);
    assert.match(denied.err(), /not confirmed/);
    assert.equal(await readFile(subs, "utf8"), before);
    const planned = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/loose.json", "--to", "out.mp4", "--font", FONT, "--confirm", "--dry-run", "--project", dir], planned.io),
      0,
      planned.err(),
    );
    assert.match(planned.out(), /planned: /);
    assert.match(planned.out(), /position: bottom_center/);
    assert.match(planned.out(), /fontSize: 14/);
    assert.equal(planned.out().includes("burned:"), false);
    await assert.rejects(readFile(path.join(dir, "out.mp4")));

    const portrait = path.join(dir, "tall.mp4");
    // Flat blue at the default CRF probes at a few kilobits. Burn matches that rate and
    // would quantize the glyphs this test counts, so the fixture is padded up to a real rate.
    await exec("/usr/bin/ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=360x640:d=1.2",
      "-c:v", "libx264", "-b:v", "1500k", "-minrate", "1500k", "-maxrate", "1500k", "-bufsize", "1500k",
      "-x264-params", "nal-hrd=cbr:filler=1", "-pix_fmt", "yuv420p", "-an",
      portrait,
    ]);
    const burned = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "tall.mp4", "--subs", "refs/loose.json", "--to", "tall-out.mp4", "--font", FONT, "--confirm", "--project", dir], burned.io),
      0,
      burned.err(),
    );
    assert.match(burned.out(), /position: top_center/);
    assert.match(burned.out(), /burned: /);
    assert.equal(await readFile(subs, "utf8"), before);
    await assert.rejects(readFile(path.join(dir, "refs", "loose.speech.json")));
    const frame = path.join(dir, "frame.rgb");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", path.join(dir, "tall-out.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", frame]);
    const raw = await readFile(frame);
    const width = 360;
    const height = 640;
    let topWhite = 0;
    let bottomWhite = 0;
    let minWhite = height;
    let maxWhite = 0;
    const pill: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const r = raw[index] ?? 0;
        const g = raw[index + 1] ?? 0;
        const b = raw[index + 2] ?? 0;
        if (r > 220 && g > 220 && b > 220) {
          if (y < height * 0.45) topWhite += 1;
          if (y > height * 0.7) bottomWhite += 1;
          minWhite = Math.min(minWhite, y);
          maxWhite = Math.max(maxWhite, y);
        }
        if (r > 20 && r < 90 && Math.abs(r - g) < 20 && b > 120 && b < 220) pill.push({ x, y });
      }
    }
    assert.ok(topWhite > 10, `top white ${topWhite}`);
    assert.equal(bottomWhite, 0);
    assert.ok(minWhite > 40, `subtitle starts at ${minWhite}`);
    const pillYs = pill.map((pixel) => pixel.y);
    const pillTopY = Math.min(...pillYs);
    const pillBottom = Math.max(...pillYs);
    const inkMid = (minWhite + maxWhite) / 2;
    const boxMid = (pillTopY + pillBottom) / 2;
    assert.ok(Math.abs(inkMid - boxMid) <= 2, `ink ${inkMid} box ${boxMid}`);
    const corner = pill.find((pixel) => pixel.x === Math.min(...pill.map((item) => item.x)) && pixel.y === pillTopY);
    const inset = pill.find((pixel) => Math.abs(pixel.x - width / 2) < 4 && Math.abs(pixel.y - boxMid) < 4);
    assert.ok(corner === undefined || inset !== undefined);
  });
});

test("burn encode args follow the source bitrate", () => {
  const args = burnVideoArgs({ bps: 14_700_000, source: "stream" });
  assert.equal(args.includes("-crf"), false);
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-pix_fmt")), [
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "14700k", "-maxrate", "14700k", "-bufsize", "29400k",
  ]);
  assert.deepEqual(args.slice(args.indexOf("-c:a")), ["-c:a", "copy", "-movflags", "+faststart"]);
  const fallback = burnVideoArgs({ bps: 35320, source: "format" });
  assert.equal(fallback.includes("35320"), true);
  assert.equal(fallback.includes("70640"), true);
});

test("burn stays near the source bitrate and copies audio", { timeout: 120_000 }, async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "refs"), { recursive: true });
    const video = path.join(dir, "clip.mp4");
    await exec("/usr/bin/ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=4,noise=alls=40:allf=t+u",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      video,
    ]);
    const original = `${JSON.stringify({
      format: "lumen.captions@1",
      confirmed: true,
      cues: [{ start: 0.4, end: 2.2, text: "哎这水喝着挺顺" }],
    })}\n`;
    await writeFile(path.join(dir, "refs", "ok.json"), original);
    const source = await probeVideo("/usr/bin/ffprobe", video);
    assert.equal(source.bitrate.source, "stream");
    assert.equal(source.width, 640);
    assert.equal(source.height, 360);
    const burned = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "clip.mp4", "--subs", "refs/ok.json", "--to", "out.mp4", "--font", FONT, "--project", dir], burned.io),
      0,
      burned.err(),
    );
    assert.equal(burned.out().includes(BITRATE_FALLBACK_NOTE), false);
    const output = path.join(dir, "out.mp4");
    const after = await probeVideo("/usr/bin/ffprobe", output);
    const sourceSize = (await stat(video)).size;
    const outputSize = (await stat(output)).size;
    const bitrateRatio = after.bitrate.bps / source.bitrate.bps;
    const sizeRatio = outputSize / sourceSize;
    assert.ok(bitrateRatio > 0.8 && bitrateRatio < 1.25, `video bitrate ${after.bitrate.bps} vs ${source.bitrate.bps}`);
    assert.ok(sizeRatio > 0.8 && sizeRatio < 1.25, `file size ${outputSize} vs ${sourceSize}`);
    assert.equal(after.width, source.width);
    assert.equal(after.height, source.height);
    assert.ok(Math.abs(after.duration - source.duration) < 0.05, `duration ${after.duration} vs ${source.duration}`);
    const { stdout } = await exec("/usr/bin/ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,bit_rate", "-of", "csv=p=0",
      output,
    ]);
    const sourceAudio = await exec("/usr/bin/ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,bit_rate", "-of", "csv=p=0",
      video,
    ]);
    assert.equal(stdout.trim(), sourceAudio.stdout.trim());
    assert.match(stdout, /aac/);
    assert.equal(await readFile(path.join(dir, "refs", "ok.json"), "utf8"), original);
    await assert.rejects(readFile(path.join(dir, "refs", "ok.speech.json")));

    const raw = path.join(dir, "raw.mkv");
    await exec("/usr/bin/ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=0.4",
      "-c:v", "ffv1", "-an", raw,
    ]);
    await writeFile(path.join(dir, "refs", "short.json"), `${JSON.stringify({
      format: "lumen.captions@1",
      confirmed: true,
      cues: [{ start: 0.05, end: 0.3, text: "顺" }],
    })}\n`);
    const fallback = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "raw.mkv", "--subs", "refs/short.json", "--to", "format.mp4", "--font", FONT, "--font-size", "8", "--project", dir], fallback.io),
      0,
      fallback.err(),
    );
    assert.match(fallback.out(), new RegExp(BITRATE_FALLBACK_NOTE));
    const formatted = await probeVideo("/usr/bin/ffprobe", path.join(dir, "format.mp4"));
    assert.equal(formatted.bitrate.source, "stream");
    assert.equal(formatted.width, 64);
    assert.equal(formatted.height, 64);
  });
});

test("voice-synthesis text is the script when the shot list line is empty", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, ".lumen", "runs", "run-voice"), { recursive: true });
    await writeFile(path.join(dir, "shotlist.md"), "| # | durationSec | frame | vo |\n| --- | --- | --- | --- |\n| 1 | 2 | a |  |\n");
    await writeFile(path.join(dir, ".lumen", "runs", "run-voice", "record.json"), `${JSON.stringify({
      time: "2026-01-01T00:00:00.000Z",
      command: ["fish", "synth", "--shot", "1"],
      modelId: "voice-synthesis",
      status: "ok",
      params: { text: "哎这水喝着挺顺" },
    })}\n`);
    const found = await discoverScript(dir);
    assert.equal(found?.source, "voice");
    assert.equal(found?.timed, true);
    assert.equal(found?.lines[0]?.text, "哎这水喝着挺顺");
    assert.equal(found?.lines[0]?.end, 2);
  });
});

test("captions are named in help and the skill points at both references", async () => {
  const help = capture();
  assert.equal(await run(["--help"], help.io), 0);
  assert.match(help.out(), /lumen captions transcribe/);
  assert.match(help.out(), /lumen captions burn/);
  assert.match(help.out(), /Runs immediately/);
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  assert.match(skill, /references\/转字幕\/SKILL\.md/);
  assert.match(skill, /references\/加字幕\/SKILL\.md/);
  assert.match(skill, /lumen captions transcribe --video <file>/);
  assert.match(skill, /lumen captions burn --video <file> --subs <file> --to <mp4>/);
  assert.equal(skill.trim().split("\n").length <= 80, true);
  const transcribe = await readFile(path.join(root, "skills", "lumen", "references", "转字幕", "SKILL.md"), "utf8");
  const burn = await readFile(path.join(root, "skills", "lumen", "references", "加字幕", "SKILL.md"), "utf8");
  assert.match(transcribe, /--execute/);
  assert.match(transcribe, /confirmed/);
  assert.match(transcribe, /不接受 `--script`/);
  assert.match(help.out(), /--speech and --speech-file are rejected/);
  assert.match(help.out(), /--script is rejected/);
  assert.match(burn, /不接受 `--speech`/);
  assert.equal(burn.includes("0.85"), false);
  assert.equal(burn.includes("0.75"), false);
  assert.match(burn, /立刻压制/);
  assert.match(burn, /bit_rate/);
  assert.match(burn, /top_center/);
  assert.match(burn, /317 \/ 2560/);
  assert.match(burn, /225 \/ 1440/);
  assert.match(burn, /0\.039/);
  assert.equal(/https?:\/\/|\/v1\//.test(transcribe + burn), false);
});
