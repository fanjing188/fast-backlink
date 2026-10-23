# 开源与分发边界

公开源码仓库为 [fanjing188/fast-backlink](https://github.com/fanjing188/fast-backlink)，尚未发布正式Release或上架浏览器商店。主项目采用MIT，所含FBL移植部分按已落实的MIT许可分发。

## 许可与发布目标

1. 主许可证为根目录LICENSE，package.json和锁文件已同步MIT；private保持true，防止误发npm。源码开源不等于发布npm包。
2. FBL所含副本及改编的许可见extension/vendor/fbl/LICENSE，范围与署名见根NOTICE；不据此宣称整个上游产品都采用MIT。
3. 源码使用该仓库的main分支，反馈入口为 [Issues](https://github.com/fanjing188/fast-backlink/issues)。源码公开与正式Release、商店上架分别核实，不把源码推送写成已经上架。

## 公开源码白名单

使用 `python3 tools/package_public.py --output <包路径>` 生成受检源码包；该入口在缺少主许可或FBL许可说明时拒绝公开打包。`--local-candidate` 仅供私下验收，会明确标为不可公开分发，不是许可豁免。

公开材料只允许程序代码、规则、虚构示例配置、安装脚本、已核的开发测试和用户文档。排除 `config.json`、真实 `kits/`、来源资产、台账、日志、runs、内部报告、候选旧包与未经审核的截图。资料备份与公开源码包是两种不同产物，不得混装。

## Git历史也要单独审查

`.gitignore` 不能让已跟踪文件从历史消失。公开仓库从白名单清洁源码快照建立，不合入个人开发目录的原始历史、配置或产品包；提交使用GitHub noreply身份。原始私有工作树与历史保持独立，不因公开分发而删除或改写。

## 交付核验

- 在空用户目录安装，运行doctor、CLI与本机服务，再测试保留资产的更新、失败回退、卸载和重装。
- 对公开候选包解压重装，而不只测试脏工作树；核CRC、逐文件摘要及归档摘要。
- 自带vendor哈希校验在没有作者机器路径时仍应工作；与上游比较/同步须显式配置FBL_DIR。
- macOS本机验收与Linux/其他浏览器的验证范围分开记录。
- 确认浏览器手动加载、手动重载与人工提交的说明；不宣称“完全零操作安装”。
