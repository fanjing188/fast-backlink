<img src="extension/icons/mark.svg" width="64" height="64" alt="Fast-Backlink">

# Fast-Backlink

**把你的网站资料填进产品目录和收录平台的投稿表单，并记清楚哪些已投、哪些还需要处理。**

适合同时运营多个网站、经常重复填写名称、网址、介绍和图片的开发者。资料录一次，之后在浏览器里选择产品即可复用。

| 你要做的事 | Fast-Backlink 怎么帮你 |
|---|---|
| 给网站提交收录 | 用保存的产品资料填写当前表单 |
| 管理很多投稿平台 | 在外链库筛选平台、查看不同产品的投递记录 |
| 集中处理一批平台 | 明确启动批量任务后，填写并提交可确认的投稿表单 |
| 卡在登录或验证 | 保存待人工任务，稍后打开并复原 |

普通“一键填写”只填表，由你核对后提交。**批量模式会自动提交**；登录、验证码、付款、缺资料或无法确认的表单会转人工。平台收稿与外链已公开分别记录。

## 一条命令安装

目前支持 **macOS + Edge / Chrome**。不需要先安装 Git、Node、Hermes 或配置 AI。

打开终端，执行：

```sh
curl -fsSL https://raw.githubusercontent.com/fanjing188/fast-backlink/main/scripts/setup.sh | sh
```

脚本下载正式 Release、核对摘要并安装到你的用户目录。已有 Python 3.11+ 就直接使用；没有则准备独立运行时。不会修改系统 Python 或 shell 配置。已有安装会自动复用，保留产品资料和记录。

已经下载源码包或克隆仓库，直接在项目目录执行：

```sh
sh scripts/setup.sh
```

浏览器会打开扩展管理页。首次加载扩展仍需你手动确认，具体操作见下面第 3 步。

## 第一次使用

### 1. 创建一个产品

把 `myproduct` 和网址换成你的产品：

```sh
~/.local/bin/backlink-kit kits new myproduct --url https://myproduct.com/
```

这会登记网址和域名，不需要手动编辑配置。新安装的产品库和平台库为空，不包含作者的私有资料。

### 2. 启动本机服务

```sh
~/.local/bin/backlink-kit start
```

保留这个终端窗口，使用期间服务需要运行；按 Ctrl+C 停止。终端会显示一条完整的本机连接地址。

### 3. 连接浏览器扩展

1. 在 `edge://extensions` 或 `chrome://extensions` 开启开发者模式。
2. 点击“加载解压缩的扩展”，选择安装完成时显示的目录，默认是 `~/.local/share/backlink-kit/extension`。
3. 打开 Fast-Backlink 的扩展选项，粘贴服务输出的完整地址，点击“保存连接”。

连接地址含本机访问令牌，不要公开分享。自定义安装目录以安装脚本输出为准。

### 4. 填好资料，提交第一张表单

在扩展“素材库”补齐产品名称、介绍和图片，在“身份档案”保存署名与联系方式。然后打开允许投稿的平台，在侧栏选择产品，点击“一键填写”，核对后自行提交。

想批量处理时，再进入“外链库”添加或导入平台，勾选目标并检查预览后启动。结果未知的任务不会自动重投。AI 为可选功能，可在“设置”配置并测试后启用。

## 之后怎么用

- **再次使用：** 运行 `~/.local/bin/backlink-kit start`，然后打开浏览器侧栏。
- **更新：** 先停止服务，重新运行上面的一键安装命令；在扩展管理页重载 Fast-Backlink，再启动服务。
- **新增产品：** 使用 `kits new ... --url ...`，然后重启服务，载入新的产品列表。
- **备份资料：** `~/.local/bin/backlink-kit assets export --output "$HOME/backlink-assets.zip"`。

从 1.0.0 升级时，停用旧扩展，从新的固定目录加载一次，并保存原连接地址。旧扩展的设置与快照可以保留；以后只需重载新版扩展。

## 更多说明

[安装与排错](docs/INSTALLATION.md) · [扩展操作](extension/README.md) · [能力与限制](docs/CAPABILITIES.md) · [CLI](docs/fast-backlink-cli.md) · [开发](CONTRIBUTING.md) · [变更记录](CHANGELOG.md)

作者：[fanjing188](https://github.com/fanjing188)。[MIT 许可](LICENSE)，第三方必要许可见 [NOTICE](NOTICE)。问题请提交到 [Issues](https://github.com/fanjing188/fast-backlink/issues)，不要附带密钥或私有资料。
