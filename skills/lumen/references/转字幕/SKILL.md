---
name: 转字幕
description: 用 lumen captions transcribe 把视频认成带原始时间的字幕。不读项目文案，不改条数和时间。口播文本交给加字幕。
---

# 转字幕

用户要识别结果，或成片要压字幕之前，读本文件。只跑 `lumen captions transcribe`。不要自己拼请求，不要自己调语音识别。

这一步只出识别字幕，不把字压进画面，也不对照文案。压画面用加字幕，读 `skills/lumen/references/加字幕/SKILL.md`。

## 何时用

用户要识别，或后面要压字幕。不要因为对话里出现了视频就自动转字幕。

不要把镜头表、语音合成稿或一份文案交给这一步。命令不接受 `--script`。`--no-script` 不必再传。

## 命令

```text
lumen captions transcribe --video <file>
```

默认 `--dry-run`：只把将要提交的请求写进审计，不上传，不写字幕文件。用户明确要识别时加 `--execute`。`--mock` 用内置假传输，不写字幕文件。

传了 `--script` 会直接失败，并提示把口播交给 `lumen captions burn --speech` 或 `--speech-file`。镜头表 `vo`、成功的 `fish synth` / `fish clone` 记录、出视频提示词，都不会被读进来，也不会变成字幕时间。

`--video` 可以是项目里的文件，也可以是一条已有的远程地址。本地文件的片长用 ffprobe 读。结束时间超过片长的会被裁短，整段落在片长之外的会丢掉。这是按成片时长做的边界检查，不是按镜头表分配时间。远程地址没有本地片长时，用识别服务返回的时长。

输出默认在 `refs/<运行编号>.captions.json`，旁边有一份同名 `.txt`。`--to` 改 JSON 的位置，文本跟在旁边。需要交换文件时再加 `--srt` 或 `--ass`。这两份只是识别结果的副本，不能拿去压制。ASS 的圆角底不在这一步画。已有同名文件时命令拒绝覆盖。

JSON 里看这几项：

- `duration`：用来裁时间的片长，单位秒。
- `clamped`：`true` 表示写出时有条目被裁短或丢掉。
- `confirmed`：识别结果固定是 `false`。
- `script`：固定是 `null`。
- `cues`：每条 `start`、`end`、`text`。开了说话人时还有 `speaker`。条数、顺序和起止时间都是识别结果。
- `asrDuration`：服务返回的时长，和 `duration` 不一样时才会出现。

标准输出也会写片长、是否裁过、是否确认和条数。没有识别条目时命令失败，不会按文案编出时间。

## 绑定

模型 `asr-subtitles`，供应商只有 `mediakit`。每个模型一条绑定，不会借用拆解或增强的密钥。

```text
lumen providers set asr-subtitles --provider mediakit --api-key-env <你的变量名>
```

密钥放在这个环境变量里，不要写进命令、项目或对话。缺密钥就让 `--execute` 失败。`--language` 可传 `cmn-Hans-CN`、`eng-US`、`spa-ES`、`ind-ID`；不传则由服务自己判断。多人说话时加 `--speaker`。`speaker` 只留在字段里，不要写进口播文本。

## 接下来

识别文件保持原样。要压画面时，另交当前这条片子实际说出口的全部口播，读 `skills/lumen/references/加字幕/SKILL.md`。
