# 插件介绍与商店素材草稿

本页是发布文案草稿，不代表已上架。主项目与所含FBL派生部分已获MIT许可；公开仓库、正式隐私页面和平台验收齐备后，才另行审批商店发布。

## 名称

Fast-Backlink

## 中文简短介绍

辅助填写外链提交表单，保存产品素材与待验证存档，换产品复用来源经验。验证码与最终提交由你完成。

## English short description

Fill backlink forms with reusable product assets. Save verification tasks locally; review and submit yourself.

## 中文详细介绍

Fast-Backlink 帮你减少重复准备外链提交资料的工作。先保存产品名称、介绍、分类和图片，再在提交页面选择产品。插件匹配能识别的字段，回读填写结果，把不确定的部分交给你。

遇到验证码或需要人工验证时，可以保存当前填写内容。稍后在任务页集中查看，打开对应表单并复原已存档的文字、选择项和可用素材；人工修改也会保留。页面改版、登录过期或资料缺失时，仍可能需要补操作。

来源、配方、按产品隔离的记忆和提交历史留在本机。切换产品时复用平台经验，不复制旧产品文案，也不会把历史提交直接标成新产品已提交。

插件不会破解验证码或点击最终提交，不保证平台受理、收录或排名效果。AI为可选功能，默认关闭；只有你配置接口后才使用。当前界面主要为中文；基础功能不要求Hermes账号或云端服务。

## English overview

Fast-Backlink keeps product text, media and backlink-source knowledge on your computer. Pick a product on a submission page, review the fields it can match, and handle uncertain fields yourself.

Save a form when it reaches a verification step. Reopen it from the task queue and restore saved values, including manual edits. Changed forms, expired login sessions and missing assets may still need attention. The extension does not solve CAPTCHAs or click the final submit button. A submission attempt is not proof of acceptance or publication.

The interface is primarily Chinese. The core assistant uses a local Python service; AI is optional and disabled by default. No source inventory or customer data is included.

## 权限解释

| 权限/行为 | 用途 |
|---|---|
| http/https内容脚本、所有frame | 扫描提交表单并执行你选择的产品填写；页面变更仍需核对 |
| storage / unlimitedStorage | 保存连接、设置和浏览器侧快照 |
| activeTab / tabs / scripting | 定位当前或指定提交页，传递表单操作 |
| sidePanel | 显示字段、素材、快照与待验证任务 |
| contextMenus | 提供填字段、填整页及复原入口 |
| alarms | 唤醒本机Agent命令轮询 |
| debugger | 按需可信输入/文件上传，完成后分离；浏览器可能显示调试提示 |
| 127.0.0.1主机权限 | 只向本机资料服务发扩展请求；可选AI网络调用由本机服务发出 |

## 可用素材

Logo原件 `extension/icons/mark.svg`；PNG为16/32/48/128/256/512。品牌图板 `docs/brand/logo-review.html`，图板明确为设计演示。商店截图应来自已验真实扩展，并遮去令牌、身份资料和业务内容；不得把图板冒充平台实投截图。

## 发布前待填

公开仓库/支持入口、隐私声明的正式托管地址、实际受支持的平台与版本。许可文件见根LICENSE、NOTICE及extension/vendor/fbl/LICENSE。本稿没有填写虚构URL，也没有把开源准备状态描述为已发布。
