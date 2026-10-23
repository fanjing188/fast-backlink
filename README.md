<img src="extension/icons/mark.svg" width="80" height="80" alt="Fast-Backlink logo">

# Fast-Backlink

**本机运行的外链表单助手：填写、存档、复用产品与来源资产。**

保存产品文案和素材，在提交页面选择产品，检查填写结果。遇到验证码时把当前内容存档，稍后从集中队列打开并复原。验证码、授权确认和最终提交由你完成。

Local-first backlink form assistance with reusable product assets and verification archives. Review every submission yourself. The interface is primarily Chinese.

> **源码按MIT公开：[fanjing188/fast-backlink](https://github.com/fanjing188/fast-backlink)。** FBL所含移植部分已获权利人允许按MIT分发。尚未发布正式Release或上架浏览器商店。见[分发边界](docs/OPEN_SOURCE.md)。

## 安装

前提：Python 3.11+、支持侧边栏的 Chrome / Edge。本轮在 macOS 验证；Linux浏览器完整链路未验，原生 Windows / Firefox / Safari 不支持。基础使用不需要 Node、Hermes 或云端账号。

从公开仓库获取源码并安装；也可在下载解压的源码目录直接执行安装脚本：

```sh
git clone https://github.com/fanjing188/fast-backlink.git
cd fast-backlink
sh scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"  # 若命令目录还不在PATH
backlink-kit doctor
backlink-kit start
```

脚本安装到当前用户目录，不用sudo，不改浏览器或系统服务，也不复制作者的个人配置和外链资产。start前台运行，Ctrl+C停止；终端会给出含令牌的私有本机连接地址，不要公开分享。

手动完成浏览器的安全确认：

1. 在 `edge://extensions` 或 `chrome://extensions` 开启开发者模式。
2. 加载 `~/.local/share/backlink-kit/current/extension`；自定义路径以doctor输出为准。
3. 打开扩展选项，保存start给出的完整本机地址，固定扩展到工具栏。

完整安装、自定义目录、Python选择及故障排查见[安装说明](docs/INSTALLATION.md)。安装不自动注册系统常驻服务。

## 建立自己的产品资料

```sh
backlink-kit kits new myproduct
backlink-kit kits check
```

初始产品和来源库都是空的。填写 `~/.local/share/backlink-kit/data/kits/myproduct/kit.json`、补充素材，并在安装目录config.json中填真实domain。模板不是已验证商业事实，缺资料先补齐再投。

## 可以做什么

- **辅助填写**：按标签、字段属性、资料包和来源经验匹配；写入后回读，不确定的字段交人。
- **外链库**：查看、筛选和更新平台入口、适配产品、核实依据与历史；确认可复用后，为当前产品生成持久任务并打开填写。
- **待验证存档**：保存实际值和人工修改，关闭浏览器后可从任务队列打开复原；只在确认其他内容就绪时显示“仅剩验证”。
- **复用资产**：来源入口、结构配方、历史和按产品隔离的记忆留在本机；换产品只复用经验，不复制旧文案或准入结论。
- **素材与快照**：按稳定素材身份和摘要核对，文件重排不串图，内容变化留给你确认。
- **CLI与Agent**：从命令行打开表单、读回状态、保存快照、记录人工处理结果。
- **可选AI**：默认关闭；配置后点击“AI 兜底”直接填写可用的空字段，不逐项二次确认。只用已有资料，不编造事实、不覆盖人工输入，验证码与最终提交仍由你处理。

侧栏选择的项目自动保存，重开侧栏、新页面及浏览器重启后沿用。已有页面和续填任务使用各自绑定的项目，不被全局默认值覆盖；更换默认项目仍从侧栏选择。

[能力与限制](docs/CAPABILITIES.md) · [扩展使用说明](extension/README.md) · [CLI参考](docs/fast-backlink-cli.md)

## 使用外链库

从侧栏、素材库或日志页点击“外链库”。先选择目标产品，再筛“已确认可投的平台”或“当前产品可复用”。两种状态不同：平台曾确认可投，不代表新产品自动获准。

- 新增平台默认待核实；费用、回链要求、Ahrefs DR及核验日期按实际结果填写，不猜测。适配产品需明确勾选；取消全部勾选会撤销当前适配，旧证据保留。
- “查看 / 重新核对”只打开页面；“打开并填写”先保存本产品的待处理项，再填写。配方过期、规则未核实、产品不适配或已有未知提交结果时不能直接复用。
- 更新提交地址会采用新入口并保留旧地址。历史、配方和其他产品的记忆保留在同一来源库中，不复制旧产品文案。
- “导出当前清单”只导出当前筛选的JSON，不是完整资产备份。完整私有备份用下方的assets export。

公开安装从空库开始，不附带作者的私有平台或提交清单。验证码、授权及最终提交仍由你完成。

## 卡在验证码时

`表单 → 存档待验证 → 任务 → 仅剩验证 → 打开并复原`

复原后核对页面，完成验证码并亲自提交。登录过期、页面改版、新增必填项或未完成多步时，可能仍需补操作。提交事件只记“结果未知”，不代表平台受理或外链公开；未知结果不自动重放。

提交后即使页面报错或清空，也不能只凭页面提示认定未受理，插件不会自动复原或重新填写。请先核实平台结果；提交前保存的快照和存档会保留。

## 更新、回滚、卸载

先停止服务，等当前动作结束：

```sh
backlink-kit update
backlink-kit rollback
backlink-kit uninstall --yes
```

更新从已登记的公开Git上游下载，或重读安装时登记的本地源码；可显式给 `--source`、`--repo`、`--ref`。未设置上游时，不假称拿到了线上最新版。

候选CLI通过检查后原子切换，旧版本保留用于回滚。下载/验证失败不切换，配置和资产不变。更新或回滚后，手动重新加载扩展，再启动服务。

卸载只移除本安装的命令和程序，保留config、令牌及data；浏览器扩展需手动移除。源码目录另提供 `scripts/update.sh`、`scripts/uninstall.sh`。自定义安装带上相同的 `--prefix`，详见[安装说明](docs/INSTALLATION.md)。

## 导出私有资产，为新产品选候选

```sh
backlink-kit assets export --output "$HOME/backlink-assets.zip"
backlink-kit assets reuse --site mynewproduct
```

资产ZIP含业务资料及身份信息，应私密保存。manifest记录摘要与缺失引用，不能把带缺失项的包称为完整灾备。reuse只给待复核候选，不自动提交；本项目不附送作者的私有来源清单。

## 安全边界

不读取/代填密码、验证码或支付信息，不自动确认条款，不点击最终提交，不发外联邮件，也不承诺收录、排名或付款效果。本机服务仅用于单用户回环地址，不能作为公网SaaS。

不要在Issue、截图或公开仓库中提交令牌、密钥、配置、资产包和原始日志。可选AI会将允许的元数据发送到你配置的接口；公开安装默认关闭值预览与自动采纳。见[安全说明](SECURITY.md)。

## 开发、品牌和发布

- [贡献与测试](CONTRIBUTING.md)
- [Logo候选图板](docs/brand/logo-review.html) · [SVG原件](extension/icons/mark.svg)
- [插件介绍与商店文案草稿](docs/STORE_LISTING.md)
- [变更记录](CHANGELOG.md)
- [公开发布检查](docs/OPEN_SOURCE.md)

“书签链”表示保存来源与再次复用，同一SVG输出16/32/48/128/256/512像素图标。当前为候选设计。

**MIT许可。** 主项目见[LICENSE](LICENSE)，移植部分见[vendor许可](extension/vendor/fbl/LICENSE)和[NOTICE](NOTICE)。现有Git历史含个人资料，公开版本从清洁快照建立，不把旧工作树直接推成公开仓库。
