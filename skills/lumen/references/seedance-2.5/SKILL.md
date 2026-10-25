---
name: seedance-2.5
description: 用 seedance-2.5 调用 lumen 之前先读。只管形态、omni_reference_task_type、时长、比例、素材上限和提交。
---

# Seedance 2.5 使用说明

本文件只管怎么用 `lumen` 调用 `seedance-2.5`（别名 `2.5`）。模型绑 `haomao`。这不是 MediaKit，也不是 Seedance 2.0。2.0 的时长、分辨率和首帧比例不能拿来用。提示词写法读 `seedance-提示词写法/SKILL.md`，那份只写提示词，不提交。

## 三种形态

| lumen `--shape` | 也可写成 | 输入 |
| --- | --- | --- |
| `text` | `TextVideo` | 只有提示词。`ratio` 和 `duration` 没有额外锁 |
| `frame` | `FrameVideo` | `--first-frame`，可选 `--last-frame`。`ratio` 只能是 `adaptive` |
| `reference` | `ReferenceVideo` | 至少一条 `--ref`，不能再带首尾帧。子任务见下一节 |

三种形态互斥。`frame` 必须有首帧；有尾帧就必须有首帧，两张图的比例最好一致，否则尾帧会被拉开。`reference` 至少一条 `--ref`，不能再带首尾帧。需要严格卡住首尾画面时用 `frame`，不要靠提示词在参考图里「假装首帧」。

参考写法：`image|https://...|true`、`video|https://...|false`、`audio|https://...`。person-reference 只留在审计里。执行时要 `https://` URL。

## `omni_reference_task_type`

只属于 `seedance-2.5` 的 `reference`。字段名就是 `omni_reference_task_type`，lumen 用 `--task-type`。取值 `auto`、`reference`、`edit`、`extend`。不传时 lumen 记 `auto`，并在任务正文里带上 `auto`。

方舟的规则：

| 值 | 含义 | 参数 | 提示词里至少要有的意图 |
| --- | --- | --- | --- |
| `auto` | 模型先看素材和提示词再判定。判成 edit 或 extend 之后，参数不合会异步失败，错误码 `InvalidParameter.TaskTypeConstraint` | 建议 `ratio=adaptive` 且 `duration=-1`，参考视频每段 4–30 秒 | 不额外强制 |
| `reference` | 用参考图、参考视频或参考音频生成新视频。比例和时长不锁 | `ratio`、`duration` 按普通范围 | 参考职责，不要写成编辑或延长 |
| `edit` | 改原视频的画面或声音。输出比例和时长跟着被编辑的那段视频 | 至少一段 `reference_video`，该视频 4–30 秒；`ratio` 必须 `adaptive`；`duration` 必须 `-1` | 编辑视频、增加、加上、删除、去掉、修改、替换、改成 |
| `extend` | 向前或向后延长。输出比例跟着被延长的那段视频，时长仍可指定 | 至少一段 `reference_video`；`ratio` 必须 `adaptive` | 向前延长、向后延长、延续、续写 |

显式写成 `edit` 或 `extend` 时，接口会提前检查上表。提示词意图和指定值不一致时，任务仍会异步失败，错误码 `InvalidParameter.TaskTypeMismatch`。只写 `duration -1` 和 `adaptive` 不能区分 edit 和 extend，必须传 `--task-type`。

编辑是锁定任务：输出时长和被编辑视频基本一致，可能差大约 0.3–0.4 秒；若输入本身是 Seedance 2.5 的成片，时长不再缩短。延长和首尾帧只锁比例，时长仍由参数决定。`reference` 不锁比例和时长。

多段参考视频时，改哪一段、向哪边延长，由提示词里的对象决定。句式见 `seedance-提示词写法/SKILL.md`。

## 时长、比例、分辨率、声音

| 项 | 官方规则 | lumen |
| --- | --- | --- |
| `duration` | 默认 `-1`。也可指定整数秒 `[4, 30]`。编辑任务只能 `-1` | `--duration` 必填。接受 `-1` 或 4–30。编辑在提交前就要求 `-1` |
| `ratio` | 默认 `adaptive`。可选 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive`。首帧、编辑、延长只能 `adaptive` | 不传 `--aspect-ratio` 时写成 `9:16`。首帧、编辑、延长必须显式写 `adaptive`，否则本地失败 |
| `resolution` | 默认 `720p`。可选 `480p`、`720p`、`1080p`。没有 4k。1080p 是 10bit H.265 | 不传时 `720p`。不接受 `4k` |
| `generate_audio` | 默认 `true`，同步单声道。`false` 为无声 | 不传 `--generate-audio` 时是无声。要声音就加上这个旗标 |

提示词本地上限 30000 字符。句式读 `seedance-提示词写法/SKILL.md`。只传提示词正文里点到的素材。正文没写的图、视频、音频不要放进 `--ref` 或首尾帧。

## 素材上限

一次全模态参考最多约 50 份素材：

- 图片 0–30 张，分辨率可到 4K。
- 视频 0–10 段。非编辑任务单段 `[2, 30]` 秒；编辑任务单段 `[4, 30]` 秒。全部视频总时长不超过 30 秒。mp4 或 mov，单段不超过 200 MB。
- 音频 0–10 段。单段 `[2, 30]` 秒，总时长不超过 30 秒。wav 或 mp3，单段不超过 15 MB。2.5 可以只给音频，不必再配图片或视频。

硬上限之内，这些数量更稳：主体音视频 1–5 个、单段 5–10 秒；主体图 1–8 张；编辑用的视频短于 20 秒，配图 1–5 张。

方舟不接受直接上传含真人人脸的参考图或参考视频。本账号近 30 天内由 Seedance 2.5 或 2.0 生成的含人脸原片可以二次创作。

## 提交

```bash
lumen gen video --model seedance-2.5 --shape reference --task-type edit \
  --prompt "删除视频里的路人，改成空镜" \
  --duration -1 --aspect-ratio adaptive \
  --ref "video|https://cdn.example/src.mp4|false"
```

默认 `--dry-run`。用户明确要成片时才加 `--execute`，命令会自己提交并等到成片。`reference` 会带上 `omni_reference_task_type`。比例、时长、分辨率和声音用旗标，不要只写进提示词。不要加 `--web-search`。不要自己拼请求。lumen 不发送 `output_format`。
