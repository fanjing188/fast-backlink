# 安装与维护

首次使用按 [快速开始](../README.md#快速开始) 完成安装、浏览器连接和产品创建。

## 运行环境

- macOS、Python 3.11+、Chrome / Edge 116+。
- 基础功能只用 Python 标准库；Node 和 Playwright 仅用于开发测试。
- Linux 浏览器链路未验；原生 Windows、Firefox 和 Safari 不支持。
- 安装脚本使用当前用户权限，不请求 sudo，不改 shell、浏览器策略或系统服务。

指定已安装的长期 Python 路径：

```sh
PYTHON=/path/to/python3.11 sh scripts/install.sh
```

## 文件位置

| 内容 | 默认位置 |
|---|---|
| 命令 | `~/.local/bin/backlink-kit` |
| 配置 | `~/.local/share/backlink-kit/config.json` |
| 产品及业务记录 | `~/.local/share/backlink-kit/data/` |
| 浏览器扩展 | `~/.local/share/backlink-kit/extension` |

自定义安装使用 `sh scripts/install.sh --prefix /path/to/app --bin-dir /path/to/bin`。以 `backlink-kit doctor` 输出的实际路径为准；安装器拒绝接管其他程序目录。

## 启动与配置

`backlink-kit start` 在前台运行，Ctrl+C 停止。端口占用时用 `backlink-kit start --port 18781` 或 `--port 0`；换端口后重新保存扩展连接地址，不停止未知进程。

新增产品或修改产品域名后，重启服务载入产品列表。产品文本、图片和身份在素材库编辑。AI 默认关闭；在侧栏“设置”保存接口、模型和密钥，先用“测试连通”验证草稿，再保存配置。

一个本机服务只连接一个执行浏览器，避免多个扩展竞争领取任务。连接地址含令牌，不要公开分享。

## 更新与回滚

先等当前操作结束，存档待处理表单，并停止服务：

```sh
backlink-kit update
# 固定到1.0正式标签：
backlink-kit update --repo https://github.com/fanjing188/fast-backlink.git --ref v1.0.1
# 回退程序：
backlink-kit rollback
```

更新从已登记 Git 上游或本地源码读取，也可显式指定 `--repo` 或 `--source /path/to/source`。新程序检查通过后原子切换，失败时保留旧版。更新不覆盖配置和业务资料；回滚只回退代码。数据迁移应先备份并运行迁移脚本的 `--dry-run`，与程序更新分开核实。

**两种操作后都要手动重新加载浏览器扩展，再启动服务。** 安装脚本不会代替浏览器的安全确认。

1.0.0 使用的 `current/extension` 会被浏览器固定到旧发布目录。从该版本升级（包括回退到它后再更新）须使用新版下载包中的 `sh scripts/update.sh --prefix 你的安装目录`，让新版安装器同步固定目录。随后停用旧扩展，从 `doctor` 显示的目录加载一次；此后更新和回滚只需重新加载。个人资料仍在本机服务中，旧扩展的浏览器设置和快照可保留。

## 卸载与排错

`backlink-kit uninstall --yes` 移除本安装的程序和命令，保留配置、令牌与 data；浏览器扩展另行手动移除。

| 现象 | 处理 |
|---|---|
| Python 版本低或找不到 | 用 `PYTHON=...` 指定已安装的 3.11+ |
| 提示 busy | 完成当前操作并停止本服务后重试 |
| 浏览器连不上 | 检查服务仍在运行、地址完整及端口一致 |
| 新产品未出现 | 保存域名后重启服务，再刷新素材库 |
| 更新后仍是旧界面 | 重载扩展并重启本机服务，两端都要更新 |
| 程序摘要不符 | 保留现场，从可信源码重新更新，不绕过校验 |
