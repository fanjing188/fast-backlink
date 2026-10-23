# CLI 参考

先按 [快速开始](../README.md#快速开始) 安装并连接浏览器。`backlink-kit start` 前台运行，保留终端；下面的命令在另一个终端执行。CLI 输出 JSON，不需要交互提示。

单页命令只填写；**显式启动的批量任务会自动提交**。Agent 只能在用户明确授权的产品与平台范围内启动批量任务。

## 连接与资料

```sh
backlink-kit doctor
backlink-kit fb status
backlink-kit fb tabs
backlink-kit kits new myproduct
backlink-kit kits check
backlink-kit fb queue --site myproduct
```

`status` 返回本机服务、扩展连接/版本及活动页的填写计数，不回显连接令牌。`kits new` 创建空产品；补齐配置中的域名后重启服务，再编辑素材和身份。`kits check` 只读检查，缺项时退出码为 1。

## 单页填写

```sh
backlink-kit fb open https://source.example/submit --site myproduct
backlink-kit fb open --item <续填项ID>
backlink-kit fb open https://source.example/submit --no-fill
backlink-kit fb fill --tab 12345 --site myproduct
backlink-kit fb state --url https://source.example/submit
backlink-kit fb steps --url https://source.example/submit
```

同一 URL 已打开时优先复用标签页。默认保留人工值；只有明确需要覆盖时才加 `--force`。结果检查 `counts`、`pending`、`decisions` 和 `frames`，不能只凭 `ok: true` 认定表单完整或投稿成功。

## AI 智能填充

在侧栏“设置”配置并保存可选 AI 接口，或使用自己的高级配置。默认不开启 AI。

```sh
backlink-kit fb ai --url https://source.example/submit --site myproduct
backlink-kit fb ai --url https://source.example/submit --site myproduct --apply --min-conf 0.9
```

CLI 不加 `--apply` 只返回建议；加上后应用达到阈值的安全字段，不覆盖人工值。侧栏的一次点击直填是另一个显式入口，不改变 CLI 的建议合同。两者都不点击最终提交。

## 批量投稿

```sh
backlink-kit fb batch start --site myproduct --domains first.example,second.example --batch-size 10
backlink-kit fb batch status
backlink-kit fb batch status <批次ID>
backlink-kit fb batch stop <批次ID>
```

先在“外链库”查看资格预览，再启动已授权任务。服务会重新筛选平台，排除同产品已投、结果未知和处理中记录。登录、验证、付款或缺资料转待人工；停止不抹掉已尝试的提交事实，未知结果不自动重投。平台收稿与公开外链分开核验。

## 快照与人工交接

```sh
backlink-kit fb snapshot --url https://source.example/submit --output runs/snapshot.json
backlink-kit fb restore --url https://source.example/submit
backlink-kit fb remember --url https://source.example/submit --site myproduct
backlink-kit fb done <续填项ID>
backlink-kit fb skip <续填项ID> --reason "暂不处理"
```

快照保存安全字段和素材 ID/摘要；密码、验证码、支付与授权勾选不保存。长期存档从侧栏“存档待验证”进入任务列表。`done` 用于人工提交后的读回与待核实记账，不代替提交，也不当作外链已公开。`skip` 保留历史，不解锁已有未知提交。

## 日志与配置

```sh
backlink-kit fb logs --days 1 --level warn
backlink-kit fb report --days 7
backlink-kit fb settings
backlink-kit fb settings --set auto_next=false --set log_level=debug
backlink-kit assets export --output "$HOME/backlink-assets.zip"
```

日志批量落盘，刚完成操作时可能稍有延迟。资产备份含自己的私有资料，不要上传到公开仓库。

## 调用边界与错误

- `--pretty` 格式化 JSON；页面命令支持 `--wait`，服务端最多等待 180 秒。
- `--service` 或 `BK_HANDOFF_URL` 可指定本机令牌地址。只连接 `127.0.0.1`，本机 API 要求扩展来源或专用请求头。
- `fb call <动作> --args '{...}'` 复用已注册动作；`fb cancel <command_id>` 取消排队命令，不执行任意脚本。
- 超时不代表动作未执行：已运行的动作可能完成，先读回，不重复提交。
- 一个本机服务只连接一个执行浏览器，避免多个扩展竞争领取任务。

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 执行失败或服务拒绝 |
| 2 | 参数/配置错误 |
| 3 | 服务不可达或找不到地址 |
| 4 | 扩展未连接或未响应 |
| 5 | 等待执行超时 |

`fb` 成功在 stdout 输出 JSON，失败在 stderr 输出 JSON。源码开发可使用 `python3 bk.py --config /path/to/config.json`，不要使用作者的个人配置作为示例。
