# dsh-notes · 便签

一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的便签插件：记录需求、维护需求基本信息、按分类整理，并和会话 / 截图 / 在线表格打通。

左侧栏一级入口，打开就是一个整页便签面板。

## 功能

### 便签管理

- 左侧列表 + 右侧编辑，支持**标题 / 分类 / 优先级(P1–P5) / 标签 / 状态 / 正文**
- 状态：待办 `backlog` · 进行中 `doing` · 已完成 `done` · 已归档 `archived`
- 搜索（标题/正文/标签/分类）+ 按分类、状态筛选
- 数据存本机 `<DSH_HOME>/dsh-notes/notes.v1.json`，原子写入，不写进聊天记录

### 与会话串起来

- **关联当前会话**：把便签挂到正在进行的会话上，可一键跳回
- **基于此便签开始工作会话**：新开一个会话并把便签内容预填进输入框，直接进入需求分析

### 从截图识别

- 面板内**点选 / 粘贴(Ctrl+V) / 拖入**截图
- 本机 Windows OCR 识别（`Windows.Media.Ocr`，中文 `zh-Hans-CN`），自动放大 2.5 倍提升准确率
- 识别后自动**按语义归类成 1、2、3 条**（只分类编号，不改写原文），填进新便签草稿，确认后保存
- **原图不留存**：只在系统临时目录过一遍，识别完立即删除
- 正文下方还有「整理排版」按钮，可对任意正文一键归类

### 从表格导入（只读）

支持两种数据源，弹窗内可切换：

| 数据源 | 认证方式 |
|---|---|
| **飞书多维表格** | 复用本机已接入的飞书应用（appId + Secret），或手动填 |
| **企业微信智能表格** | CorpID + 自建应用 Secret（界面填写，仅存本机） |

流程：粘贴链接 → 选数据表 → 勾选记录 → 字段映射（自动猜测，可改）→ 生成便签。

- 绑定表格列与便签字段：标题列、正文列、分类列、优先级列、标签列
- **实时预览**：点任意一行，「导入后长这样」立即显示该行会变成什么便签
- 优先级支持「高/中/低」「P1–P5」「1–5」等写法自动归一
- 默认只勾选标题非空的行，避免导入空行
- **严格只读**：只调用查询接口，绝不修改你的表格

## 安装

本插件是标准 DSH bundle，无 npm 运行时依赖。

```bash
# 在 DSH 里通过插件管理器安装（target 指向本目录的绝对路径）
# plugin_manager  action=install_bundle  target=<本仓库绝对路径>
```

安装后在浏览器刷新页面，左侧栏出现「便签」图标。

## 配置

### 飞书多维表格

1. 打开你的多维表格，从地址栏取 **app_token**：
   - 普通表格：`https://xxx.feishu.cn/base/`**`bascn...`**`?table=tbl...`
   - 知识库内的表格：`https://xxx.feishu.cn/wiki/`**`SxoTw...`**`?table=tbl...`（插件会自动换成真实 app_token）
2. 给飞书应用开通 `bitable:app:readonly`（知识库表格另需 `wiki:wiki:readonly`）
3. 把目标表格「添加文档应用」授权给该应用
4. 触发**创建版本并发布**，权限才会生效

常见错误：

| 错误 | 含义 |
|---|---|
| `91402 NOTEXIST` | app_token 不对，或表格没授权给应用 |
| `99991672 Access denied` | 应用没开通对应 scope |
| `99991672` 含 `wiki:` | 知识库表格，需开通 wiki 读取权限 |

### 企业微信智能表格

企业微信任何开放接口都需要「企业 CorpID + 自建应用 Secret」，这是平台强制要求。可以自己创建：

1. 企业微信管理后台 →「我的企业」→ 复制 **CorpID**
2. 「应用管理 → 自建 → 创建应用」→ 拿 **Secret**
3. 给应用开通「文档 / 智能表格」权限，并把目标表格授权给应用
4. 若报 `60020`，把本机出口 IP 加入应用「企业可信 IP」

然后在便签面板 →「从表格导入」→ 切到「企业微信智能表格」→ 填 CorpID/Secret → 保存（仅存本机）。

常见错误：

| errcode | 含义 |
|---|---|
| `40013` | CorpID 无效 |
| `40001` | Secret 无效或与 CorpID 不匹配 |
| `48002` | 应用未开通文档/智能表格权限 |
| `60020` | IP 不在可信 IP 列表 |
| `301002` | 该文档未授权给应用 |

## 数据位置

| 内容 | 路径 |
|---|---|
| 便签 | `<DSH_HOME>/dsh-notes/notes.v1.json` |
| 表格来源 | `<DSH_HOME>/dsh-notes/tables.v1.json` |
| 企微凭证 | `<DSH_HOME>/dsh-notes/wecom-credentials.v1.json` |

`DSH_HOME` 默认是 `~/.dsh`。

## 换电脑

- 插件目录可整体拷走，无 npm 依赖
- **便签数据与凭证不在插件目录**，在 `DSH_HOME` 下；要带走便签请另行拷贝 `notes.v1.json`
- 企微凭证需在新机器重填，或拷贝 `wecom-credentials.v1.json`

## 已知限制

- **截图识别依赖 Windows 自带 OCR**（`Windows.Media.Ocr`），非 Windows 系统或精简版系统可能不可用；不可用时会明确报错并保留原文
- **表格导入为只读**，不会回写你的表格
- 语义归类依赖宿主 `llm` 服务（取当前默认模型），模型不可用时自动回落到原文

## 开发

```
dsh-notes/
├── lib/
│   ├── index.js    Host 入口：注册 HTTP 路由 + Agent 工具
│   ├── store.js    便签存储（原子写、校验）
│   ├── sources.js  表格来源与企微凭证存储
│   ├── feishu.js   飞书多维表格（app_token 解析、wiki 转换、记录读取）
│   ├── wecom.js    企业微信智能表格（access_token、get_sheet/fields/records）
│   ├── ocr.js      本机 Windows OCR
│   ├── format.js   按语义归类排版（调宿主 llm）
│   └── client.js   Client 半边：侧栏入口 + 面板 UI
├── locale/         中英文显示元数据
├── cordis.patch.yml
└── package.json
```

### HTTP 接口（`/dsh-notes/api`，需 owner 权限）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/notes` | 列出便签 |
| POST | `/notes` | 新建/更新 |
| POST | `/delete` | 删除 |
| POST | `/link` | 关联/解绑会话 |
| GET | `/ocr-status` | OCR 可用性 |
| POST | `/ocr` | 截图识别（base64） |
| POST | `/format` | 语义归类排版 |
| GET/POST | `/sources`, `/sources/delete` | 表格来源增删查 |
| GET/POST | `/wecom/credentials` | 企微凭证 |
| GET | `/wecom/status` | 企微连通性 |
| POST | `/wecom/sheets` `/wecom/preview` `/wecom/import` | 企微表格 |
| POST | `/feishu/tables` `/feishu/preview` `/feishu/import` | 飞书表格 |

### Agent 工具

注册了 `notes` 工具，模型可直接读写便签：

`action` = `list` / `get` / `create` / `update` / `delete` / `setStatus` / `linkSession`

## License

MIT
