---
name: 转字幕
description: 用 lumen captions transcribe 把视频语音认成带时间的字幕。有文案就对照，没有就先确认再加字幕。
---

# 转字幕

用户要字幕文稿、要核对口播、或成片最后一步要压字幕之前，读本文件。只跑 `lumen captions transcribe`。不要自己拼请求，不要自己调语音识别。

这一步只出字幕，不把字压进画面。压画面用加字幕，读 `skills/lumen/references/加字幕/SKILL.md`。

## 何时用

- 项目里已经有镜头口播，或已经跑过语音合成、声音克隆，现在要给成片配字幕。命令会自己找文案并对照，不必再问用户要不要改字。
- 用户直接丢来一条视频，项目里没有口播也没有合成记录。只写出识别结果，等用户或你看过，再去加字幕。

不要因为对话里出现了视频就自动转字幕。

## 命令

```text
lumen captions transcribe --video <file>
```

默认 `--dry-run`：只把将要提交的请求写进审计，不上传，不写字幕文件。用户明确要识别时加 `--execute`。`--mock` 用内置假传输，不写字幕文件。

`--video` 可以是项目里的文件，也可以是一条已有的远程地址。本地文件的片长用 ffprobe 读。结束时间超过片长的会被裁掉，整段落在片长之外的会丢掉，避免字幕把成片拖出黑尾。远程地址没有本地片长时，用识别服务返回的时长。

输出默认在 `refs/<运行编号>.captions.json`，旁边有一份同名 `.txt` 方便读。`--to` 改 JSON 的位置，文本跟在旁边。需要交换文件时再加 `--srt` 或 `--ass`。ASS 只是交换格式，圆角底不在这一步画。

JSON 里看这几项：

- `duration`：用来裁时间的片长，单位秒。
- `clamped`：`true` 表示有条目被裁短或丢掉。
- `confirmed`：`true` 才能直接拿去加字幕。
- `script`：用了哪份文案、相似度 `fit`、有没有 `applied`。没有文案就是 `null`。
- `cues`：每条 `start`、`end`、`text`。开了说话人时还有 `speaker`。
- `asrDuration`：服务返回的时长，和 `duration` 不一样时才会出现。

标准输出也会写片长、是否裁过、是否确认、文案和条数。

## 文案从哪来

不传 `--script`、也不传 `--no-script` 时，按这个顺序找：

1. 镜头表里非空的口播。时间用每条 `durationSec` 从 0 累加，空口播的镜头也占时长，后面的句子不会挤到前面。
2. 口播是空的，但这个镜头有一次成功的语音合成或声音克隆。用那次稿子，时间仍按镜头时长。
3. 没有镜头表，但有成功的合成或克隆。把稿子接成一整段，再按识别出的时间对齐。

`--script <file>` 改用你给的文件，不再自动找。纯文本按识别时间对齐。带 `-->` 的字幕、带起止时间的 JSON、带口播列的镜头表，用文件里的时间。`--no-script` 表示故意不对照，就算项目里有稿子也只留识别结果。

对照用的是去掉标点和空白后的重合比例。`fit` 达到 0.55 才把文案写进字幕并标成已确认：错字换成文案，漏掉的长句补在空隙里，文案里没有的字丢掉。低于 0.55 不改识别结果，`confirmed` 为 false，`applied` 为 false。识别是空的、但文案自带时间时，仍按文案的时间写出条目，但不自动确认。

## 绑定

模型 `asr-subtitles`，供应商只有 `mediakit`。每个模型一条绑定，不会借用拆解或增强的密钥。

```text
lumen providers set asr-subtitles --provider mediakit --api-key-env <你的变量名>
```

密钥放在这个环境变量里，不要写进命令、项目或对话。缺密钥就让 `--execute` 失败。`--language` 可传 `cmn-Hans-CN`、`eng-US`、`spa-ES`、`ind-ID`；不传则由服务自己判断。多人说话时加 `--speaker`。

## 确认之后

`confirmed` 为 true：可以直接 `lumen captions burn --subs` 指向这份 JSON。

`confirmed` 为 false：先读 `.txt` 或 JSON。要压画面时，用户认可以后加 `--confirm`。不要把未确认的 JSON 直接压进成片。
