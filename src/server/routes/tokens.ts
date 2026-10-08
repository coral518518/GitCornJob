import { Hono } from "hono";
import { generateApiToken, sha256Hex } from "../crypto";
import type { ApiTokenRow, Env } from "../types";

const tokenRoutes = new Hono<{ Bindings: Env }>();

/** 列表脱敏视图：绝不返回 token_hash（凭据材料，哪怕不可逆也不该出库）与明文 */
function view(t: ApiTokenRow) {
  return {
    id: t.id,
    name: t.name,
    token_prefix: t.token_prefix,
    last_used_at: t.last_used_at,
    created_at: t.created_at,
  };
}

tokenRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM api_tokens ORDER BY id").all<ApiTokenRow>();
  return c.json({ ok: true, data: { tokens: (rows.results ?? []).map(view) } });
});

tokenRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 50) return c.json({ ok: false, error: "令牌名称必填（≤50 字）" }, 400);
  const token = generateApiToken();
  const now = Date.now();
  const r = await c.env.DB.prepare(
    "INSERT INTO api_tokens (name, token_hash, token_prefix, created_at, updated_at) VALUES (?,?,?,?,?)",
  )
    .bind(name, await sha256Hex(token), token.slice(0, 10), now, now)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM api_tokens WHERE id=?")
    .bind(r.meta.last_row_id)
    .first<ApiTokenRow>();
  // 明文只在创建响应出现这一次，之后任何接口都不再返回
  return c.json({
    ok: true,
    data: { ...(row ? view(row) : { name, token_prefix: token.slice(0, 10), last_used_at: null, created_at: now }), token },
  }, 201);
});

tokenRoutes.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM api_tokens WHERE id=?")
    .bind(Number(c.req.param("id")))
    .run();
  if ((r.meta.changes ?? 0) === 0) return c.json({ ok: false, error: "令牌不存在" }, 404);
  return c.json({ ok: true, data: null });
});

export default tokenRoutes;
