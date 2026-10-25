---
name: 视频下载
description: 用 lumen download 把 douyin.com 成片存成项目文件。不要在对话里向用户要密钥。
---

# 视频下载

用户给出 douyin.com 链接，要保存成片，或拆解前需要本地文件时，读本文件。只跑 `lumen download`。不要自己拼 HTTP。不要因为出现了链接就自动下载。

只支持 douyin.com，包括短链。别的网站直接报错，不要猜下载方式。

## 保存

把链接换成用户给的地址，并加上引号。`--to` 相对项目目录，父目录会创建，已有文件不覆盖。

```text
lumen download "<链接>" --to refs/source.mp4
```

`--region <code>` 选择查询地区，默认 `CN`。`--json` 只打印保存路径、来源链接、视频编号、类型和大小，不打印直链。

这条命令会立刻下载，没有 `--dry-run`。

## 密钥

查找直链需要 TikHub 密钥。密钥在本机凭据库，或环境变量 `TIKHUB_API_KEY`。凭据库在项目外面（`~/.config/lumen/credentials/`），不写进 `lumen.config.json`，也不打印。

缺密钥时，命令会要求运行：

```text
lumen setup --key tikhub
```

这条命令在终端里不回显地询问密钥，并写入本机凭据库。不要把密钥放进命令参数、项目文件或对话。不要在对话里向用户要密钥。让用户自己运行上面的 setup，或自己设置 `TIKHUB_API_KEY`。

## 接着拆解

保存后的文件可以交给拆解。只传视频，不要传 prompt。不要因为出现了视频就自动拆解。

```text
lumen breakdown --video refs/source.mp4
```
