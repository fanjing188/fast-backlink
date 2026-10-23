# vendor/fbl：从 Fast-browser-link 移植的部分

## 许可

本仓库所含副本及改编已获权利人允许按MIT分发，许可全文见[LICENSE](LICENSE)，署名和范围见[项目NOTICE](../../../NOTICE)。这不代表整个上游产品或其他未包含组件都采用相同许可。

`extension/ui/icons.js` 中共用的线性图形构造也来自该UI语言，属于所含改编范围。`extension/icons/mark.svg` 是本项目单独设计的书签链标志，适用主项目MIT许可。

只移植和填表有关的代码，跟着上游更新，不在 vendor 里手改。`VERSION.json` 记录每个文件
的 sha256，`sync-fbl.mjs` 负责整体覆盖同步。

## 逐字拷贝的文件（可用 `node extension/vendor/fbl/sync-fbl.mjs --check` 校验）

| 文件 | 上游 | 用途 |
|---|---|---|
| `password-values.mjs` | `native-extension/password-values.mjs` | 采集密码框当前值用于脱敏；日志与快照都不写密码 |
| `target-recovery.mjs` | `native-extension/target-recovery.mjs` | 定位失败恢复：按 ref/role+name/text 重新排序目标 |
| `interaction-highlight.mjs` | `native-extension/interaction-highlight.mjs` | 交互高亮（显示正在操作的元素） |
| `brand.css` | `native-extension/brand.css` | 设计令牌与基础控件（颜色/圆角/阴影/状态药丸/开关/页签），两个插件共用一套视觉语言 |

用法与加载方式：

- `target-recovery.mjs` 与 `interaction-highlight.mjs` 直接在扩展页/后台按 ES 模块导入。
- `password-values.mjs` 需要页面 DOM，由内容脚本侧使用；内容脚本不能加载 ES 模块，因此
  `extension/lib/vendor-fbl.js` 里放了一份等价的经典脚本实现，并在文件头写明来源和校验方式。

## 改编的 CDP 调用（没有可单独切出的模块，按调用序列照搬）

`extension/lib/cdp.js` 里的命令序列来自 `native-extension/core.mjs`，只保留按需附着的部分：

| 能力 | 上游位置 | 我们用到的命令 |
|---|---|---|
| 可信输入 | `core.mjs` `fillSemanticEditable`（约 2860 行） | `Emulation.setFocusEmulationEnabled`、`Input.insertText`、`Input.dispatchKeyEvent` |
| 按键 | `core.mjs` `press`（约 3355 行） | `Input.dispatchKeyEvent`（keyDown+keyUp，Enter 带 `text: '\r'`） |
| 鼠标点击 | `core.mjs` 交互高亮派发 | `Input.dispatchMouseEvent` |
| 按路径上传 | `core.mjs` `files.upload`（约 2965 行） | `DOM.enable`、`DOM.getDocument`、`DOM.querySelectorAll`、`DOM.describeNode`、`DOM.setFileInputFiles`、`DOM.resolveNode` |
| 封闭 Shadow / iframe | `core.mjs`（约 1690 行 `Target.setAutoAttach`） | `Target.setAutoAttach`（跨域 iframe 备用路径） |
| 元素句柄 | `core.mjs` 语义层 | `Runtime.callFunctionOn`（focus、读回、派发） |

不移植：原生消息宿主、云端连接、Hermes/Codex 面板、表格采集、Cookie 镜像、Vault、审批、
下载、工作窗口、标签组、`cdp-policy` 白名单（我们只在自己的标签页上按需附着，操作完立即 detach）。

## 与上游的差异

- 上游是有审批和策略引擎的执行器；这里只有“按需附着 → 派发一次 → 回读 → 立即分离”，
  没有重放，失败即如实报 `outcomeUnknown`。
- 上游 `files.upload` 只允许其自管 artifacts 目录下的路径；我们只允许本机服务刚暂存出来的
  路径（`api/stage` 返回，落在临时目录 `fast-backlink-stage/assets/`）。
