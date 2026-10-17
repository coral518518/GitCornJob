import { Hono } from "hono";
import authRoutes from "./server/routes/auth";
import accountRoutes from "./server/routes/accounts";
import jobRoutes from "./server/routes/jobs";
import monitorRoutes from "./server/routes/monitors";
import runRoutes from "./server/routes/runs";
import miscRoutes from "./server/routes/misc";
import passwordRoutes from "./server/routes/password";
import notifyRoutes from "./server/routes/notify";
import githubRoutes from "./server/routes/github";
import tokenRoutes from "./server/routes/tokens";
import triggerRoutes from "./server/routes/trigger";
import statusRoutes from "./server/routes/status";
import statusPageRoutes from "./server/routes/status-page";
import emailJobRoutes from "./server/routes/email-jobs";
import { requireAuth } from "./server/middleware";
import { runDueJobs } from "./server/scheduler";
import { runDueMonitors } from "./server/monitor";
import { runDueEmailJobs } from "./server/email-scheduler";
import { ensureMigrated } from "./server/migrations";
import { PrismWorker, type AuthenticatedRequest, type PrismEnv, type PrismUser } from "prism-authts";
import type { Env } from "./server/types";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/auth", authRoutes);
// 外部触发：令牌自验（requireApiToken），不走管理员会话
app.route("/api/trigger", triggerRoutes);
// 公开状态页数据：只读、无认证，注册须在 /api 404 catchall 之前
app.route("/api/status", statusRoutes);

const protectedApi = new Hono<{ Bindings: Env }>();
protectedApi.use("*", requireAuth);
protectedApi.route("/accounts", accountRoutes);
protectedApi.route("/jobs", jobRoutes);
protectedApi.route("/email-jobs", emailJobRoutes);
protectedApi.route("/monitors", monitorRoutes);
protectedApi.route("/runs", runRoutes);
protectedApi.route("/password", passwordRoutes);
protectedApi.route("/notify", notifyRoutes);
protectedApi.route("/github", githubRoutes);
protectedApi.route("/tokens", tokenRoutes);
protectedApi.route("/status-page", statusPageRoutes);
protectedApi.route("/", miscRoutes); // /stats 与 /cron/preview
app.route("/api", protectedApi);

app.all("/api/*", (c) => c.json({ ok: false, error: "Not Found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * 基于 prism-authts 的站点最外层 SSO 网关：
 * 1. 访问站点页面时：若无 Prism 鉴权直接 302 重定向到 Prism 鉴权；鉴权完成自动跳回。
 * 2. 接口 (/api/*) 与静态资源白名单放行：接口由内部 Hono 的 requireAuth 校验管理员密码，无需 Prism 鉴权。
 * 3. 两层鉴权并存：先过 Prism SSO 网关，再输入管理员密码登录系统。
 */
class GatewayWorker extends PrismWorker {
  override isPublic(url: URL, request: Request): boolean {
    // 接口无需 Prism 鉴权，由内部 Hono 处理管理员会话及 API 令牌
    if (url.pathname.startsWith("/api/")) {
      return true;
    }
    // 静态资源与图标无需重复鉴权
    if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
      return true;
    }
    // 公开状态页免登录放行
    if (url.pathname.startsWith("/status/") || url.pathname === "/status") {
      return true;
    }
    return super.isPublic(url, request);
  }

  override async handleRequest(
    request: AuthenticatedRequest,
    env: PrismEnv,
    ctx: ExecutionContext,
    _user: PrismUser | null
  ): Promise<Response> {
    const fullEnv = env as unknown as Env;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return fullEnv.ASSETS.fetch(request);
    }
    await ensureMigrated(fullEnv);
    return app.fetch(request, fullEnv, ctx);
  }
}

const gateway = new GatewayWorker();

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    // 若未配置 Prism 相关环境变量（如未启用 Prism 或本地调试），优雅降级为直接访问
    if (!env.PRISM_URL || !env.PRISM_CLIENT_ID || !env.PRISM_CLIENT_SECRET) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(req);
      }
      await ensureMigrated(env);
      return app.fetch(req, env, ctx);
    }

    // 已配置 Prism：由 prism-authts 作为最外层门禁拦截未登录访问，通过后方可进入系统输入管理员密码
    return gateway.fetch(req, env as unknown as PrismEnv, ctx);
  },
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    await ensureMigrated(env);
    const now = Date.now();
    await runDueJobs(env, now, ctx);
    await runDueMonitors(env, now, ctx);
    await runDueEmailJobs(env, now, ctx);
  },
} satisfies ExportedHandler<Env>;
