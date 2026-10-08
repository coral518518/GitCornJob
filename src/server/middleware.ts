import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { getEncryptionKey, verifySessionToken } from "./crypto";
import { getAuthState } from "./settings";
import type { Env } from "./types";

// 挂载在 /api/*（auth 路由除外），校验管理员密码会话 Cookie。
// 站点入口已由最外层 prism-authts 网关完成 SSO 鉴权；进入站点后接口纯走管理员会话。
export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = getCookie(c, "session");
  const { epoch } = await getAuthState(c.env);
  let secret: string;
  try {
    secret = getEncryptionKey(c.env);
  } catch {
    return c.json({ ok: false, error: "系统秘钥未配置" }, 500);
  }
  if (!token || !(await verifySessionToken(token, secret, epoch))) {
    return c.json({ ok: false, error: "未登录" }, 401);
  }
  await next();
});
