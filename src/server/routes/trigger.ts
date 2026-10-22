import { createMiddleware } from "hono/factory";
import { Hono, type Context } from "hono";
import { sha256Hex } from "../crypto";
import { runDueJobs, triggerJobOnce, type WaitUntilHost } from "../scheduler";
import { runDueMonitors } from "../monitor";
import { runDueEmailJobs, triggerEmailJobOnce } from "../email-scheduler";
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
  // 节流写入 last_used_at：距上次记录超过 5 分钟才写库，节约 D1 写入配额
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 5 * 60_000) {
    await c.env.DB.prepare("UPDATE api_tokens SET last_used_at=? WHERE id=?").bind(now, row.id).run();
  }
  await next();
});

const triggerRoutes = new Hono<{ Bindings: Env }>();
triggerRoutes.use("*", requireApiToken);

// 跑一轮完整调度，与 scheduled 处理器同构：到期任务 + 到期监控探测 + 到期定时任务（邮件/HTTP/ClawBot），调度器
// 心跳随 runDueJobs 内部按 10 分钟整点写入（节约 D1 写入配额）。各函数都
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
  const [jobs, monitors, emailJobs] = await Promise.all([
    runDueJobs(c.env, now, ctx),
    runDueMonitors(c.env, now, ctx),
    runDueEmailJobs(c.env, now, ctx),
  ]);
  return c.json({
    ok: true,
    data: {
      triggered: jobs.triggered,
      failed: jobs.failed,
      probed: monitors.probed,
      down: monitors.down,
      emailTriggered: emailJobs.triggered,
      emailFailed: emailJobs.failed,
    },
  });
});

// 单独触发指定的「定时GithubAction」
triggerRoutes.post("/jobs/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ ok: false, error: "任务 ID 无效" }, 400);
  }
  const result = await triggerJobOnce(c.env, id, "manual");
  if ("notFound" in result) return c.json({ ok: false, error: "GithubAction 任务不存在" }, 404);
  if (!result.ok) return c.json({ ok: false, error: result.error ?? "触发失败" }, 502);
  return c.json({ ok: true, data: null });
});

// 单独触发指定的「定时任务」（邮件 / HTTP 接口 / 微信 ClawBot）
async function handleTriggerTask(c: Context<{ Bindings: Env }>) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ ok: false, error: "任务 ID 无效" }, 400);
  }
  const outcome = await triggerEmailJobOnce(c.env, id, "manual");
  if ("notFound" in outcome) return c.json({ ok: false, error: "定时任务不存在" }, 404);
  if (!outcome.ok) return c.json({ ok: false, error: outcome.error ?? "执行失败" }, 502);
  return c.json({ ok: true, data: outcome });
}

triggerRoutes.post("/tasks/:id", handleTriggerTask);
triggerRoutes.post("/email-jobs/:id", handleTriggerTask);

export default triggerRoutes;
