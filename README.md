<img src="extension/icons/mark.svg" width="64" height="64" alt="Fast-Backlink">

# Fast-Backlink

在本机保存产品资料，填写外链表单，管理批量投稿和待人工任务。

支持 macOS、Python 3.11+、Chrome / Edge 116+。基础功能不需要 Node、Hermes 或 AI 账号。界面以中文为主。

## 快速开始

### 1. 安装并启动

从 [Release](https://github.com/fanjing188/fast-backlink/releases/latest) 下载源码包并解压，或使用 Git：

```sh
git clone https://github.com/fanjing188/fast-backlink.git
cd fast-backlink
sh scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
backlink-kit doctor
backlink-kit start
```

使用下载包时，在解压后的项目目录从 `sh scripts/install.sh` 开始执行。

如果系统默认 Python 低于 3.11，用 `PYTHON=/你的/python3.11/路径 sh scripts/install.sh` 指定已安装的解释器。`start` 前台运行，使用期间保留终端；按 Ctrl+C 停止。

### 2. 连接浏览器

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发者模式。
2. 选择“加载解压缩的扩展”，加载 `~/.local/share/backlink-kit/extension`。自定义安装路径看 `doctor` 输出。
3. 打开扩展选项，保存 `start` 输出的完整本机连接地址，再打开侧栏。

连接地址含访问令牌，只保存在自己的扩展中，不要公开分享。

### 3. 添加产品

另开终端：

```sh
backlink-kit kits new myproduct
```

`myproduct` 是自定的产品标识。在 `doctor` 给出的 `config.json` 中填写该产品的真实 `domain`，然后在服务终端按 Ctrl+C，再运行 `backlink-kit start` 载入产品列表。

在扩展“素材库”中补齐名称、网址、介绍和图片，在“身份档案”中保存投稿署名与联系方式。用 `backlink-kit kits check` 检查缺项，补齐后再投。新装的产品库和平台库为空，不附带作者的私有资料。

### 4. 填写第一张表单

打开允许提交的外链平台，在侧栏选择产品，点击“一键填写”。核对内容后自行提交。AI 可选：在“设置”中配置接口、模型和密钥，测试连通并保存，再点击“AI 智能填充”。

项目选择会保存；已有任务仍使用自己的产品绑定。缺失资料、验证码、密码、支付信息与授权确认由你处理。

## 日常使用

| 你要做的事 | 操作 |
|---|---|
| 添加平台 | 打开“外链库”，新增平台或导入 CSV/TXT |
| 批量投稿 | 选产品、筛选并勾选合格平台，检查预览后启动批量任务 |
| 稍后处理验证 | 存档待人工，随后从任务列表打开并复原 |
| Google 登录后继续 | 对当前平台授权登录接续；首次授权、密码和验证码由你完成 |
| 备份自己的资料 | `backlink-kit assets export --output "$HOME/backlink-assets.zip"` |

**批量模式会自动点击最终提交。** 单页“打开并填写”只填表。批量任务遇到登录、验证、付款或缺资料会转人工；结果未知时不会自动重投。平台收稿不等于外链已公开或被收录。

## 更新与回滚

先停止服务，再执行 `backlink-kit update`；回退使用 `backlink-kit rollback`。两种操作后都要在浏览器扩展管理页手动重新加载扩展，并重新启动服务。更新保留个人配置、产品资料和业务记录。

从 1.0.0 升级（包括回退到它后再更新）时，用新版下载包中的 `sh scripts/update.sh --prefix 你的安装目录` 完成更新。随后停用旧扩展，从 `doctor` 给出的固定目录加载一次；以后在新扩展上点击“重新加载”即可。

## 文档

- [安装、配置与故障排查](docs/INSTALLATION.md)
- [扩展操作](extension/README.md) · [能力与限制](docs/CAPABILITIES.md)
- [CLI](docs/fast-backlink-cli.md) · [开发与测试](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md) · [安全说明](SECURITY.md)

作者：[fanjing188](https://github.com/fanjing188)。本项目采用 [MIT](LICENSE)；第三方代码的必要许可见 [NOTICE](NOTICE)。问题请提交到 [Issues](https://github.com/fanjing188/fast-backlink/issues)，不要附带密钥、连接令牌或私有资料。
