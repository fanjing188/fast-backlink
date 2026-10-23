# 安装与维护

第一次使用按 [README](../README.md#第一次使用) 操作。本页只补充安装参数、升级和排错。

下面用 `backlink-kit` 简写命令；终端找不到它时，使用安装输出的完整路径，默认是 `~/.local/bin/backlink-kit`。

## 终端安装脚本

```sh
curl -fsSL https://raw.githubusercontent.com/fanjing188/fast-backlink/main/scripts/setup.sh | sh
```

一键安装仅支持 macOS，浏览器使用 Edge / Chrome 116+。不需要 Git、Node 或 AI 账号；缺少 Python 3.11+ 时，通过 [uv 官方安装器](https://docs.astral.sh/uv/reference/installer/) 准备独立 Python。运行时放在安装目录旁的 `-runtime` 目录，不修改系统 Python、PATH 或 shell 配置，也不注册常驻系统服务。

已有源码时可指定参数：

```sh
sh scripts/setup.sh --prefix /path/to/app --bin-dir /path/to/bin
sh scripts/setup.sh --managed-python --no-open
sh scripts/setup.sh --version v1.0.3
```

`--managed-python` 强制使用独立运行时；`--no-open` 不打开浏览器。`--version` 下载指定正式 Release；默认在线安装使用最新正式版。在项目目录执行脚本时，默认使用该目录的源码。

已有 Python 的开发者仍可直接用 `PYTHON=/path/to/python3.11 sh scripts/install.sh`。底层安装器保留原有命令，不自动下载依赖。

## 文件位置

| 内容 | 默认位置 |
|---|---|
| 命令 | `~/.local/bin/backlink-kit` |
| 配置 | `~/.local/share/backlink-kit/config.json` |
| 产品、素材及投稿记录 | `~/.local/share/backlink-kit/data/` |
| 浏览器扩展 | `~/.local/share/backlink-kit/extension` |
| 自动准备的独立运行时 | `~/.local/share/backlink-kit-runtime/` |

脚本会识别命令目录中已有的受管安装，复用其原目录。显式传入 `--prefix` 时使用指定目录；不会接管其他程序目录。以安装输出或 `backlink-kit doctor` 的结果为准。

## 启动与产品

`backlink-kit start` 在前台运行，Ctrl+C 停止。端口被其他程序占用时用 `backlink-kit start --port 18781`，或 `--port 0` 分配空闲端口。换端口后重新保存扩展连接地址，不停止未知进程。

用 `backlink-kit kits new myproduct --url https://myproduct.com/` 登记新产品，再在素材库补充介绍和图片。服务启动后新增产品，需重启服务载入产品列表。AI 默认关闭，需要时在侧栏“设置”测试并保存。

一个本机服务只连接一个执行浏览器，避免多个扩展竞争领取任务。连接地址含令牌，请只保存到自己的扩展中。

## 更新、回滚与卸载

更新前完成当前操作、存档待处理表单，并在服务终端按 Ctrl+C。重新运行一键安装命令即可更新程序，个人配置和资料保留。

需要固定来源或回退时：

```sh
backlink-kit update --repo https://github.com/fanjing188/fast-backlink.git --ref v1.0.3
backlink-kit rollback
```

`update` 的 Git 来源方式需要 Git；在线安装脚本不需要。也可用 `backlink-kit update --source /path/to/source`。更新和回滚后都需重载浏览器扩展，再启动服务；回滚只回退代码。数据迁移另行先备份并运行 `--dry-run`。

1.0.0 的 `current/extension` 会被浏览器固定到旧发布目录。升级后停用旧扩展，从新的固定目录加载一次并保存原连接地址。旧扩展的设置和快照可保留；后续更新只需重载新版扩展。

`backlink-kit uninstall --yes` 移除程序和命令，保留配置、令牌与 data。浏览器扩展另行移除；若使用独立运行时，确认不再需要后可删除对应 `-runtime` 目录。

## 常见问题

| 现象 | 处理 |
|---|---|
| 下载失败 | 确认能访问 GitHub 和 astral.sh，再重试 |
| 提示 busy | 先停止本服务，再更新；不要同时运行两个安装过程 |
| 浏览器连不上 | 检查服务仍在运行，重新保存完整连接地址 |
| 新产品没出现 | 重启服务，再刷新素材库 |
| 更新后界面没变化 | 核对扩展加载位置，重载固定目录中的版本 |
| 摘要不匹配 | 重新下载正式包，不绕过校验 |

Linux 浏览器链路未验；原生 Windows、Firefox 和 Safari 不支持。
