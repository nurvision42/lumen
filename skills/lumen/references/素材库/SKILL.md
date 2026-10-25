---
name: 素材库
description: 飞书多维表格里的共享素材库。跨对话复用人物、音色和供应商编号时再读。
---

# 素材库

素材库用来跨对话复用身份：人物原图、参考录音、克隆出来的音色编号，以及各供应商自己的素材编号。查找键是用户起的名字。项目里的镜头、参考片和成片仍留在项目文件夹，不要为了生成把它们搬进飞书。

没选素材库时，出图、出视频、语音照常进行。`list`、`find`、`add` 需要已经选好的 Base 和数据表。

连接要用户同意。不要在对话里索要或打印 App Secret、`user_access_token`、`refresh_token`。密钥和用户登录写在本机凭证目录，不写进项目的 `lumen.config.json`。

## 命令

```text
lumen library status
lumen library connect feishu [--reauthorize] [--create]
lumen library connect feishu --existing
lumen library connect feishu --app-id <id> --app-secret <secret> [--base-url <链接> | --app-token <token>] [--table-id <id>]
lumen library connect feishu --app-id <id> --app-secret <secret> --create
lumen library list
lumen library find <名称> [--type <类型>]
lumen library add --name <名称> --type <类型> [--person <人物>] [--provider <服务商>] [--account <账户>] [--external-id <编号>] [--file <原始文件>] [--note <备注>]
```

`lumen library clone-voice` 还没接上付费克隆。要克隆时用 `lumen fish clone`（kitta），成功后再用 `library add` 把音色编号登记进表。不要为了接克隆去挡住选 Base。

## 连接

默认一条路：运行 connect → 把打印出来的二维码图片发到对话里 → 用户用飞书手机扫描 → 手机上选择新建应用或绑定已有应用 → 如有第二张登录图再附上 → 再选已有 Base 或新建。这条路不填写 App ID，也不填写 App Secret。不要打开浏览器，也不要在终端里画二维码。不要自动新建多维表格。

**扫码（默认）。** 用户同意后运行 `lumen library connect feishu`，让命令保持运行。它把飞书官方应用授权二维码写成 PNG，并打印：

```text
step: app
qr: ~/.config/lumen/library/feishu-app-qr.png
```

`qr:` 后面是图片的绝对路径。把这张 PNG 发到对话里，让用户用飞书手机扫。扫完后手机上出现两个选择：

1. 新建应用
2. 绑定已有应用

这两个选择在手机上完成，不在本机网页上，也不用把 App ID 或 App Secret 打进命令。这一步申请下面整份租户权限，以及同一份用户权限。接着若打印 `step: user` 和另一条 `qr:`，那是用户登录图，再把它发到对话里，让同一个人扫码登录。登录后命令打印 `bases:` 列表（「我的空间」根目录和下一层文件夹）。把列表问用户，再把编号、Base 链接、app token，或 `create` 写进这条命令的标准输入。只有 `create` 或 `--create` 会创建 Base、名为「素材库」的数据表和下面的列，并把登录用户设为可管理（`full_access`，不是只读）。`--create` 跳过挑选。没选就停下，不会自动新建。

**已经拿着 App ID 和 App Secret 时（可选）。** 这不是绑定已有应用的默认办法。手机上的「绑定已有应用」不走这里。只有密钥已经在手、要直接写入本机时才用，例如自动化。`lumen library connect feishu --existing` 在标准输入里询问 App ID、App Secret 和 Base，密钥不会打印，也不要写进 shell 历史。自动化再用 `--app-id` 和 `--app-secret`。给出 Base 链接、app_token 或 table_id 时，只检查素材表、补上缺的表或缺的列，不改已有列的类型，不另建一个 Base。没给 Base 又没有 `--create` 就停下。`--create` 会先让用户登录（同样打印 `qr:` 图片），再把新 Base 建在该用户的云空间里。

`--reauthorize` 只给这台机器上已经扫码连接的应用再出一张二维码图片，补权限和密钥，并重新登录。不能拿它换成另一个应用。这台机器还没有保存应用时，换到另一个已有应用就再跑默认 connect，让用户在手机上选「绑定已有应用」。只有密钥已经在手时才用 `--existing` 或 `--app-id`。

选中的 Base 和 table 写在 `~/.config/lumen/library/feishu.json`（若设置了 `XDG_CONFIG_HOME`，则在其下的 `lumen/library/feishu.json`）。应用密钥和用户令牌在同目录的 `credentials/`。可以随时再执行 connect 切换。`status` 会报告是否已连接、table id，以及打码后的链接；不打印 app_token 和密钥。

读写优先用用户访问凭证，并用刷新凭证续期。刷新凭证失效后重新 connect。应用租户凭证只作为该应用已经能打开的 Base 的后备。

## 扫码申请的租户权限

新建应用、手机上绑定已有应用，以及 `--reauthorize`，共用这一份。不是只读。多维表格、数据表、字段、记录、高级权限角色按开放平台已有的名字申请创建、读取、更新、删除。视图没有单独的删除名，用 `base:view:read` 和 `base:view:write_only`。`bitable:app` 是 v1 的管理权限。

`drive:drive` 只覆盖该应用自己的云空间（列出、上传、管理），不能列出租户里未经文档授权的全部多维表格。开放平台没有这种租户范围。`wiki:wiki` 把知识库链接解析成里面的多维表格。`docs:permission.member:create` 添加协作者。`drive:file` 和 `docs:document.media:upload` 上传素材。

本机已有应用编号和密钥时，会读开放平台上该应用已配置的租户权限，并在扫码时并入下面的列表，避免把已经打开的权限缩掉。续接时如果缺下面任意一项，会再出一次二维码补齐。第一次扫码还没有密钥，只申请这一份。`--existing` 和 `--app-id` 不发送新的权限列表，沿用该应用在开放平台上已有的权限。

- `bitable:app`
- `base:app:create`
- `base:app:read`
- `base:app:update`
- `base:table:create`
- `base:table:read`
- `base:table:update`
- `base:table:delete`
- `base:field:create`
- `base:field:read`
- `base:field:update`
- `base:field:delete`
- `base:record:create`
- `base:record:read`
- `base:record:update`
- `base:record:delete`
- `base:view:read`
- `base:view:write_only`
- `base:role:create`
- `base:role:read`
- `base:role:update`
- `base:role:delete`
- `drive:drive`
- `drive:file`
- `docs:permission.member:create`
- `docs:document.media:upload`
- `wiki:wiki`

## 用户登录申请的权限

用户登录用同一套多维表格读写删改，外加 `space:document:retrieve`（只列该用户自己的云空间文件夹）和 `offline_access`（换刷新凭证）。同样不是只读。用户列表里没有 `drive:drive`。

- `offline_access`
- `bitable:app`
- `base:app:create`
- `base:app:read`
- `base:app:update`
- `base:table:create`
- `base:table:read`
- `base:table:update`
- `base:table:delete`
- `base:field:create`
- `base:field:read`
- `base:field:update`
- `base:field:delete`
- `base:record:create`
- `base:record:read`
- `base:record:update`
- `base:record:delete`
- `base:view:read`
- `base:view:write_only`
- `base:role:create`
- `base:role:read`
- `base:role:update`
- `base:role:delete`
- `space:document:retrieve`
- `drive:file`
- `docs:permission.member:create`
- `docs:document.media:upload`
- `wiki:wiki`

扫码用户被授予可管理（`full_access`）。若多维表格开了高级权限，lumen 会尝试把登录用户加入名为「lumen 素材库」、可编辑记录和字段的角色。应用身份不能通过接口加入该角色。若删除数据表或记录仍被拒绝，让用户在表格右上角「…」→「…更多」→「添加文档应用」，把应用加到可编辑记录和字段的角色。

## 表

表名是「素材库」。绑定已有 Base 时，有同名表就用它；指定了 table_id 就用那张表。缺表才在这个 Base 里建表。缺列才加列。列已经存在但类型不对就停下，不改类型，不新建第二个 Base。

| 列 | 类型 |
| --- | --- |
| 名称 | 文本 |
| 类型 | 文本 |
| 人物 | 文本 |
| 服务商 | 文本 |
| 账户 | 文本 |
| 服务商编号 | 文本 |
| 文件指纹 | 文本 |
| 原始文件 | 附件 |
| 状态 | 文本 |
| 备注 | 文本 |

名称是查找键，比较时忽略首尾空白和大小写。一条记录上的服务商编号只配合同一条里的服务商和账户使用。状态不是「可用」，或没有服务商编号，就不要拿去生成。

## 查找和登记

先 `lumen library find "<名称>"`。同名多条时加上 `--type`，例如 `音色` 或 `人物`，必要时让用户确认。`list` 用来回忆有哪些名字。

登记已有素材：

```text
lumen library add --name <名称> --type <类型> --provider <服务商> --account <账户> --external-id <编号> --file <原始文件>
```

文件和编号都可以缺。同名、同类型、同服务商、同账户的记录已存在时，不会覆盖旧编号。

音色：先 find。没有可用记录时，向用户要名字和参考录音，用 `lumen fish clone` 克隆，再把返回的编号 `library add --type 音色 --provider kitta`。不要在飞书记录还是「创建中」时再克隆一次。
