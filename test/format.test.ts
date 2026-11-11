import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  detectMediaExtension,
  extensionForContentType,
  isDefaultGeneratedName,
  settleMediaPath,
  sniffMediaExtension,
  withoutMediaExtension,
} from "../src/format.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);
const ID3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 1, 2, 3, 4]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x77, 0x65, 0x62, 0x6d, 0x00]);
const MKV = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]);

function box(size: number, type: string, rest: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + rest.byteLength);
  buf[0] = (size >> 24) & 0xff;
  buf[1] = (size >> 16) & 0xff;
  buf[2] = (size >> 8) & 0xff;
  buf[3] = size & 0xff;
  buf.set(Uint8Array.from(type, (ch) => ch.charCodeAt(0)), 4);
  buf.set(rest, 8);
  return buf;
}

const MP4 = box(24, "ftyp", Uint8Array.from("isom\0\0\0\0mp41", (ch) => ch.charCodeAt(0)));
const MOV = box(20, "ftyp", Uint8Array.from("qt  \0\0\0\0", (ch) => ch.charCodeAt(0)));
const M4A = box(20, "ftyp", Uint8Array.from("M4A \0\0\0\0", (ch) => ch.charCodeAt(0)));

test("sniff recognizes common image, video, and audio containers", () => {
  assert.equal(sniffMediaExtension(PNG, "image"), ".png");
  assert.equal(sniffMediaExtension(JPEG, "image"), ".jpg");
  assert.equal(sniffMediaExtension(GIF, "image"), ".gif");
  assert.equal(sniffMediaExtension(WEBP, "image"), ".webp");
  assert.equal(sniffMediaExtension(MP4, "video"), ".mp4");
  assert.equal(sniffMediaExtension(MOV, "video"), ".mov");
  assert.equal(sniffMediaExtension(WEBM, "video"), ".webm");
  assert.equal(sniffMediaExtension(MKV, "video"), ".mkv");
  assert.equal(sniffMediaExtension(ID3, "audio"), ".mp3");
  assert.equal(sniffMediaExtension(WAV, "audio"), ".wav");
  assert.equal(sniffMediaExtension(M4A, "audio"), ".m4a");
  assert.equal(sniffMediaExtension(M4A, "video"), ".mp4");
  assert.equal(sniffMediaExtension(Uint8Array.from([1, 2, 3]), "image"), undefined);
});

test("content-type is used only when magic bytes are absent", () => {
  assert.equal(extensionForContentType("image/jpeg; charset=binary"), ".jpg");
  assert.equal(extensionForContentType("application/octet-stream"), undefined);
  assert.equal(detectMediaExtension(JPEG, { kind: "image", fallback: ".png", contentType: "image/png" }), ".jpg");
  assert.equal(detectMediaExtension(Uint8Array.from([1, 2, 3]), { kind: "image", fallback: ".png", contentType: "image/jpeg" }), ".jpg");
  assert.equal(detectMediaExtension(Uint8Array.from([1, 2, 3]), { kind: "image", fallback: ".png" }), ".png");
});

test("default generated names may be renamed; explicit --out is kept", () => {
  const planned = "/tmp/proj/out/20261111T120000Z-abcd.png";
  assert.equal(isDefaultGeneratedName(planned), true);
  assert.equal(isDefaultGeneratedName("/tmp/proj/out/enhance-20261111T120000Z-abcd.mp4"), true);
  assert.equal(isDefaultGeneratedName("/tmp/proj/out/dog.png"), false);

  const renamed = settleMediaPath(planned, JPEG, { kind: "image", fallback: ".png" });
  assert.equal(renamed.path, "/tmp/proj/out/20261111T120000Z-abcd.jpg");
  assert.equal(renamed.warning, undefined);

  const shot = settleMediaPath(
    path.join("/tmp/proj", "shots", "01", "frame", "20261111T120000Z-abcd.png"),
    JPEG,
    { kind: "image", fallback: ".png" },
  );
  assert.equal(path.basename(shot.path), "20261111T120000Z-abcd.jpg");

  const kept = settleMediaPath("/tmp/proj/out/dog.png", JPEG, { kind: "image", fallback: ".png" });
  assert.equal(kept.path, "/tmp/proj/out/dog.png");
  assert.match(kept.warning ?? "", /--out 以 \.png 结尾，但文件是 JPEG/);

  const same = settleMediaPath("/tmp/proj/out/dog.jpeg", JPEG, { kind: "image", fallback: ".png" });
  assert.equal(same.path, "/tmp/proj/out/dog.jpeg");
  assert.equal(same.warning, undefined);

  const bare = settleMediaPath("/tmp/proj/out/dog", JPEG, { kind: "image", fallback: ".png" });
  assert.equal(bare.path, "/tmp/proj/out/dog.jpg");
  assert.equal(bare.warning, undefined);

  const video = settleMediaPath("/tmp/proj/out/20261111T120000Z-abcd.mp4", WEBM, { kind: "video", fallback: ".mp4" });
  assert.equal(video.path, "/tmp/proj/out/20261111T120000Z-abcd.webm");

  const voice = settleMediaPath("/tmp/proj/shots/01/vo/20261111T120000Z-abcd.mp3", WAV, { kind: "audio", fallback: ".mp3" });
  assert.equal(voice.path, "/tmp/proj/shots/01/vo/20261111T120000Z-abcd.wav");

  assert.equal(withoutMediaExtension("/tmp/a.mp4"), "/tmp/a");
  assert.equal(withoutMediaExtension("/tmp/a.webm"), "/tmp/a");
});
