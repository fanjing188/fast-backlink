# Fast-Backlink Agent CLI

`bk.py fb` 是给 Agent 用的标准命令行接口：一条命令驱动浏览器里的 Fast-Backlink 扩展，
完成打开页面、整页填写、复原快照、记住表单、读取状态、标记完成等动作。
所有命令只输出 JSON，不交互、不点最终提交。

## 它怎么工作

```text
Agent / shell
  └─ backlink-kit fb <动作>
       └─ 本机服务 127.0.0.1:<port>/<令牌>/api/agent/*
            ├─ 数据命令直接读服务（queue/logs/report/settings…）
            └─ 页面命令进入命令队列
                 └─ 扩展 service worker 长轮询 api/agent/next（20 秒）
                      └─ 内容脚本执行 page:fill / page:snapshot / page:remember…
                           └─ api/agent/result 回传；alarms 每 30 秒兜底唤醒
```

先按[安装说明](INSTALLATION.md)完成用户级安装及浏览器手动确认。启动本机前台服务：

```sh
backlink-kit start
```

终端保持运行，Ctrl+C停止。输出的连接地址含令牌，用户只在扩展选项内保存，不公开分享。本文命令使用已安装的backlink-kit；源码开发可改用 `python3 bk.py --config /path/to/config.json`，不要读取作者的个人配置作为公共示例。

## 先自检

```sh
backlink-kit fb status
backlink-kit fb tabs
```

`status` 会同时返回：

- `service`：本机服务是否可达（只显示 host/port，不回显令牌）；
- `extension`：扩展是否连接、是否在长轮询、版本、最后心跳秒数；
- `active`：当前活动页的项目、来源、已填/待确认/未匹配/验证码计数。

扩展休眠时 `connected` 可能短暂为 `false`；发页面命令后 alarms 会把它叫醒。

## 常用命令

### 打开并填写

```sh
backlink-kit fb open https://source.example/submit --site myproduct
backlink-kit fb open --item <续填项ID>
backlink-kit fb open https://source.example/submit --no-fill
```

`open` 会复用已打开的同一 URL，否则新开标签页，然后建立项目会话并填整页。
返回 `tab`、`site`、`source`、`counts`、`pending`、`decisions`、`frames`。

### 填当前页 / 指定页

```sh
backlink-kit fb fill                              # 当前活动标签页
backlink-kit fb fill --url https://source.example/submit --force
backlink-kit fb fill --tab 12345 --site myproduct
backlink-kit fb fill --item <续填项ID> --open
```

不带 `--force` 时保留页面上已有的人工值；`--force` 重新覆盖。
脚本不会点击 Next 或最终提交；多步表单的自动下一步仍受扩展设置控制。

### AI 兜底

```sh
backlink-kit fb ai --url https://source.example/submit --site myproduct
backlink-kit fb ai --url https://source.example/submit --site myproduct --apply
backlink-kit fb ai --url https://source.example/submit --site myproduct --apply --min-conf 0.8
```

- 需要本机 `config.json` 的 `ai.enabled` 已开，并配置 `base_url`、`model` 和密钥；`fb state` 的 `page.ai` 也能看到当前建议。
- 不带 `--apply` 只返回建议，不写页面；`--apply` 把置信度达标的建议填入，默认阈值 0.9。
- 返回 `result.suggestions`（`i/key/conf/label/display/frameId`）和 `result.applied`（`filled/skipped`）；`ai.suggestions` 是页面级聚合列表。
- 它和侧边栏“AI 兜底”走同一条 `page:ai` 路径，不会点击提交。

### 查看字段结果

```sh
backlink-kit fb state --url https://source.example/submit
backlink-kit fb steps --url https://source.example/submit
```

- `state`：整页计数、每个字段的 `status`（filled/pending/unmatched/captcha/honeypot/sensitive）、
  `key`、置信度和当前值。
- `steps`：当前页的步骤配方，便于判断是否录完整。

### 快照

```sh
backlink-kit fb snapshot --url https://source.example/submit --output runs/snapshot.json
backlink-kit fb restore --url https://source.example/submit
backlink-kit fb restore --url https://source.example/submit --snapshot runs/snapshot.json
```

`snapshot` 会同时写扩展 IndexedDB 和本机 `snapshots/`；`--output` 另外保存一份给 Agent 读取。

### 记住与完成

```sh
backlink-kit fb remember --url https://source.example/submit --site myproduct
backlink-kit fb done <续填项ID>
backlink-kit fb done <续填项ID> --open
backlink-kit fb skip <续填项ID> --reason "需要登录"
```

- `remember` 把页面上非敏感字段写回来源库并参与学习；密码、验证码、支付信息不落盘。
- `done` 只记“待核实”和完成回执，不写 ledger、不算 submitted；提交动作始终由人完成。
- `done` 默认要求页面已打开；加 `--open` 可按续填项地址新开页面再读回。
- `skip` 直接写本机服务，不依赖扩展在线。

### 队列、日志、周报

```sh
backlink-kit fb queue --site myproduct
backlink-kit fb logs --days 1 --level warn
backlink-kit fb report --days 7
backlink-kit fb settings
backlink-kit fb settings --set auto_next=false --set log_level=debug
```

日志每 5 秒批量落盘一次；刚填完立即读可能还是空的，稍等再查。
`queue` 默认只列待处理/待授权/待人工，与列表页一致。

### 通用调用

```sh
backlink-kit fb call fill --args '{"url":"https://source.example/submit","site":"myproduct","force":true}'
backlink-kit fb call queue --args '{"site":"myproduct"}'
backlink-kit fb cancel <command_id>
```

`call` 是给新动作或脚本化流程留的入口；动作白名单：
`status/tabs/open/fill/ai/restore/remember/snapshot/steps/state/activate/done/skip`，
数据动作直接读服务：`health/sites/kits/queue/logs/report/snapshots/settings/profile`。

## 输出与退出码

成功时 stdout 只有一个 JSON 对象；失败时 stderr 是一个 JSON 错误对象，stdout 为空。

```json
{"ok":false,"error":"extension_unavailable","message":"Fast-Backlink 扩展没有响应",
 "hint":"在 Edge 打开扩展选项，确认续填列表地址；扩展每 30 秒自动重连"}
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 命令执行失败或服务拒绝 |
| 2 | 参数/配置错误 |
| 3 | 本机服务不可达或找不到地址 |
| 4 | 扩展未连接/未响应 |
| 5 | 扩展在 `--wait` 内没有执行完 |

`--pretty` 输出缩进 JSON；`--service` 或环境变量 `BK_HANDOFF_URL` 可覆盖服务地址。
`--wait` 默认 60 秒，服务端上限 180 秒。

## Agent 推荐流程

```sh
# 1. 自检
backlink-kit fb status

# 2. 打开并填表
backlink-kit fb open "$SUBMIT_URL" --site myproduct --wait 90

# 3. 看还剩什么
backlink-kit fb state --url "$SUBMIT_URL" --wait 30

# 4. 需要人处理验证码/未匹配字段；不要点提交
# 5. 人提交后，记录完成
backlink-kit fb done "$ITEM_ID"
```

对 Agent 来说，判断成功至少要看：

- `ok === true`；
- `counts.total > 0`（页面真的扫到了表单）；
- `pending === 0` 才算自动部分完成；否则把 `decisions` 里非 `filled` 的字段交给人工。

## 边界

- 只连 `127.0.0.1`，地址必须带令牌；CLI 不回显令牌。
- 本机服务只接受扩展请求或带 `X-Fast-Backlink: 1` 的本地请求；普通网页无法调用命令通道。
- 页面动作白名单在服务端和扩展侧各校验一次；不会执行任意脚本。
- 扩展不读取/不保存密码、验证码、支付信息；蜜罐字段不填；最终提交、Next 按钮受原有规则限制。
- CLI 超时会取消仍在排队的命令；已经 `running` 的动作可能继续完成，结果以扩展回执为准。
- 一个本机服务只设一条命令消费通道；同时开多个浏览器扩展时，命令由最先轮询到的实例执行。
