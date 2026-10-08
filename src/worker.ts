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
import { requireAuth } from "./server/middleware";
import { runDueJobs } from "./server/scheduler";
import { runDueMonitors } from "./server/monitor";
import { ensureMigrated } from "./server/migrations";
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

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }
    return ensureMigrated(env).then(() => app.fetch(req, env, ctx));
  },
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    await ensureMigrated(env);
    const now = Date.now();
    await runDueJobs(env, now, ctx);
    await runDueMonitors(env, now, ctx);
  },
} satisfies ExportedHandler<Env>;
