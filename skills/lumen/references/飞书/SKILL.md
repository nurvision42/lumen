---
name: 飞书
description: 用 lumen feishu 以用户身份访问整个云盘、文档、表格、多维表格和知识库。不要调用飞书 CLI，不要在对话里要密钥。
---

# 飞书

用户要搜自己云盘里的文档或表格、读写多维表格、改文档或电子表格、看知识库时，读本文件。只跑 `lumen feishu`。不要自己拼 HTTP，不要调用 `lark-cli` 或任何飞书 CLI，也不要安装它的 skill。

每条命令都可以单独用，不必先做视频流水线。输出是一行 JSON，给代理解析。人类提示在 stderr。不要把 App Secret、`user_access_token` 或 `refresh_token` 写进仓库、项目、命令参数或对话。`device_code` 只留给下一条 `lumen feishu` 命令，不要展示给用户。

访问的是用户自己的云盘。登录用 `user_access_token`，不用应用身份 `tenant_access_token`。一次授权覆盖该用户云盘里的全部文件和文件夹，不需要用户把链接逐个转发过来。

## 扫码创建或选择应用

没有 App ID 时先跑：

```text
lumen feishu setup --no-wait
```

stdout 里的 `verificationUrl` 原样给用户，不要改查询串。用户用飞书打开该链接，或把链接做成二维码再扫。页面上可以新建自建应用，也可以选择已有应用。确认页会预填下面的用户身份权限，用户点确认后这些权限写进应用。

用户确认后：

```text
lumen feishu setup --device-code <上一步的 deviceCode>
```

加上 `--once` 时，若还在等待就返回 `status: pending`，可以过几秒再跑。应用保存后，同一条命令会接着给出用户授权链接（`phase` 为 `user`）。再用：

```text
lumen feishu login --device-code <用户授权的 deviceCode>
```

终端里可以直接 `lumen feishu setup`，它会等到两步都完成。

这一步调用的是飞书官方 SDK「扫码一键创建应用」同一条设备码协议：`POST https://accounts.feishu.cn/oauth/v1/app/registration`（`action=begin` / `action=poll`）。它写在飞书开放平台的智能体接入说明里，不在传统服务端 API 目录。权限通过确认页上的 `addons` 预填，用户确认后才生效；没有一条可以不经用户确认就静默改权限的接口。确认页会忽略它不认识的 scope 名字。

若该接口在当前租户不可用，改走手动后备，不要反复重试扫码。

## 手动后备

用户自己在飞书开放平台建好自建应用后，把 App ID 和 App Secret 放到环境变量 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`（国际版 Lark 可加 `FEISHU_BRAND=lark`），再跑：

```text
lumen feishu app
```

没有环境变量时，这条命令在终端里询问，Secret 不回显。然后 `lumen feishu login`。不要在对话里向用户要 Secret。

开发者后台里，下面每一项都要打开「用户身份」，而不只是应用身份。改完要创建并发布应用版本，管理员审批通过后才生效。

重定向 URL 只给本地回调登录用。安全设置里添加，必须逐字一致，主机写 `127.0.0.1`，不要写成 `localhost`：

```text
http://127.0.0.1:9753/callback
```

换端口时改成 `http://127.0.0.1:<端口>/callback`，并在 `lumen feishu login --callback --port <端口>` 使用同一个值。默认的设备码登录不打开这个地址；若后台强制要填一条重定向 URL，就填上面这一条。

## 用户身份权限

`lumen feishu scopes` 也会打印这份清单。扫码确认页和 `lumen feishu login` 申请的是同一组用户身份 scope。

续期：

- `offline_access` 刷新 user_access_token

云空间（全部文件和文件夹的搜索、列表、读取、创建、上传、下载、移动、删除）：

- `drive:drive` 查看、评论、编辑和管理云空间中所有文件
- `drive:drive.search:readonly` 搜索云文档
- `drive:drive.metadata:readonly` 文件元数据
- `drive:file` 上传和下载
- `drive:file:upload` 上传文件
- `drive:file:download` 下载文件
- `space:document:retrieve` 文件夹中的文件清单
- `space:document:move` 移动文件和文件夹
- `space:document:delete` 删除文件和文件夹
- `space:document:shortcut` 创建快捷方式
- `search:docs:read` 搜索用户有权限的云文档

新版文档 docx：

- `docx:document` 创建及编辑新版文档
- `docx:document:write_only` 编辑新版文档内容
- `docs:document.content:read` 读取文档内容
- `docs:document.media:upload` 上传文档中的图片和附件
- `docs:document.media:download` 下载文档中的图片和附件

旧版文档 doc：

- `docs:doc` 查看、评论、编辑和管理旧版文档

电子表格、多维表格：

- `sheets:spreadsheet` 查看、评论、编辑和管理电子表格
- `bitable:app` 查看、评论、编辑和管理多维表格

知识库：

- `wiki:wiki` 查看、编辑和管理知识库
- `wiki:space:retrieve` 知识空间列表
- `wiki:space:read` 知识空间信息
- `wiki:node:retrieve` 节点列表
- `wiki:node:read` 节点信息
- `wiki:node:create` 创建节点
- `wiki:node:update` 更新节点

思维笔记、画板、幻灯片：

- `mindnote:node:read` 读取思维笔记节点
- `mindnote:node:create` 创建思维笔记节点
- `board:whiteboard:node:read` 查看画板节点
- `board:whiteboard:node:create` 创建画板节点
- `board:whiteboard:node:update` 更新画板节点
- `board:whiteboard:node:delete` 删除画板节点
- `slides:presentation:read` 查看幻灯片
- `slides:presentation:write_only` 创建及编辑幻灯片

评论：

- `docs:document.comment:create` 添加评论
- `docs:document.comment:read` 获取评论
- `docs:document.comment:update` 修改评论
- `docs:document.comment:delete` 删除评论

协作者和分享设置：

- `docs:permission.member` 查看、新增、更新、删除协作者
- `docs:permission.member:create` 添加协作者
- `docs:permission.member:retrieve` 协作者列表
- `docs:permission.member:update` 更新协作者权限
- `docs:permission.member:delete` 移除协作者
- `docs:permission.setting` 查看和更新分享设置
- `docs:permission.setting:read` 查询分享设置
- `docs:permission.setting:write_only` 修改分享设置

思维笔记没有稳定的正文编辑接口。搜索和列表能看到思维笔记文件；scope 仍会申请。画板用 `lumen feishu board nodes` 读取节点。

## 登录态

```text
lumen feishu login --no-wait
lumen feishu login --device-code <code>
lumen feishu login --callback
lumen feishu status
lumen feishu logout
```

令牌在 `~/.config/lumen/feishu/session.json`，应用凭据在同目录的 `app.json`。目录权限 `700`，文件权限 `600`。访问令牌过期会用 refresh token 自动刷新。`status` 不打印令牌。`logout` 只删除登录态，不删除 App ID。

国际版租户在扫码结果里若是 Lark，后续请求改走 `open.larksuite.com`。

## 云盘

按名称搜索，结果含名称、类型、token、链接。类型可以是 `doc`、`sheet`、`slides`、`bitable`、`mindnote`、`file`。

```text
lumen feishu search 项目
lumen feishu search 排期 --type bitable
lumen feishu ls
lumen feishu ls <文件夹 token>
lumen feishu upload --file ./clip.mp4 --folder <文件夹 token>
lumen feishu download --token <文件 token> --to refs/clip.mp4
lumen feishu mkdir --name 素材
lumen feishu move --token <token> --type docx --folder <目标文件夹>
lumen feishu rm --token <token> --type file --yes
```

不带文件夹时，列表、上传和新建文件夹用该用户的云空间根目录。下载不覆盖已有文件。超过 20MB 的上传走分片接口，适合几百 MB 的视频。删除没有 `--yes` 不会发请求。

## 多维表格

token 用搜索结果里的 bitable token，不要等用户转发链接。

```text
lumen feishu bitable tables --app <app token>
lumen feishu bitable fields --app <app token> --table <table id>
lumen feishu bitable records --app <app token> --table <table id> --filter '{"conjunction":"and","conditions":[{"field_name":"状态","operator":"is","value":["完成"]}]}'
lumen feishu bitable create --app <app token> --table <table id> --fields '{"标题":"新行","关联":{"linkRecordIds":["recXXXX"]}}'
lumen feishu bitable update --app <app token> --table <table id> --record <record id> --fields '{"标题":"已改"}'
lumen feishu bitable attach --app <app token> --table <table id> --record <record id> --field 附件 --file ./clip.mp4
```

筛选条件原样传给记录搜索接口。关联字段读出来是 `linkRecordIds` 数组；写入时用这个对象，或直接写记录 id 数组。附件字段接受大文件，内部分片上传后再把 `file_token` 追加到该字段。`--fields-file`、`--filter-file` 可以改从文件读 JSON。

## 文档、表格、知识库

```text
lumen feishu doc create --title 纪要 --kind docx
lumen feishu doc get --token <document id>
lumen feishu doc write --token <document id> --text "第一段" --mode append
lumen feishu doc get --token <doc token> --kind doc
lumen feishu doc write --token <doc token> --kind doc --text "文末追加"
lumen feishu sheet info --token <spreadsheet token>
lumen feishu sheet get --token <spreadsheet token> --range "<sheetId>!A1:C10"
lumen feishu sheet put --token <spreadsheet token> --range "<sheetId>!A1:B2" --values '[["a",1],["b",2]]'
lumen feishu wiki spaces
lumen feishu wiki ls --space <space id>
lumen feishu wiki search 规范
lumen feishu wiki node --token <wiki token>
```

`--kind docx` 是新版文档，`--mode replace` 会清掉正文再写。`--kind doc` 是旧版文档，只在文末追加段落。电子表格的 range 必须带工作表 id，例如 `sheetId!A1:C10`。知识库节点结果里的 `objToken` 和 `objType` 才是底层文档的 token，wiki token 本身不能直接当 docx token。

## 评论、分享、画板

```text
lumen feishu comment list --token <token> --type docx
lumen feishu comment add --token <token> --type docx --text "看一下这里"
lumen feishu perm get --token <token> --type docx
lumen feishu perm members --token <token> --type docx
lumen feishu perm grant --token <token> --type docx --member <open id> --member-type openid --perm edit
lumen feishu perm share --token <token> --type docx --link tenant_readable --yes
lumen feishu board nodes --token <whiteboard token>
```

`--link` 可以是 `closed`、`tenant_readable`、`tenant_editable`、`anyone_readable`、`anyone_editable`。修改分享必须带 `--yes`。

## 怎么确认

单测不访问飞书。仓库里跑 `npm ci && npm run build && npm test`。

手工确认时：`lumen feishu setup` 完成后，`lumen feishu search <一个只存在于该用户云盘、没有转发过的表格名> --type bitable` 应返回名称、类型、token 和链接。接着 `lumen feishu bitable tables --app <该 token>` 应列出数据表。不需要用户把链接发过来。
