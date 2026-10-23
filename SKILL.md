---
name: backlink-kit
description: Use for local backlink form assistance, reusable product/source assets, verification archives and human-reviewed submissions.
---
# Fast-Backlink：Agent使用说明

## 先决条件

按[安装说明](docs/INSTALLATION.md)安装程序并手动加载扩展，启动 `backlink-kit start`。本技能不是Hermes专属插件，不授予外部提交、账号、付款或绕过验证的权限。用户明确的当前任务和来源站规则优先。

## 默认边界

- 不点最终提交、不代填验证码/密码/支付信息、不自动勾选授权，不绕过平台条款。
- 缺少事实就留空，不用AI编造价格、资质、收入或联系方式。
- 先读状态再行动；结果未知先核实，不重复派发已开始的动作。填写成功不等于受理、公开或链接有效。
- 来源历史、资料包、令牌与导出备份属于用户私有资产，不进入源码提交或公开Issue。

## 建资料和查状态

```sh
backlink-kit doctor
backlink-kit kits new myproduct
backlink-kit kits check
backlink-kit fb status
backlink-kit fb queue --site myproduct
```

空资料包要由用户补真实内容和domain。基础扩展不要求Hermes；传统采集/后台填入口需要另外配置浏览器桥接，不把它当默认可用依赖。

## 只对明确任务操作页面

```sh
backlink-kit fb open https://source.example/submit --site myproduct
backlink-kit fb state --url https://source.example/submit
backlink-kit fb snapshot --url https://source.example/submit --output snapshot.json
backlink-kit fb remember --url https://source.example/submit --site myproduct
```

检查ok、实际字段数和pending；任何未确认字段交人。服务不可达或扩展离线，先修连接，不循环派发。CLI超时可能已经执行，不据此重放。完整命令及退出码见[CLI参考](docs/fast-backlink-cli.md)。

## 存档与人工处理

人在扩展“表单”页点“存档待验证”，任务页按产品/仅剩验证筛选，再打开复原。档案保存实际值、人工修改和稳定素材身份；密码、验证码与授权确认不入档。素材变化、页面变化或登录过期仍可能要求人工补项。

```sh
backlink-kit fb open --item <档案ID>
backlink-kit fb done <档案ID>
```

仅在用户确实提交后记录done，仍只记待核实。提交事件的“结果未知”不会计作成功，不重新发放自动复原任务。不要用done作为提交命令。

## 资产复用

```sh
backlink-kit source import --dry-run
backlink-kit source import --apply
backlink-kit campaign --site myproduct --dry-run
backlink-kit assets reuse --site mynewproduct
backlink-kit assets export --output backlink-assets.zip
```

import的apply会写本机资源库；先确认用户指定的配置和数据范围。reuse只给待复核候选，不复制旧产品资料或继承准入，活动计划也不代表已经执行。导出包含私有数据，不公开上传。

## 维护

服务运行时拒绝更新或卸载。等当前动作结束、存档并停止服务后，使用update/rollback；手动重载扩展，再start。uninstall --yes只卸载代码，保留资产；不修改其他Agent或浏览器安装。
