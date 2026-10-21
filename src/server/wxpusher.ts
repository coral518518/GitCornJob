import { getSetting, setSetting } from "./settings";
import type { Env } from "./types";

export const KEY_WXPUSHER_APP_TOKEN = "wxpusher_app_token";
export const KEY_WXPUSHER_DEFAULT_UIDS = "wxpusher_default_uids";

export type WxPusherConfig = {
  appToken: string;
  defaultUids: string;
  source: "db" | "env" | "none";
};

export function maskAppToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 5)}••••${token.slice(-4)}`;
}

export function parseWxPusherUids(input: string | null | undefined): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
      }
    } catch {
      /* 回退到分割 */
    }
  }
  return [...new Set(trimmed.split(/[\r\n,;，；]+/).map((s) => s.trim()).filter(Boolean))];
}

/** 从 Telegram 告警 URL 或直接填写的 Token 中提取 Bot Token */
export function extractTgBotToken(urlOrToken: string): string {
  const trimmed = (urlOrToken || "").trim();
  if (!trimmed) return "";
  // 直接是 token 格式（例如 123456789:ABCdefGhIjkLmNoPqRsTuVwXyZ）
  if (/^[0-9]+:[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  // 从 URL 中提取：https://api.telegram.org/bot<TOKEN>/...
  const match = trimmed.match(/\/bot([0-9]+:[a-zA-Z0-9_-]+)/i);
  if (match) return match[1];
  return trimmed;
}

/**
 * 解析 Telegram Bot Token：
 * - 若格式为 "channel:12"，从 notify_channels 表中直接读取对应渠道的 URL 并提取 Token；
 * - 否则直接使用 extractTgBotToken 解析字符串或 URL。
 */
export async function resolveTgBotToken(tokenOrChannel: string, env: Env): Promise<string> {
  const trimmed = (tokenOrChannel || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("channel:")) {
    const chId = Number(trimmed.replace("channel:", ""));
    if (chId > 0) {
      const row = await env.DB.prepare("SELECT url FROM notify_channels WHERE id=? AND type='telegram'")
        .bind(chId)
        .first<{ url: string }>()
        .catch(() => null);
      if (row && row.url) {
        return extractTgBotToken(row.url);
      }
    }
    return "";
  }
  return extractTgBotToken(trimmed);
}

export async function getWxPusherConfig(env: Env): Promise<WxPusherConfig> {
  const [dbToken, dbUids] = await Promise.all([
    getSetting(env, KEY_WXPUSHER_APP_TOKEN).catch(() => null),
    getSetting(env, KEY_WXPUSHER_DEFAULT_UIDS).catch(() => null),
  ]);

  let appToken = "";
  let source: WxPusherConfig["source"] = "none";

  if (dbToken && dbToken.trim()) {
    appToken = dbToken.trim();
    source = "db";
  } else if (env.WXPUSHER_APP_TOKEN && env.WXPUSHER_APP_TOKEN.trim()) {
    appToken = env.WXPUSHER_APP_TOKEN.trim();
    source = "env";
  }

  return {
    appToken,
    defaultUids: (dbUids || "").trim(),
    source,
  };
}

export async function saveWxPusherConfig(
  env: Env,
  cfg: { appToken?: string; defaultUids?: string }
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (cfg.appToken !== undefined) {
    tasks.push(setSetting(env, KEY_WXPUSHER_APP_TOKEN, cfg.appToken.trim()));
  }
  if (cfg.defaultUids !== undefined) {
    tasks.push(setSetting(env, KEY_WXPUSHER_DEFAULT_UIDS, cfg.defaultUids.trim()));
  }
  await Promise.all(tasks);
}

export type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string };
  audio?: { title?: string };
  video?: unknown;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  edited_message?: TgMessage;
};

/**
 * 调用 Telegram Bot getUpdates 接口轮询新消息
 * offset: 上次消费过的最大 update_id + 1
 */
export async function fetchTgBotUpdates(
  botToken: string,
  offset?: number,
  timeout = 0
): Promise<{ ok: boolean; updates: TgUpdate[]; error?: string; latencyMs: number }> {
  const start = Date.now();
  const token = extractTgBotToken(botToken);
  if (!token) {
    return { ok: false, updates: [], error: "Telegram Bot Token 为空或格式无效", latencyMs: 0 };
  }

  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  const body: Record<string, unknown> = {
    timeout,
    allowed_updates: ["message", "channel_post"],
  };
  if (typeof offset === "number" && offset > 0) {
    body.offset = offset;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        updates: [],
        error: `Telegram API 报错 HTTP ${res.status}: ${errText.slice(0, 200)}`,
        latencyMs,
      };
    }

    const data = (await res.json()) as { ok: boolean; result?: TgUpdate[]; description?: string };
    if (!data.ok || !Array.isArray(data.result)) {
      return {
        ok: false,
        updates: [],
        error: data.description || "获取 Telegram 更新失败",
        latencyMs,
      };
    }

    return {
      ok: true,
      updates: data.result,
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      updates: [],
      error: (err as Error)?.message || "网络请求异常",
      latencyMs,
    };
  }
}

/** 将获取到的 Telegram 消息结构排版格式化为 WxPusher Markdown */
export function formatTgUpdatesToMarkdown(
  updates: TgUpdate[],
  tz = "Asia/Shanghai"
): { title: string; content: string; summary: string } {
  const count = updates.length;
  const now = new Date();
  let timeStr = "";
  try {
    timeStr = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz || "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    timeStr = now.toISOString().slice(5, 19).replace("T", " ");
  }

  const title = `🤖 Telegram 未读消息汇总 (${count} 条)`;
  const lines: string[] = [];

  lines.push(`### 🤖 Telegram 新消息汇总 (${count} 条)`);
  lines.push(`> 采集时间：${timeStr}`);
  lines.push("");

  updates.forEach((item, index) => {
    const msg = item.message || item.channel_post || item.edited_message;
    if (!msg) return;

    let sender = "";
    if (msg.from) {
      const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
      sender = name || msg.from.username || `User #${msg.from.id}`;
      if (msg.from.username && name) sender += ` (@${msg.from.username})`;
    } else if (msg.chat) {
      sender = msg.chat.title || msg.chat.username || "频道/群组";
    }

    let chatInfo = "";
    if (msg.chat && msg.chat.type !== "private" && msg.chat.title) {
      chatInfo = ` [${msg.chat.title}]`;
    }

    let msgTime = "";
    if (msg.date) {
      try {
        msgTime = new Intl.DateTimeFormat("zh-CN", {
          timeZone: tz || "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(msg.date * 1000));
      } catch {
        msgTime = "";
      }
    }

    let body = msg.text || msg.caption || "";
    if (!body) {
      if (msg.photo) body = "📷 [图片消息]";
      else if (msg.document) body = `📎 [文件] ${msg.document.file_name || ""}`.trim();
      else if (msg.audio) body = `🎵 [音频] ${msg.audio.title || ""}`.trim();
      else if (msg.video) body = "📹 [视频消息]";
      else body = "💬 [收到新消息]";
    }

    lines.push(`---\n`);
    lines.push(`**${index + 1}. ${sender}**${chatInfo}${msgTime ? ` · \`${msgTime}\`` : ""}`);
    lines.push(body);
    lines.push("");
  });

  const firstMsg = updates[0]?.message || updates[0]?.channel_post;
  const firstText = firstMsg?.text || firstMsg?.caption || "新未读消息";
  const summary = `收到 ${count} 条新消息：${firstText.slice(0, 40)}`;

  return {
    title,
    content: lines.join("\n"),
    summary,
  };
}

/** 调用 WxPusher 发送微信消息 */
export async function sendWxPusherMessage(opts: {
  appToken: string;
  content: string;
  contentType?: number; // 1: 文本, 2: HTML, 3: Markdown (默认 3)
  uids: string[];
  summary?: string;
  url?: string;
}): Promise<{ ok: boolean; code?: number; msg?: string; latencyMs: number }> {
  const start = Date.now();
  const appToken = opts.appToken.trim();
  if (!appToken) {
    return { ok: false, msg: "未配置 WxPusher App Token", latencyMs: 0 };
  }

  const uids = opts.uids.map((s) => s.trim()).filter(Boolean);
  if (uids.length === 0) {
    return { ok: false, msg: "未指定接收消息的 WxPusher UID", latencyMs: 0 };
  }

  const payload: Record<string, unknown> = {
    appToken,
    content: opts.content,
    contentType: opts.contentType ?? 3,
    uids,
  };
  if (opts.summary) {
    payload.summary = opts.summary.slice(0, 100);
  }
  if (opts.url) {
    payload.url = opts.url;
  }

  try {
    const res = await fetch("https://wxpusher.zjiecode.com/api/send/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        msg: `WxPusher 接口返回 HTTP ${res.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }

    const data = (await res.json()) as {
      code: number;
      msg: string;
      data?: Array<{ uid: string; code: number; status: string }>;
      success?: boolean;
    };

    // WxPusher 返回 code: 1000 表示提交成功
    const isSuccess = data.code === 1000 || data.success === true;
    return {
      ok: isSuccess,
      code: data.code,
      msg: isSuccess ? "发送成功" : data.msg || "发送失败",
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      msg: (err as Error)?.message || "网络请求异常",
      latencyMs,
    };
  }
}
