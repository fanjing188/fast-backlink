# 安装、更新与卸载

## 支持范围

- Python 3.11+，仅标准库。普通使用不需要 Node、npm、Hermes 或云端账号。
- 本轮安装、更新、卸载及浏览器链路在 macOS 实测。Linux 的 Unix 安装入口可用，但 Linux 浏览器完整链路未验；不把它写成已支持的正式平台。
- 浏览器需要支持 `sidePanel` 的 Chrome / Edge，扩展声明最低 Chromium 116。原生 Windows、Firefox、Safari 不支持；WSL 与 Windows 浏览器互联也未验。
- 从 Git 更新需要 Git。可选 AI 要由用户自行配置兼容接口与密钥；默认关闭。

## 1. 一条命令安装程序

进入下载并解压的项目目录，或你自行 clone 的项目目录：

```sh
sh scripts/install.sh
```

指定 Python：

```sh
PYTHON=/absolute/path/to/python3.11 sh scripts/install.sh
```

启动命令记录本次使用的Python绝对路径。个人安装应选择长期保留的解释器，不要使用将被清理的临时虚拟环境。

安装为当前用户所有，不用 sudo，不修改 shell 配置、浏览器配置、launchd 或系统服务。默认目录：

| 内容 | 位置 |
|---|---|
| 命令 | `~/.local/bin/backlink-kit` |
| 安装标记、个人配置 | `~/.local/share/backlink-kit/` |
| 程序版本 | `~/.local/share/backlink-kit/releases/<摘要>/` |
| 稳定程序入口 | `~/.local/share/backlink-kit/current/` |
| 来源、产品资料、存档等资产 | `~/.local/share/backlink-kit/data/` |

若命令不在 PATH，当前终端执行 `export PATH="$HOME/.local/bin:$PATH"`，或直接使用 `~/.local/bin/backlink-kit`。是否写入 shell 配置由你决定。

自定义目录（可包含空格）：

```sh
sh scripts/install.sh --prefix "$HOME/Apps/fast-backlink" --bin-dir "$HOME/bin"
```

安装器拒绝接管非本项目目录或覆盖其他程序的同名命令。代码从白名单复制，不复制工作区的 `config.json`、真实产品包、台账、日志、历史截图或个人学习数据。

## 2. 自检和启动本机服务

```sh
backlink-kit doctor
backlink-kit start
```

`doctor` 核对当前程序的逐文件摘要与安装路径，不启动服务。`start` 前台运行，终端会输出本机连接地址；Ctrl+C 停止。关闭终端后服务不会自动常驻。地址含访问令牌，不要粘到公开 Issue 或截图里。

端口冲突时不要杀掉未知进程，改用 `backlink-kit start --port 18781`；`--port 0` 选择空闲端口。更换端口后需要重新保存扩展连接地址。

## 3. 手动安装浏览器扩展

这是浏览器的安全确认步骤，脚本不会代你绕过：

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发者模式。
2. 选择“加载解压缩的扩展”，目录为 `~/.local/share/backlink-kit/current/extension`。自定义安装以 `doctor` 输出为准。
3. 打开扩展选项，粘贴 `backlink-kit start` 输出的完整本机地址，保存并确认服务连通。
4. 将扩展固定到工具栏，打开侧栏。

扩展需要与服务在同一台机器使用。不支持把本机令牌服务暴露到公网。

## 4. 添加你自己的产品

```sh
backlink-kit kits new myproduct
backlink-kit kits check
```

初次安装没有产品或外链来源列表，不会附带作者的私有资产。`kits new` 只创建空模板并登记产品，不会编造资料。编辑 `data/kits/myproduct/kit.json`、补充 `assets/`，并在安装目录的 `config.json` 填写该产品的真实 `domain`。用扩展选项页管理具体文本和素材；缺项检查未通过时先补齐再投。

## 5. 一键更新和回滚

先在运行服务的终端按 Ctrl+C，等当前动作结束；关闭待提交页面或先存档。

```sh
backlink-kit update
```

安装时若发现公开 HTTPS `origin`，更新会从已登记仓库的 `main` 下载并校验候选；可用 `--ref <tag>` 固定分支或发布标签。没有上游地址的源码包会重新读取安装时登记的本地源码目录。该目录已删除时，必须显式给 `--source` 或 `--repo`，不能假称已取得最新版。

```sh
backlink-kit update --source /path/to/new/source
backlink-kit update --repo https://github.com/fanjing188/fast-backlink.git --ref main
backlink-kit rollback
```

公开源码入口为 `https://github.com/fanjing188/fast-backlink`。只有显式指定仓库或安装时已登记上游，更新才会从网络取得源码；`--source` 只读取所指本地目录。

更新在新版本目录准备代码，先实际检查 CLI，再原子切换 `current`，并保留上一版本供回滚。下载或验证失败不切换，不更新配置、资料包或资产。运行中更新/卸载会被锁拒绝。回滚只回退代码，不回退数据。

**更新或回滚后仍要**在扩展管理页点击“重新加载”，并重新运行 `backlink-kit start`。脚本不会自动刷新用户浏览器。

也可从新源码目录执行 `sh scripts/update.sh`，自定义前缀带上 `--prefix`。本轮代码没有新增自动数据迁移。

## 6. 一键卸载，默认保留资产

```sh
backlink-kit uninstall --yes
# 或从源码目录
sh scripts/uninstall.sh --yes
```

删除本安装拥有的命令和程序版本，**保留 config.json、令牌和 data/**，重新安装可继续使用。没有 `--yes` 时需交互输入 uninstall；非交互环境默认拒绝。不会操作别的 Python、Node、Hermes、浏览器配置或系统服务。

浏览器扩展需你在扩展管理页手动移除。若还要删除产品资料和台账，先单独备份并自行处理；卸载脚本没有自动删除业务数据的选项。

## 故障排查

- Python 太旧/找不到：安装 3.11+，或使用 `PYTHON=...` 明确指定；脚本不下载解释器。
- `busy`：服务尚未停止，或有另一个管理操作；先完成当前任务再重试。
- 连接失败：确认 start 仍运行、地址及端口正确；不要公开访问令牌。
- 当前代码摘要不符：保留现场，重新从可信源码更新；不要绕过校验。
- 版本更新后路由仍旧：重启服务并手动重载扩展，两端都需更新。
