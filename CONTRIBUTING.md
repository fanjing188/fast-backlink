# 开发与测试

维护者：[fanjing188](https://github.com/fanjing188)。

## 本地检查

开发需要 Python 3.11+、Node 22、ffmpeg 和可用的 macOS 图形会话：

```sh
npm ci --ignore-scripts
npx playwright install chromium
BK_PROTECT_REAL=1 python3 -m unittest
node --test extension/tests/*.test.cjs
node --input-type=module --check < extension/background.js
node --test --test-concurrency=1 extension/e2e/*.test.mjs
npm run vendor:check
```

测试使用私有临时目录和合成资料。浏览器套件占用 18790/18801/18802，串行运行；不要连接真实业务库，也不要停止不属于测试的服务。

## 修改要求

- 修问题先补能失败的回归，保留人工输入、产品隔离和未知结果防重投。
- 界面变化核窄侧栏、深浅色、键盘和真实点击；DOM 值相同不代表平台收稿。
- 行为变化同步相关文档。提交说明写清改了什么，不加入聊天记录或测试过程流水。
- 不提交配置、密钥、资料包、业务日志或生成截图。第三方代码保留许可与固定摘要。

公开源码包使用 `python3 tools/package_public.py --output /path/to/source.zip`；私下验收加 `--local-candidate`。构建会检查公开白名单、敏感内容、文档链接和包内摘要。

项目许可见 [LICENSE](LICENSE)，第三方署名见 [NOTICE](NOTICE)。
