# news-proofreading-pi

基于 Docker 容器的严肃新闻稿件智能审校 Agent 执行器，注册到 Fuyao 平台接收审校任务，自动完成规则审查、人名核实与报告输出。

## 适用场景

- 通讯社、报社、门户网站的新闻稿件发布前审查
- 政务新媒体内容合规检查
- 任何需要排查政治性差错、机构名称与人名准确性的严肃文本

## 核心审校维度

| 维度 | 说明 |
|------|------|
| 机构名称规范性 | 首次出现是否用全称，简称是否规范 |
| 领导人职务称谓 | 职务在前、党内优先、禁用口语化简称 |
| 港澳台及民族宗教用语 | 排查涉台、涉港、涉澳及民族宗教表述差错 |
| 禁用词/慎用词 | 时政类（如"亲自""莅临"）与社会生活类禁用词 |
| 人名审查 | 提取、搜索核实、一致性比对、职务匹配 |
| 数字、标点与格式 | 基础格式与标点规范 |

---

## 审校流程

```
接收稿件 (task.json)
        │
        ▼
┌─────────────────┐
│  Step 1: 规则审查  │  机构名称 / 职务称谓 / 港澳台用语 / 禁用词 / 数字、标点、格式
│  （文本层面）      │  不确定时暂停 → 调用搜索工具核实
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Step 2: 人名审查  │  提取人名 → 搜索核实 → 一致性比对 → 职务匹配
│  （逐字核实）      │  所有不确定人名必须经搜索确认
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Step 3: 输出报告  │  审校概要 / 用词问题 / 人名结果 / 修改建议汇总
└─────────────────┘
```

---

## 项目结构

| 文件/目录 | 作用 |
|-----------|------|
| `master.md` | 审校规则与流程的系统提示词，定义全部审查维度和输出格式 |
| `Dockerfile` | 镜像构建定义，基于 `node:22-slim`，内置 pi-coding-agent 与系统依赖 |
| `run.sh` | 任务执行脚本，读取 `task.json` 后分两步调用 `pi` 命令完成审校与输出整理 |
| `entrypoint.sh` | 容器入口脚本，校验 `task.json` 存在后执行 `run.sh` |
| `config.toml.example` | Fuyao Agent Core 配置模板（脱敏） |
| `.env.example` | 环境变量模板，含搜索 API Key（脱敏） |
| `pi/` | pi-coding-agent 的配置与技能文件目录，构建时复制到镜像内 |
| `.gitignore` | 排除 `config.toml` 与 `.env`，防止敏感信息泄露 |

---

## 快速开始

### 前置条件

- Docker 已安装并可运行
- Fuyao 平台环境（含 Agent Core）
- 有效的 Kimi API Key（用于联网搜索核实不确定信息）

### 1. 配置

复制模板文件并填写真实值：

```bash
cp .env.example .env
cp config.toml.example config.toml
```

编辑 `.env`：
```bash
# .env
KIMI_API_KEY=your_kimi_api_key_here
```

编辑 `config.toml`：填写 Fuyao 平台地址、Agent 名称等（详见下方[配置说明](#配置说明)）。

### 2. 构建镜像

```bash
docker build -t news-proofreading:latest .
```

### 3. 注册为 Fuyao Agent 执行器

1. 将 `config.toml` 放置到 `agent-core` 二进制同级目录。
2. 启动 Agent Core 完成注册。注册成功后，`config.toml` 中的 `service_id` 与 `api_key` 将自动填充，无需手动修改。
3. Agent Core 会根据 `config.toml` 中 `[executor]` 配置的镜像名与并发数自动调度本容器执行审校任务。

---

## 配置说明

### `config.toml`

```toml
[server]
base_url = "http://localhost:8080"        # Fuyao 平台地址
poll_interval_secs = 5                    # 轮询间隔（秒）
use_system_proxy = false                  # 是否使用系统代理

[agent]
service_id = "YOUR_SERVICE_ID_HERE"       # 注册后自动填充
api_key = "YOUR_API_KEY_HERE"             # 注册后自动填充
name = "news-proofreading"                # Agent 名称

[executor]
image = "news-proofreading:latest"        # Docker 镜像名
capacity = 4                              # 并发任务数
timeout_minutes = 0                       # 任务超时（0 = 无限制）
# memory_limit = "4g"                     # 内存限制（可选）

[paths]
data_dir = "./data"
# [[paths.mounts]]                        # 额外挂载（可选）
```

### `.env`

```bash
KIMI_API_KEY=your_kimi_api_key_here       # Kimi 搜索 API Key
```

> `.env` 在构建时被打包进镜像，位于 `/home/executor/.env`，供审校脚本加载后调用搜索接口。

---

## 使用方式

通过 Fuyao 平台下发审校任务，任务负载为一份 JSON（映射到容器内的 `/workspace/task.json`），典型结构如下：

```json
{
  "task_prompt": "请对以下新闻稿件进行审校：\n\n（稿件正文）...",
  "output_prompt": "输出审校报告，包含审校概要、用词严谨性问题、人名审查结果、其他问题、修改建议汇总。"
}
```

容器启动后：
1. `entrypoint.sh` 校验 `task.json`；
2. `run.sh` 分两步调用 `pi-coding-agent`，加载 `master.md` 中的审校规则；
3. 审校过程中，Agent 自动调用搜索工具核实不确定的机构名称、人名、职务等；
4. 最终结果写入 `/workspace/output/response.md`，并回拷到 `/workspace/response.md`。

---

## 输出格式

审校报告（`/workspace/output/response.md`）包含以下章节：

| 章节 | 内容 |
|------|------|
| 一、审校概要 | 稿件字数、发现问题总数（严重/一般/建议）、审校结论 |
| 二、用词严谨性问题 | 按优先级列出问题位置、描述、风险等级与修改建议 |
| 三、人名审查结果 | 人名、出现次数、核实结果、一致性、职务匹配、备注 |
| 四、其他问题 | 格式、标点、数字等方面的问题 |
| 五、修改建议汇总 | 可直接替换的修改清单 |

---

## 注意事项

- **敏感信息保护**：`config.toml`、`.env` 与 `pi/agent/models.json` 均包含 API Key 和平台凭证，已加入 `.gitignore`，**请勿强制提交到版本控制**。
- **搜索依赖**：人名审查与机构核实依赖 Kimi 搜索 API，请确保 `KIMI_API_KEY` 有效且余额充足。
- **超时设置**：`config.toml` 中 `timeout_minutes = 0` 表示不限制任务时间；若稿件较长或涉及大量人名搜索，建议根据实际场景设置合理超时。
- **不确定即搜索**：审校规则强制要求，对任何不确定的机构名称、人名、职务、历史事件、政策法规等，必须调用搜索工具核实，禁止凭记忆判断。

---

## License

MIT
