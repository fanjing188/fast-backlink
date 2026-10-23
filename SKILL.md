---
name: backlink-kit
description: Use for local backlink forms, product assets and explicit submission tasks.
---
# Fast-Backlink：Agent 使用

先按 [快速开始](README.md#快速开始) 安装程序、连接扩展并准备真实产品资料。基础扩展不依赖 Hermes。只操作用户指定的产品、页面和任务；本说明不授予账号、付款或外部投稿权限。

## 读取与填写

```sh
backlink-kit doctor
backlink-kit fb status
backlink-kit fb queue --site myproduct
backlink-kit fb open https://source.example/submit --site myproduct
backlink-kit fb state --url https://source.example/submit
```

先检查连接、产品绑定和实际字段结果。单页填写不点击最终提交。AI 只使用已有资料，不覆盖人工输入，不猜测价格、身份或商业事实。验证码、密码、支付和授权确认交人。

## 显式批量任务

```sh
backlink-kit fb batch start --site myproduct --domains first.example,second.example --batch-size 10
backlink-kit fb batch status
backlink-kit fb batch stop <批次ID>
```

`start` 会创建队列并自动提交，调用前须有该产品和平台范围的明确授权。资格预检未通过的记录不入队。遇人工验证转待人工；结果未知先读回，不重试已尝试的提交，也不把平台收稿记成外链已公开。

## 存档与资料

从任务列表打开并复原存档，核对后由用户完成验证。素材按 ID 和摘要恢复，变化时重新确认；敏感字段和授权勾选不入档。`fb done <档案ID>` 只记录人工已处理后的待核实状态，不执行提交。

新身份和产品资料可用项目附带的 [身份初始化](skills/fast-backlink-init/SKILL.md) 与 [产品准备](skills/fast-backlink-product/SKILL.md) 流程。资料、令牌、配置和资产备份属于用户私有数据，不放入源码或公开 Issue。

更新前结束或交接当前操作并停止服务，更新后手动重载扩展。完整命令见 [CLI 参考](docs/fast-backlink-cli.md)。
