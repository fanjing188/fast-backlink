# 源码与分发

仓库：[fanjing188/fast-backlink](https://github.com/fanjing188/fast-backlink)。下载见 [Releases](https://github.com/fanjing188/fast-backlink/releases)。GitHub Release 与浏览器商店上架分别处理；项目不声明已上架商店。

主项目使用 [MIT](../LICENSE)。所含第三方副本及改编的许可见 [NOTICE](../NOTICE) 和 [vendor 许可](../extension/vendor/fbl/LICENSE)。

## 公开包

公开包只包含程序、虚构配置、规则、安装脚本、测试和用户文档。个人配置、产品素材、平台资产、台账、日志及内部验收报告不进入源码包或 Git 历史。

```sh
python3 tools/package_public.py --output /path/to/fast-backlink-source.zip
```

构建会核许可文件、敏感内容、相对链接、CRC 和逐文件摘要。正式发行加 `--release 1.0.0`，要求版本一致、工作区干净，并逐文件绑定 Git 提交。`--local-candidate` 只生成私下验收包。

开发检查见 [开发与测试](../CONTRIBUTING.md)，用户安装见 [安装说明](INSTALLATION.md)。
