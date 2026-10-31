---
name: 增强
description: 用 lumen enhance 做大模型画质增强。固定 2K、30fps，下载后自动加黑白胶片颗粒。不要再单独加颗粒。
---

# 增强

用户要增强一条已有视频时读本文件。只跑 `lumen enhance`。不要自己调用 ffmpeg，不要自己拼请求。

## 命令

```text
lumen enhance [--video <file>] [--shot N] [--out <file>]
```

默认 `--dry-run`。用户明确要提交时才加 `--execute`。

固定是大模型版 `enhance-video-generative`，分辨率 `2k`，帧率 `30`。没有 `--model`、`--resolution`、`--fps`、`--tool-version`、`--scene`、`--bitrate-level`、`--enhance-style`。不要问用户选哪一档。绑定的模型 id 是 `enhance-video-generative`，供应商只有 `mediakit`。

## 费用

提交前会打印估算，按大模型 2K、不超过 30fps 的价格：10 元/分钟。能读到源片时长时，估算是时长（分钟）乘这个单价。读不到时长时只打印单价。这是估算，账单按输出时长计。

## 颗粒

https 结果下载完之后，同一条命令会加上黑白胶片颗粒，强度固定 0.55。颗粒层是画面一半的宽高，再放大回原尺寸，宽高保持偶数。成片视频码率跟增强结果的视频流码率一致；流上没有码率时改用容器码率，并写明。音频原样复制。

这一步已经包含在 `lumen enhance` 里。没有单独的颗粒命令。不要在增强之后再加一遍颗粒，也不要自己调用 ffmpeg 加颗粒。

`vod`、`tos`、`mediakit` 结果只记下地址，不会下载，也不会加颗粒。

## 输出

`--out` 优先。否则有 `--shot` 时写到 `shots/NN/clip/enhance-<id>.mp4`，没有就写 `out/enhance-<id>.mp4`。等满仍未完成时用 `lumen runs resume <id>`，取回结果时同样会加颗粒。
