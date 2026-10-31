---
name: seedance-2
description: 用 seedance-2 或 seedance-2-fast 调用 lumen 之前先读。只管形态、时长、比例、素材上限和提交。
---

# Seedance 2.0 使用说明

本文件只管怎么用 `lumen` 调用 `seedance-2`、`seedance-2-fast`（别名 `standard`、`fast`）。两支都绑 `haomao`，不是 MediaKit；`seedance-2-fast` 也可以绑 `beeftv`（本地素材自动上传）。提示词用中文写。提示词写法读 `seedance-提示词写法/SKILL.md`，那份只写提示词，不提交。不要把提示词翻译成英文。

## 三种形态

方舟的三种输入互斥。lumen 用 `--shape` 对应它们，同一次调用不能混用首尾帧和 `--ref`。

| lumen `--shape` | 也可写成 | 输入 |
| --- | --- | --- |
| `text` | `TextVideo` | 只有提示词 |
| `frame` | `FrameVideo` | `--first-frame`，可选 `--last-frame` |
| `reference` | `ReferenceVideo` | 至少一条 `--ref`，不能再带首尾帧 |

`frame` 必须有 `--first-frame`。有尾帧就必须有首帧。`reference` 至少一条 `--ref`，并且不能再带首尾帧。`text` 不能带帧或参考。

参考的写法：`image|https://...|true`、`video|https://...|false`、`audio|https://...`。图片和视频的第三段只留在审计里，不参与生成。执行时素材必须是 `https://` URL，lumen 不上传本地文件。

## 时长、比例、分辨率、声音

来自方舟「创建视频生成任务」：

| 项 | Seedance 2.0 | fast |
| --- | --- | --- |
| `duration` | 整数秒，`[4, 15]`，或 `-1` 让模型在这个范围内自选 | 同左 |
| `ratio` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive`。系列默认 `adaptive` | 同左 |
| `resolution` | `480p`、`720p`、`1080p`、`4k`，默认 `720p`。4k 是 10bit H.265 | 只有 `480p`、`720p`，默认 `720p` |
| `generate_audio` | `true` 出同步单声道声音，`false` 无声。官方默认 `true` | 同左 |

2.0 的首帧和全模态参考都可以指定具体比例，也可以用 `adaptive`。编辑和延长在 2.0 上同样可以指定比例；这和 2.5 不同，不要把 2.5 的 `adaptive` 锁套到 2.0 上。

lumen 命令行不传 `--aspect-ratio` 时写成 `9:16`，不传 `--resolution` 时是 `720p`，不传 `--generate-audio` 时是无声。要跟官方默认一致，就显式写 `--aspect-ratio adaptive` 和 `--generate-audio`。

lumen 对这三支模型只接受时长 4–15。官方允许的 `-1` 在这里会被本地拒绝。不要传 `--task-type`，那是 2.5 的 `omni_reference_task_type`。

## 素材上限

方舟对 Seedance 2.0 系列全模态参考的上限：

- 图片 0–9 张。格式含 jpeg、png、webp、bmp、tiff、gif、heic、heif。单张小于 30 MB。宽高各 300–6000 px，宽高比 0.4–2.5。
- 视频 0–3 段。单段 `[2, 15]` 秒，总时长不超过 15 秒。mp4 或 mov，单段不超过 200 MB，帧率 24–60。
- 音频 0–3 段。单段 `[2, 15]` 秒，总时长不超过 15 秒。wav 或 mp3，单段不超过 15 MB。
- 音频不能单独使用，至少还要有一张参考图或一段参考视频。
- 图片、视频、音频合计不超过 12 条，这是 lumen 在方舟分项上限之内再加的一道本地检查。
- 不要用 `.m4a`，也不要把 `.mp4` 当音频。

方舟不接受直接上传含真人人脸的参考图或参考视频。本账号近 30 天内由 Seedance 2.5 或 2.0 生成的含人脸原片，可以作为二次创作输入。

提示词本地上限 20000 字符。句式读 `seedance-提示词写法/SKILL.md`。只传提示词正文里点到的素材。正文没写的图、视频、音频不要放进 `--ref` 或首尾帧。

## 提交

```bash
lumen gen video --model seedance-2 --shape text --prompt "…" --duration 5 --project <dir>
```

默认 `--dry-run`。用户明确要成片时才加 `--execute`，命令会自己提交并等到成片（最多约 30 分钟）。如果输出 `running` 并提示 `lumen runs resume <id>`，说明任务还在服务端跑，执行那条命令接着等，不要重新生成。比例、时长、分辨率和声音用旗标，不要只写进提示词。不要加 `--web-search`。不要自己拼请求。
