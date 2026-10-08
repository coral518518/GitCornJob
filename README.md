# GitHub Actions 定时触发中心

部署在 Cloudflare Workers + D1 的定时任务服务：配置 GitHub 账号与任务规则，按计划自动触发目标仓库的 GitHub Actions workflow。

## 功能

- **定时任务**：cron（可指定时区）/ 固定间隔 / 随机间隔三种调度规则，支持 `workflow_dispatch` 与 `repository_dispatch` 两种触发方式，可随时启停
- **workflow 结果追踪**：自动轮询 GitHub Runs API 回填真实执行结论；触发失败与执行失败分别告警和统计
- **失败告警与自动停用**：企业微信 / 飞书 / Telegram / Bark / 通用 JSON 渠道，任务可自选推送路径；连续失败自动停用
- **多账号管理**：多个 GitHub 账号的 PAT，AES-GCM 加密存储，支持在线验证
- **心跳监控**：周期性探测 HTTP(S) 地址（浏览器 UA 模拟真实访问、期望状态码、关键词断言），离线 / 恢复推送告警并可联动触发任务
- **外部触发**：API 令牌 + `POST /api/trigger`，外部系统可驱动调度器，与平台 Cron 并存
- **公开状态页**：自定义路径免登录展示监控状态、心跳条带与在线率
- **Web 管理页**：单密码登录，页面内改密，仪表盘总览

## 部署

### GitHub Actions（推荐）

1. Fork 本仓库。
2. Settings → Secrets and variables → Actions 添加 3 个 secret：

| Secret | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Edit Cloudflare Workers 模板（含 Workers Scripts:Edit、D1:Edit） |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard 首页右侧 Account ID |
| `ADMIN_PASSWORD` | 初始登录密码（仅在从未于页面内改密时生效） |

3. Actions → `Deploy` → `Run workflow`（选 main 分支）。之后推送 main 自动部署（纯文档变更除外）。

首次部署自动创建 D1 数据库（`cronjob_db`）、初始化表结构并生成 `TOKEN_ENC_KEY`——它只在首次部署生成，删除后已保存的 PAT 无法解密。

### 本地部署

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOKEN_ENC_KEY   # openssl rand -hex 32
npm run db:init
npm run deploy
```

## 使用说明

1. 用 `ADMIN_PASSWORD` 登录管理页，「账号」页添加 GitHub 账号与 PAT 并验证。
2. 「任务」页配置触发方式与调度规则；「运行记录」页查看触发详情与 workflow 执行结果。
3. 修改密码：账户菜单 →「修改密码」，页面内密码优先于 `ADMIN_PASSWORD`。忘记密码时删除库中的哈希即可恢复：

   ```bash
   npx wrangler d1 execute cronjob_db --remote --command "DELETE FROM settings WHERE key='admin_password_hash'"
   ```

### PAT 权限要求

| 类型 | 权限 |
|---|---|
| classic | `repo` scope |
| fine-grained | Repository permissions 中 **Actions** 与 **Contents** 均设 **Read and write** |

### 触发方式

**workflow_dispatch**——需要指定分支或传参时使用：

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        required: false
        default: dev
```

任务字段：仓库（owner/repo）、workflow 文件名、分支 ref、inputs JSON（读取 `github.event.inputs`）。

**repository_dispatch**——按事件类型与 JSON 参数触发：

```yaml
on:
  repository_dispatch:
    types: [cron-trigger]
```

任务字段：仓库、event_type（与 `types` 完全一致且大小写敏感）、inputs JSON（作为 `client_payload` 传入，读取 `github.event.client_payload`）。

| | workflow_dispatch | repository_dispatch |
|---|---|---|
| 运行分支 | 可指定任意分支 | 固定默认分支 |
| 传参 | `github.event.inputs` | `github.event.client_payload` |

被触发的 workflow 文件必须存在于目标仓库默认分支。故障排查：404 = 仓库 / workflow 不存在或 PAT 无权限；422 = ref 不存在或缺少触发器声明；403 = PAT 权限不足。

### 通知渠道与自动停用

账户菜单 →「通知设置」：添加渠道（企业微信群机器人 / 飞书 / Telegram / Bark / 通用 JSON，Webhook 地址明文可编辑，可单独「测试」）；设置连续失败自动停用阈值（0 = 不停用）。

- 任务表单的「失败通知」默认关闭，打开后可多选推送目标，不同任务可发往不同渠道组合；PAT 失效属于账号级事件，推送全部渠道。
- 通用 JSON 渠道 POST `{"event","title","body"}`，`event` 取值 `job_failed` / `job_auto_paused` / `account_invalid` / `test`。
- 连续失败只统计定时调度（手动触发失败当场可见，不计入）；手动启停清零计数。任务失败推送、成功不推送；删除渠道后引用它的任务自动停止推送。

### 通知消息模板

文案由 `src/server/notify.ts` 统一构造，单行版式 `[对象名] [emoji 状态] 原因`，emoji：🔴 离线、✅ 恢复、❌ 失败、⛔ 自动停用、🔑 PAT 失效、🔔 测试。

| 事件 | 触发时机 | 消息 |
|---|---|---|
| `job_failed` | 定时触发失败且未达停用阈值 | `[{任务名}] [❌ 触发失败] {错误信息}` |
| `job_auto_paused` | 连续失败达到阈值被自动停用 | `[{任务名}] [⛔ 已自动停用] {最近错误}` |
| `workflow_failed` | dispatch 成功但 conclusion 非 success | `[{任务名}] [❌ 执行失败] {conclusion}`，run 链接另起一行 |
| `account_invalid` | PAT 触发 401（按账号去重） | `[{账号名}] [🔑 PAT 已失效] 请到「账号」页更新令牌` |
| `monitor_down` | 判定离线的当轮 | `[{监控名}] [🔴 离线] {错误信息}`，联动时追加 `已联动触发「{任务名}」` |
| `monitor_up` | 离线中的监控恢复 | `[{监控名}] [✅ 恢复] HTTP {状态码} · {ms}ms`，联动追加同上 |
| `test` | 渠道连通性测试 | `[{渠道名}] [🔔 连通正常]` |

企业微信首行加粗；Telegram 走 HTML 转义；飞书 / Bark / 通用 JSON 为纯文本透传。

### 心跳监控与任务联动

- **探测**：按间隔发起 GET/HEAD，默认浏览器 UA，可自定义请求头；期望状态码（默认 200-299，支持多码与区间）+ 关键词断言（仅 GET，读取上限 1MB）。
- **状态机**：连续失败达阈值（默认 1）判离线，成功即恢复并清零；仅状态切换的当轮推送与联动，不重复发送。
- **任务联动**：可为监控配置「离线时触发」/「恢复时触发」的任务，像手动触发一样记录运行并追踪结果；删除任务后引用自动置空。
- **暂停时段**：每日 HH:MM-HH:MM 窗口（可跨天、自定义时区）内跳过探测，不产生心跳 / 告警 / 联动。
- **粒度与保留期**：平台 Cron 每分钟唤醒，探测间隔最小 1 分钟；心跳默认保留 30 天（监控页「清理心跳」可调）。手动「立即检测」记录心跳并可恢复 up，但不参与离线判定。

### 外部触发与调度来源

账户菜单 →「API 令牌」创建令牌（明文只展示一次），外部系统调用：

```bash
curl -X POST https://<你的域名>/api/trigger \
  -H "Authorization: Bearer chb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

每次执行一轮完整调度（到期任务 + 到期监控），返回 `{ triggered, failed, probed, down }`，并刷新调度器心跳。调度来源三种形态：

| 形态 | 配置 |
|---|---|
| 纯平台 Cron（默认） | 保留 `wrangler.jsonc` 的 `triggers.crons` |
| 纯外部驱动 | 删除 `triggers` 块（免费计划 Cron 配额共 5 个、不足导致部署失败时的处置），由外部 cron 定时调用 |
| 两者并存 | 任务按 `next_run_at` 乐观锁认领，重复唤醒只空跑 |

限频：认证前按 IP 5 次/分、认证后全局 5 次/分；令牌可随时撤销，撤销即 401。

### 公开状态页

监控页「状态页」按钮配置：启用开关、自定义路径（`/status/<slug>`）、标题、勾选公开的监控（≤20 个，仅启用中的，停用自动隐藏）。访客免登录访问，页面 30 秒自动刷新；展示名称、状态、心跳条带、24h 在线率与平均延迟，地址与错误详情不公开。

### 其他

- cron 默认按 UTC；任务可指定生效时区（IANA 名称），按该时区墙上时间触发与展示。
- 调度器每分钟扫描；免费计划 Cron 触发延迟约 1 分钟。漏跑任务只补发一次，不逐轮追赶积压。

## 技术栈

Hono · React 18 · Vite · Tailwind CSS v4 · Cloudflare Workers · D1 · Vitest

## 许可证

[MIT](LICENSE)
