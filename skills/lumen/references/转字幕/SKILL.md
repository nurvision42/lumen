---
name: 转字幕
description: 用 lumen captions transcribe 调豆包录音文件识别 2.0，按逐字时间做初分段。校对交给助手，不自动改字。
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

默认引擎是豆包录音文件识别 2.0。`--dry-run` 只记请求，不抽音频，不上传，不访问识别服务。用户明确要识别时加 `--execute`。

本地视频会抽出 16 kHz 单声道 wav，上传到已经配好的 TOS，把预签名地址交给识别。资源是 `volc.seedasr.auc`，`model_name` 是 `bigmodel`，`show_utterances` 打开。没有 `tos`，或没有 `VOLC_ACCESSKEY` / `VOLC_SECRETKEY`，就失败。不会改用别的上传。

时间只来自逐字 `words`。后一个字的 `start` 比前一个字的 `end` 晚超过 0.2 秒，才另起一条。两字相接、重叠，或空隙不超过 0.2 秒（包括 40 毫秒），留在同一条。字幕上的字由这些字拼出来，不采用带标点的整句 `text`，逗号和句号不会出现。这只说明听到了停顿，不能当成语义已经切对。

识别文件是初稿，`confirmed` 为 false。旁边的 `.asr.json` 留下原始返回和完整 words。`cues` 里的 `wordFrom`、`wordTo` 指向 words 里的下标。结束时间超过片长会被裁短；words 里的原始起止保留。没有逐字、或状态不明，命令失败，不编时间。

命令不接受 `--script`。传了会直接失败。镜头表、语音合成记录、出视频提示词都不会被读。`--engine mediakit` 才走原来的 `asr-subtitles`，而且只有显式写下才走。识别失败不会悄悄退回那条路径。`--no-script` 不必再传。

提交成功后任务 id 先写入 run。查询中断时用 `lumen runs resume <id> --execute`，它只查询这一次任务，不重新提交，也不重新上传。

## 绑定

```text
lumen providers set seed-asr --provider openspeech --api-key-env DOUBAO_SPEECH_API_KEY
```

不写 `--base-url` 时用官方 openspeech 地址。密钥只放在 `DOUBAO_SPEECH_API_KEY`，不要写进命令、项目或对话。鉴权头是 `X-Api-Key`，不会留在 run 记录里。

旧路径：

```text
lumen providers set asr-subtitles --provider mediakit --api-key-env <你的变量名>
lumen captions transcribe --video <file> --engine mediakit
```

## 接下来

初稿先留着。向用户要到这条片子实际说出口的全部台词：不含说话人名字，不含画面上没说出来的字。你自己改错字，并看初分段要不要按语义合并或拆开。合并或拆开时，起点用第一个字的 `start`，终点用最后一个字的 `end`，在核对稿里记下 `wordFrom` 和 `wordTo`。不要猜一个新时间，不要按字数把一段时间摊开，不要用分镜表的时长，不要补上一句识别里没有的话。对不上的地方标出来。

核对稿写到另一个文件，例如 `refs/<运行编号>.captions.review.json`。识别原文和 `.asr.json` 不要改。核对完再读 `skills/lumen/references/加字幕/SKILL.md`。
