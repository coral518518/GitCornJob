import { createMiddleware } from "hono/factory";
import { Hono } from "hono";
import { sha256Hex } from "../crypto";
import { runDueJobs, type WaitUntilHost } from "../scheduler";
import { runDueMonitors } from "../monitor";
import type { ApiTokenRow, Env } from "../types";

/** 外部触发令牌校验：Bearer 令牌 → SHA-256 哈希查库，命中后更新 last_used_at。
 * 认证前先按 IP 限流：无令牌洪水也会烧 D1 读数配额，按 IP 压到 5 次/分
 * （key 加 trigger: 前缀，与登录限流独立计数）。 */
export const requireApiToken = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const rl = c.env.RATE_LIMITER;
  if (rl) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const r = await rl.limit({ key: `trigger:${ip}` });
    if (!r.success) return c.json({ ok: false, error: "请求过于频繁，请稍后再试" }, 429);
  }
  const m = /^Bearer\s+(\S+)$/.exec(c.req.header("Authorization") ?? "");
  const token = m?.[1] ?? "";
  if (!token) return c.json({ ok: false, error: "缺少 API Token（Authorization: Bearer <token>）" }, 401);
  const row = await c.env.DB.prepare("SELECT * FROM api_tokens WHERE token_hash=?")
    .bind(await sha256Hex(token))
    .first<ApiTokenRow>();
  if (!row) return c.json({ ok: false, error: "API Token 无效或已撤销" }, 401);
  await c.env.DB.prepare("UPDATE api_tokens SET last_used_at=? WHERE id=?").bind(Date.now(), row.id).run();
  await next();
});

const triggerRoutes = new Hono<{ Bindings: Env }>();
triggerRoutes.use("*", requireApiToken);

// 跑一轮完整调度，与 scheduled 处理器同构：到期任务 + 到期监控探测，调度器
// 心跳随 runDueJobs 开头自动写入（外部驱动时仪表盘判活依然成立）。两函数都
// 绝不外抛；与平台 cron 并存也安全——任务认领靠乐观锁，重复唤醒只会空跑。
triggerRoutes.post("/", async (c) => {
  // 第二层限流：令牌校验通过后的全局配额，保护调度本体不被高频触发
  // （认证前还有一层按 IP 的洪水防护，见 requireApiToken）。
  const rl = c.env.RATE_LIMITER;
  if (rl) {
    const r = await rl.limit({ key: "api_trigger" });
    if (!r.success) return c.json({ ok: false, error: "触发过于频繁，请稍后再试" }, 429);
  }
  const now = Date.now();
  // ctx 存在于真实 fetch 环境（通知收尾等挂 waitUntil 不阻塞响应）；
  // Hono .request() 的测试环境没有，兜底就地 await。
  let ctx: WaitUntilHost | undefined;
  try {
    ctx = c.executionCtx;
  } catch { /* 测试环境无 ExecutionContext */ }
  const [jobs, monitors] = await Promise.all([
    runDueJobs(c.env, now, ctx),
    runDueMonitors(c.env, now, ctx),
  ]);
  return c.json({
    ok: true,
    data: { triggered: jobs.triggered, failed: jobs.failed, probed: monitors.probed, down: monitors.down },
  });
});

export default triggerRoutes;
