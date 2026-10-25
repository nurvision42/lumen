---
name: 雪碧图
description: 用 lumen sprite 把本地视频抽成多宫格，用 lumen cuts 看机械切点。不要因为出现了视频就自动出图。
---

# 雪碧图

用户要看一条成片的镜头格子、时间轴缩略图，或只要切点候选时，读本文件。只跑 `lumen sprite` 和 `lumen cuts`。不要自己调用 ffmpeg 或 sharp。不要因为出现了视频就自动出雪碧图。抽帧不需要密钥。

## 工具从哪来

电脑上已经有 ffmpeg、ffprobe 就用电脑的。查找顺序：`LUMEN_FFMPEG` / `LUMEN_FFPROBE`，或配置里的 `tools.ffmpeg` / `tools.ffprobe`，然后 PATH，然后本机缓存，最后才下载静态二进制并校验哈希。提前准备用：

```text
lumen setup ffmpeg
```

sharp 同样不在安装 lumen 时下载。排版时先加载本机已经能 `require` 到的 sharp，没有再装进缓存。`lumen doctor` 会写出三者的路径、版本和来源。来源是 `config`、`path`、`cache`、`download`；本机 sharp 模块是 `module`。没有则是 `missing`。doctor 不下载。

## 抽帧

```text
lumen sprite --video <file> --to refs/sheet.png
```

这条命令会立刻抽帧出图，没有 `--dry-run`。`--to` 已存在就不覆盖。`--json` 打印页路径、每帧真实时间和来源，不打印临时帧文件。

选帧只选一种：

- `--every <秒>`：从窗口起点按这个间隔取样。
- `--frames <n>`：把窗口切成 n 段，每段取中点。
- `--every-frame`：窗口内每一帧。
- `--at <时间>`：可以逗号分隔，也可以重复这个参数。
- `--ranges <json>`：数组，每段 `{start,end,id?,frames?,every?}`。
- `--start` / `--end` 可以收窄窗口。

都不写时：先读项目里的拆解结果（`refs/*.video-understand.json`，否则镜头表）。每镜抽头、中、尾 3 张；镜头长于 3 秒时，再按每秒 1 张补。也可以用 `--shots <file>` 指定那份结果。没有拆解时，用 ffmpeg 的 scene 检测找切点，再按同样的头中尾规则抽。还是没有切点，就按 1 秒的固定间隔抽。

## 版式

`--columns` 默认 3。`--rows` 默认 3，满一页就分页：第一页是 `--to`，后面是同目录 `名字-2.png`。`--cell` 是每格宽度，默认 320。每格下面有时间，有镜头号时写成「镜头 N」。需要台词时加 `--transcript <file>`（srt、json 或拆解文件）。没有这个参数就不写台词。

## 切点

```text
lumen cuts --video <file> --sample-rate 8 --threshold 0.4
```

只输出候选时间和分数。`--json` 同样可用。阈值默认 0.4。不写 `--sample-rate` 就看每一帧。
