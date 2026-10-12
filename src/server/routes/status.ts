import { Hono } from "hono";
import { getStatusPage } from "../settings";
import type { Env, MonitorRow } from "../types";

const statusRoutes = new Hono<{ Bindings: Env }>();

const DAY = 24 * 3600 * 1000;
const BEATS = 20;

// 公开状态页数据：只暴露配置选中的启用中监控，地址/错误详情在服务端裁剪
// 边缘缓存 30s + RateLimiter 防爆破，大幅保护 D1 读配额。
statusRoutes.get("/:slug", async (c) => {
  // 1. IP 限流防护：防止被脚本高频刷爆数据库
  const rl = c.env.RATE_LIMITER;
  if (rl) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const r = await rl.limit({ key: `status:${ip}` });
    if (!r.success) return c.json({ ok: false, error: "请求过于频繁，请稍后再试" }, 429);
  }

  // 2. 检查 Cloudflare 边缘 Cache API 缓存：若命中直接返回，不触碰 Worker CPU 与 D1
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch { /* 忽略本地/测试环境无缓存异常 */ }
  }

  const cfg = await getStatusPage(c.env);
  const slug = c.req.param("slug");
  if (!cfg || cfg.enabled !== 1 || cfg.slug !== slug) {
    return c.json({ ok: false, error: "状态页不存在或未开放" }, 404);
  }

  const now = Date.now();
  const ids = [...new Set(cfg.monitor_ids)].slice(0, 20);
  if (ids.length === 0) {
    return c.json({
      ok: true,
      data: { title: cfg.title, overall: "up", monitors: [] },
    });
  }

  const monitors = (await Promise.all(
    ids.map(async (id) => {
      const m = await c.env.DB.prepare("SELECT * FROM monitors WHERE id=?").bind(id).first<MonitorRow>();
      if (!m || m.enabled !== 1) return null; // 停用的监控自动从公开页消失
      const [stats, beatsRows] = await Promise.all([
        c.env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM heartbeats WHERE monitor_id=? AND created_at>=?) AS t24,
             (SELECT COUNT(*) FROM heartbeats WHERE monitor_id=? AND created_at>=? AND status='up') AS u24,
             (SELECT COUNT(*) FROM heartbeats WHERE monitor_id=? AND created_at>=?) AS t7,
             (SELECT COUNT(*) FROM heartbeats WHERE monitor_id=? AND created_at>=? AND status='up') AS u7,
             (SELECT CAST(AVG(latency_ms) AS INTEGER) FROM heartbeats WHERE monitor_id=? AND created_at>=? AND status='up') AS avg_latency_24h`,
        )
          .bind(id, now - DAY, id, now - DAY, id, now - 7 * DAY, id, now - 7 * DAY, id, now - DAY)
          .first<Record<string, number>>(),
        c.env.DB.prepare(
          "SELECT id, created_at, status, http_status, latency_ms, error_message FROM heartbeats WHERE monitor_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
          .bind(id, BEATS)
          .all<{ created_at: number; status: string; http_status: number | null; latency_ms: number | null }>(),
      ]);
      const s = stats ?? {};
      const pct = (t: unknown, u: unknown) => (Number(t) > 0 ? Math.round((Number(u) / Number(t)) * 100) : null);
      return {
        id: m.id,
        name: m.name,
        status: m.status,
        uptime_24h: pct(s.t24, s.u24),
        uptime_7d: pct(s.t7, s.u7),
        avg_latency_24h: s.avg_latency_24h ?? null,
        beats: (beatsRows.results ?? [])
          .reverse()
          .map((b) => ({
            created_at: b.created_at,
            status: b.status as "up" | "down",
            http_status: b.http_status,
            latency_ms: b.latency_ms,
          })),
      };
    }),
  )).filter((m): m is NonNullable<typeof m> => m !== null);

  const down = monitors.filter((m) => m.status === "down").length;
  c.header("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=30");
  const res = c.json({
    ok: true,
    data: { title: cfg.title, overall: down > 0 ? "down" : "up", monitors },
  });

  // 写入边缘 Cache API（缓存 30s），吸收外部并发与高频轮询
  if (cache) {
    try {
      const cloned = res.clone();
      let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
      try { ctx = c.executionCtx; } catch { /* 测试环境无 ExecutionContext */ }
      if (ctx) {
        ctx.waitUntil(cache.put(cacheKey, cloned));
      } else {
        await cache.put(cacheKey, cloned);
      }
    } catch { /* 忽略缓存写入失败 */ }
  }

  return res;
});

export default statusRoutes;
