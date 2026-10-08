// settings 表读写 + 认证状态的 isolate 级缓存。
// 缓存只为给 requireAuth 省一次 D1 读：每个 isolate 每 60 秒最多回源一次；
// 改密路由写库后立即失效缓存，其他 isolate 最迟 60 秒内收敛。
import type { Env } from "./types";

export const KEY_PASSWORD_HASH = "admin_password_hash";
export const KEY_SESSION_EPOCH = "session_epoch";
export const KEY_RUNS_RETENTION = "runs_retention_days";
/** 调度器心跳：scheduled 入口每轮写入，仪表盘据此展示调度器是否存活 */
export const KEY_SCHEDULER_HEARTBEAT = "scheduler_last_run_at";
/** 连续失败自动停用阈值（0 = 不自动停用） */
export const KEY_AUTO_PAUSE_THRESHOLD = "notify_auto_pause_threshold";
/** 运行记录保留期默认值（天），与调度器/清理接口的兜底一致 */
export const DEFAULT_RUN_RETENTION_DAYS = 90;
/** 心跳记录保留期（天）：每监控每天最多 1440 条（1 分钟粒度），默认 30 天控制数据量 */
export const KEY_HEARTBEATS_RETENTION = "heartbeats_retention_days";
export const DEFAULT_HEARTBEAT_RETENTION_DAYS = 30;

/** 读取单个配置；无缓存（调用频率低：改密/改保留期/每分钟的调度清理）。 */
export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

type AuthState = { hash: string | null; epoch: number };

let cache: (AuthState & { at: number }) | null = null;
const CACHE_TTL = 60_000;

export async function getAuthState(env: Env): Promise<AuthState> {
  if (cache && Date.now() - cache.at < CACHE_TTL) {
    return { hash: cache.hash, epoch: cache.epoch };
  }
  const [hashRow, epochRow] = await Promise.all([
    env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(KEY_PASSWORD_HASH)
      .first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(KEY_SESSION_EPOCH)
      .first<{ value: string }>(),
  ]);
  const state: AuthState = {
    hash: hashRow?.value ?? null,
    epoch: Number(epochRow?.value ?? 0) || 0,
  };
  cache = { ...state, at: Date.now() };
  return state;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)")
    .bind(key, value)
    .run();
}

/** 连续失败自动停用阈值；未配置/非法值收敛为 0（不自动停用） */
export async function getAutoPauseThreshold(env: Env): Promise<number> {
  try {
    const v = Number(await getSetting(env, KEY_AUTO_PAUSE_THRESHOLD));
    return Number.isInteger(v) && v >= 0 && v <= 100 ? v : 0;
  } catch {
    return 0; // D1 瞬时错误视同未开启，不阻断调度
  }
}

// ---- 公开状态页（单页）：配置 JSON 存 settings，损坏按未启用处理 ----

export const KEY_STATUS_PAGE = "status_page";

export type StatusPageConfig = {
  /** 1 = 对外开放 */
  enabled: number;
  slug: string;
  title: string;
  monitor_ids: number[];
};

export async function getStatusPage(env: Env): Promise<StatusPageConfig | null> {
  const raw = await getSetting(env, KEY_STATUS_PAGE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StatusPageConfig;
    if (!parsed || typeof parsed.slug !== "string" || !Array.isArray(parsed.monitor_ids)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setStatusPage(env: Env, config: StatusPageConfig): Promise<void> {
  await setSetting(env, KEY_STATUS_PAGE, JSON.stringify(config));
}

export function invalidateAuthState(): void {
  cache = null;
}

/** 测试隔离用：beforeEach 里清掉模块级缓存 */
export function _resetAuthState(): void {
  cache = null;
}
