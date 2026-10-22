import { Hono } from "hono";
import { computeNextRun, isValidTimezone, validateSchedule, type ScheduleRule } from "../schedule";
import { getResendConfig, maskApiKey, parseApiKeys, parseEmailList, saveResendConfig, sendResendEmail } from "../email";
import { fetchChannelPosts, parseTgChannels, parseTgKeywords, type TgPost } from "../tg-monitor";
import { executeHttpRequest, triggerEmailJobOnce } from "../email-scheduler";
import { assertChannelsExist } from "./jobs";
import {
  extractTgBotToken,
  fetchTgBotUpdates,
  getWxPusherConfig,
  maskAppToken,
  parseWxPusherUids,
  resolveTgBotToken,
  saveWxPusherConfig,
  sendWxPusherMessage,
} from "../wxpusher";
import { getChannel } from "../notify";
import type { EmailJobRow, Env, TaskType } from "../types";

const emailJobRoutes = new Hono<{ Bindings: Env }>();

// -------------------------------------------------------------
// WxPusher 微信配置与测试接口
// -------------------------------------------------------------

emailJobRoutes.get("/wxpusher-config", async (c) => {
  const cfg = await getWxPusherConfig(c.env);
  return c.json({
    ok: true,
    data: {
      isConfigured: !!cfg.appToken,
      appTokenMasked: maskAppToken(cfg.appToken),
      defaultUids: cfg.defaultUids,
      source: cfg.source,
    },
  });
});

emailJobRoutes.put("/wxpusher-config", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : undefined;
  const defaultUids = typeof body.defaultUids === "string" ? body.defaultUids.trim() : undefined;

  await saveWxPusherConfig(c.env, { appToken, defaultUids });
  const updated = await getWxPusherConfig(c.env);
  return c.json({
    ok: true,
    data: {
      isConfigured: !!updated.appToken,
      appTokenMasked: maskAppToken(updated.appToken),
      defaultUids: updated.defaultUids,
      source: updated.source,
    },
  });
});

emailJobRoutes.post("/wxpusher-test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const cfg = await getWxPusherConfig(c.env);
  const appToken = (typeof body.appToken === "string" && body.appToken.trim()) || cfg.appToken;
  if (!appToken) {
    return c.json({ ok: false, error: "未提供或未保存 WxPusher App Token" }, 400);
  }

  const rawUids = typeof body.uids === "string" && body.uids.trim() ? body.uids : cfg.defaultUids;
  const uids = parseWxPusherUids(rawUids);
  if (uids.length === 0) {
    return c.json({ ok: false, error: "请填写至少一个测试接收 UID" }, 400);
  }

  const content = typeof body.content === "string" && body.content.trim()
    ? body.content.trim()
    : `### 🔔 WxPusher 连通性测试\n这是一条来自定时任务系统的微信推送测试消息。\n\n- 测试时间：\`${new Date().toLocaleString("zh-CN")}\`\n- 状态：**运作正常**`;

  const res = await sendWxPusherMessage({
    appToken,
    content,
    contentType: 3,
    uids,
    summary: "WxPusher 连通性测试消息",
  });

  if (!res.ok) {
    return c.json({ ok: false, error: res.msg || "发送测试消息失败", latencyMs: res.latencyMs }, 502);
  }

  return c.json({
    ok: true,
    data: {
      latencyMs: res.latencyMs,
      msg: res.msg,
      count: uids.length,
      uids,
    },
  });
});

emailJobRoutes.post("/test-tg-bot", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const rawToken = typeof body.token === "string" ? body.token.trim() : (typeof body.botToken === "string" ? body.botToken.trim() : "");
  const botToken = await resolveTgBotToken(rawToken, c.env);

  if (!botToken) {
    return c.json({ ok: false, error: "请选择有效渠道或输入 Telegram Bot Token" }, 400);
  }

  // 获取 Telegram Bot 基本信息
  let botInfo: { id: number; username: string; first_name: string } | undefined = undefined;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (meRes.ok) {
      const meData = (await meRes.json()) as { ok: boolean; result?: { id: number; username: string; first_name: string } };
      if (meData.ok && meData.result) {
        botInfo = {
          id: meData.result.id,
          username: meData.result.username,
          first_name: meData.result.first_name,
        };
      }
    }
  } catch {
    /* 允许 getMe 容错，继续尝试获取 getUpdates */
  }

  const res = await fetchTgBotUpdates(botToken, undefined, 0);
  if (!res.ok) {
    return c.json({ ok: false, error: res.error || "探测失败" }, 502);
  }

  return c.json({
    ok: true,
    data: {
      ok: true,
      bot: botInfo,
      unreadCount: res.updates.length,
      messageCount: res.updates.length,
      latencyMs: res.latencyMs,
      previews: res.updates.slice(-5).map((u) => {
        const m = u.message || u.channel_post || u.edited_message;
        return {
          updateId: u.update_id,
          sender: m?.from?.first_name || m?.chat?.title || "未知",
          text: m?.text || m?.caption || "[多媒体消息]",
          date: m?.date ? new Date(m.date * 1000).toLocaleString("zh-CN") : "",
        };
      }),
    },
  });
});

// -------------------------------------------------------------
// HTTP 接口在线测试与探测接口
// -------------------------------------------------------------

emailJobRoutes.post("/test-http", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return c.json({ ok: false, error: "请填写待测试的目标接口 URL" }, 400);
  }
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ ok: false, error: "接口 URL 格式不正确，必须以 http:// 或 https:// 开头" }, 400);
  }
  const method = typeof body.method === "string" ? body.method.trim().toUpperCase() : "GET";
  const headers = typeof body.headers === "string" ? body.headers : (typeof body.headers === "object" ? JSON.stringify(body.headers) : "");
  const reqBody = typeof body.body === "string" ? body.body : undefined;
  const expectedStatus = typeof body.expected_status === "string"
    ? body.expected_status
    : typeof body.http_expected_status === "string"
    ? body.http_expected_status
    : undefined;

  const res = await executeHttpRequest({
    url,
    method,
    headers,
    body: reqBody,
    expectedStatus,
    timeoutMs: 15000,
  });

  return c.json({
    ok: true,
    data: {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      latencyMs: res.latencyMs,
      headers: res.headers,
      bodyPreview: res.bodyPreview,
      error: res.error,
    },
  });
});

// -------------------------------------------------------------
// Resend 配置与测试发信接口（支持多密钥轮询与自动备用）
// -------------------------------------------------------------

emailJobRoutes.get("/config", async (c) => {
  const cfg = await getResendConfig(c.env);
  return c.json({
    ok: true,
    data: {
      isConfigured: cfg.apiKeys.length > 0,
      keyCount: cfg.apiKeys.length,
      apiKeyMasked: cfg.apiKey ? maskApiKey(cfg.apiKey) : "",
      apiKeysMasked: cfg.apiKeys.map(maskApiKey),
      from: cfg.from,
      replyTo: cfg.replyTo ?? "",
      source: cfg.source,
    },
  });
});

emailJobRoutes.put("/config", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const from = typeof body.from === "string" ? body.from.trim() : undefined;
  const replyTo = typeof body.replyTo === "string" ? body.replyTo.trim() : undefined;

  let apiKeys: string[] | undefined = undefined;
  if (Array.isArray(body.apiKeys)) {
    apiKeys = body.apiKeys.map(String).map((s) => s.trim()).filter(Boolean);
  } else if (typeof body.apiKeys === "string" && body.apiKeys.trim()) {
    apiKeys = parseApiKeys(body.apiKeys);
  } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    apiKeys = parseApiKeys(body.apiKey);
  }

  if (from !== undefined && !from) {
    return c.json({ ok: false, error: "发件人地址不能为空" }, 400);
  }

  await saveResendConfig(c.env, {
    apiKeys,
    from,
    replyTo: replyTo ?? "",
  });

  const updated = await getResendConfig(c.env);
  return c.json({
    ok: true,
    data: {
      isConfigured: updated.apiKeys.length > 0,
      keyCount: updated.apiKeys.length,
      apiKeyMasked: updated.apiKey ? maskApiKey(updated.apiKey) : "",
      apiKeysMasked: updated.apiKeys.map(maskApiKey),
      from: updated.from,
      replyTo: updated.replyTo ?? "",
      source: updated.source,
    },
  });
});

emailJobRoutes.post("/test", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const toList = parseEmailList(to);
  if (toList.length === 0) {
    return c.json({ ok: false, error: "请填写有效的测试收件人邮箱" }, 400);
  }

  const storedCfg = await getResendConfig(c.env);
  let testKeys = storedCfg.apiKeys;
  if (typeof body.apiKeys === "string" && body.apiKeys.trim()) {
    testKeys = parseApiKeys(body.apiKeys);
  } else if (Array.isArray(body.apiKeys) && body.apiKeys.length > 0) {
    testKeys = body.apiKeys.map(String).map((s) => s.trim()).filter(Boolean);
  } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    testKeys = parseApiKeys(body.apiKey);
  }

  const from = (typeof body.from === "string" && body.from.trim()) || storedCfg.from;
  const replyTo = typeof body.replyTo === "string" ? body.replyTo.trim() : storedCfg.replyTo;

  if (testKeys.length === 0) {
    return c.json({ ok: false, error: "未提供或未保存 Resend API Key" }, 400);
  }

  const testSubject = typeof body.subject === "string" && body.subject.trim()
    ? body.subject.trim()
    : "【连通性测试】Actions Cronjob 邮件服务测试";

  const testContent = typeof body.content === "string" && body.content.trim()
    ? body.content.trim()
    : `这是一封由 Actions Cronjob 系统发出的测试邮件。\n\n恭喜！您的 Resend 邮件配置运作正常。\n发信时间：${new Date().toLocaleString("zh-CN")}`;

  const res = await sendResendEmail({
    apiKeys: testKeys,
    from,
    to: toList,
    subject: testSubject,
    content: testContent,
    contentType: (body.contentType as "text" | "html" | "markdown") || "markdown",
    replyTo: replyTo || undefined,
  });

  if (!res.ok) {
    return c.json({ ok: false, error: res.error ?? "发信失败", latencyMs: res.latencyMs }, 502);
  }

  return c.json({ ok: true, data: { resendId: res.id, latencyMs: res.latencyMs, usedKeyMasked: res.usedKeyMasked } });
});

// -------------------------------------------------------------
// Telegram 频道在线抓取探测接口
// -------------------------------------------------------------

emailJobRoutes.post("/test-tg", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const channelsInput = typeof body.channels === "string" ? body.channels.trim() : "";
  const channels = parseTgChannels(channelsInput);
  if (channels.length === 0) {
    return c.json({ ok: false, error: "请填写至少一个有效的 Telegram 频道用户名或公开链接" }, 400);
  }

  const keywords = typeof body.keywords === "string" ? parseTgKeywords(body.keywords) : undefined;
  const results: Array<{ channel: string; latestId: number; posts: TgPost[]; error?: string }> = [];

  for (const ch of channels) {
    const res = await fetchChannelPosts(ch, 0, keywords);
    results.push({
      channel: ch,
      latestId: res.latestId,
      posts: res.newPosts.slice(-5), // 预览前 5 条
      error: res.error,
    });
  }

  const totalPosts = results.reduce((sum, r) => sum + r.posts.length, 0);
  return c.json({ ok: true, data: { channels, results, totalPosts } });
});

// -------------------------------------------------------------
// 邮件任务 CRUD 接口
// -------------------------------------------------------------

type EmailJobInput = {
  name: string;
  task_type: TaskType;
  to_emails: string;
  cc_emails: string | null;
  bcc_emails: string | null;
  subject: string;
  content: string;
  content_type: "text" | "html" | "markdown";
  http_url: string | null;
  http_method: string | null;
  http_headers: string | null;
  http_body: string | null;
  http_expected_status: string | null;
  wxpusher_uids: string | null;
  tg_bot_token: string | null;
  notify: number;
  notify_channel_ids: string | null;
  timezone: string | null;
  tg_channels: string | null;
  tg_keywords: string | null;
};

function validateEmailJobBody(body: Record<string, unknown>): {
  ok: true;
  data: EmailJobInput;
  schedule: ScheduleRule;
  enabled: number;
} | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return { ok: false, error: "任务名必填（≤100 字）" };

  const task_type: TaskType = body.task_type === "clawbot"
    ? "clawbot"
    : body.task_type === "http"
    ? "http"
    : "email";

  let to_emails = "";
  let cc_emails: string | null = null;
  let bcc_emails: string | null = null;
  let subject = "";
  let content = "";
  let content_type: "text" | "html" | "markdown" = "html";
  let tg_channels: string | null = null;
  let tg_keywords: string | null = null;

  let http_url: string | null = null;
  let http_method: string | null = null;
  let http_headers: string | null = null;
  let http_body: string | null = null;
  let http_expected_status: string | null = null;

  let wxpusher_uids: string | null = null;
  let tg_bot_token: string | null = null;

  if (task_type === "clawbot") {
    const rawUids = typeof body.wxpusher_uids === "string" ? body.wxpusher_uids.trim() : "";
    const parsedUids = parseWxPusherUids(rawUids);
    wxpusher_uids = parsedUids.join(", ");

    tg_bot_token = typeof body.tg_bot_token === "string" && body.tg_bot_token.trim()
      ? body.tg_bot_token.trim()
      : null;

    to_emails = "";
    subject = "Telegram 机器人未读消息 -> 微信ClawBot";
    content = "";
    content_type = "markdown";
  } else if (task_type === "http") {
    http_url = typeof body.http_url === "string" ? body.http_url.trim() : "";
    if (!http_url) return { ok: false, error: "接口地址 (URL) 不能为空" };
    if (!/^https?:\/\//i.test(http_url)) {
      return { ok: false, error: "接口 URL 格式不正确，必须以 http:// 或 https:// 开头" };
    }

    const rawMethod = typeof body.http_method === "string" ? body.http_method.trim().toUpperCase() : "GET";
    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
    http_method = validMethods.includes(rawMethod) ? rawMethod : "GET";

    if (typeof body.http_headers === "string" && body.http_headers.trim()) {
      http_headers = body.http_headers.trim();
    }
    if (typeof body.http_body === "string" && body.http_body.trim() && http_method !== "GET" && http_method !== "HEAD") {
      http_body = body.http_body;
    }
    if (typeof body.http_expected_status === "string" && body.http_expected_status.trim()) {
      http_expected_status = body.http_expected_status.trim();
    }

    // 默认值填充，兼容老旧 D1 NOT NULL 约束
    to_emails = "";
    subject = `${http_method} ${http_url}`;
    content = "";
    content_type = "text";
  } else {
    // 邮件类型任务校验
    const rawTo = typeof body.to_emails === "string" ? body.to_emails.trim() : "";
    const parsedTo = parseEmailList(rawTo);
    if (parsedTo.length === 0) return { ok: false, error: "请填写至少一个有效的收件人邮箱" };
    to_emails = parsedTo.join(", ");

    cc_emails = typeof body.cc_emails === "string" && body.cc_emails.trim() ? body.cc_emails.trim() : null;
    bcc_emails = typeof body.bcc_emails === "string" && body.bcc_emails.trim() ? body.bcc_emails.trim() : null;

    subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (!subject || subject.length > 300) return { ok: false, error: "邮件标题必填（≤300 字）" };

    content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return { ok: false, error: "邮件内容不能为空" };

    if (body.content_type === "text" || body.content_type === "markdown" || body.content_type === "html") {
      content_type = body.content_type;
    }

    if (typeof body.tg_channels === "string" && body.tg_channels.trim()) {
      const chs = parseTgChannels(body.tg_channels);
      tg_channels = chs.length > 0 ? chs.join(", ") : null;
    }

    if (typeof body.tg_keywords === "string" && body.tg_keywords.trim()) {
      const kws = parseTgKeywords(body.tg_keywords);
      tg_keywords = kws.length > 0 ? kws.join(", ") : null;
    }
  }

  const sv = validateSchedule(body.schedule);
  if (!sv.ok) return { ok: false, error: sv.error };

  const enabled = body.enabled === 0 || body.enabled === false ? 0 : 1;
  const notify = body.notify === 1 || body.notify === true ? 1 : 0;

  let notify_channel_ids: string | null = null;
  if (Array.isArray(body.notify_channel_ids)) {
    const ids = [...new Set(body.notify_channel_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    notify_channel_ids = ids.length ? JSON.stringify(ids) : null;
  }

  let timezone: string | null = null;
  if (typeof body.timezone === "string" && body.timezone.trim()) {
    timezone = body.timezone.trim();
    if (!isValidTimezone(timezone)) return { ok: false, error: "时区名称无效（应为 IANA 时区，如 Asia/Shanghai）" };
  }

  return {
    ok: true,
    data: {
      name,
      task_type,
      to_emails,
      cc_emails,
      bcc_emails,
      subject,
      content,
      content_type,
      http_url,
      http_method,
      http_headers,
      http_body,
      http_expected_status,
      wxpusher_uids,
      tg_bot_token,
      notify,
      notify_channel_ids,
      timezone,
      tg_channels,
      tg_keywords,
    },
    schedule: sv.rule,
    enabled,
  };
}

emailJobRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT j.*,
       (SELECT status FROM email_logs WHERE job_id=j.id ORDER BY triggered_at DESC LIMIT 1) AS last_status,
       (SELECT triggered_at FROM email_logs WHERE job_id=j.id ORDER BY triggered_at DESC LIMIT 1) AS last_triggered_at
     FROM email_jobs j
     ORDER BY j.id DESC`
  ).all();

  return c.json({ ok: true, data: rows.results ?? [] });
});

emailJobRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const v = validateEmailJobBody(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

  const chErr = await assertChannelsExist(c.env, v.data.notify_channel_ids);
  if (chErr) return c.json({ ok: false, error: chErr }, 400);

  const now = Date.now();
  const next_run_at = computeNextRun(v.schedule, now, Math.random, v.data.timezone ?? undefined);

  const r = await c.env.DB.prepare(
    `INSERT INTO email_jobs (
      name, task_type, to_emails, cc_emails, bcc_emails, subject, content, content_type,
      http_url, http_method, http_headers, http_body, http_expected_status,
      wxpusher_uids, tg_bot_token,
      schedule_json, notify, notify_channel_ids, timezone, tg_channels, tg_keywords, tg_state_json,
      enabled, next_run_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      v.data.name,
      v.data.task_type,
      v.data.to_emails,
      v.data.cc_emails,
      v.data.bcc_emails,
      v.data.subject,
      v.data.content,
      v.data.content_type,
      v.data.http_url,
      v.data.http_method,
      v.data.http_headers,
      v.data.http_body,
      v.data.http_expected_status,
      v.data.wxpusher_uids,
      v.data.tg_bot_token,
      JSON.stringify(v.schedule),
      v.data.notify,
      v.data.notify_channel_ids,
      v.data.timezone,
      v.data.tg_channels,
      v.data.tg_keywords,
      null,
      v.enabled,
      next_run_at,
      now,
      now
    )
    .run();

  const job = await c.env.DB.prepare("SELECT * FROM email_jobs WHERE id=?")
    .bind(r.meta.last_row_id)
    .first<EmailJobRow>();

  return c.json({ ok: true, data: job }, 201);
});

emailJobRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const job = await c.env.DB.prepare("SELECT * FROM email_jobs WHERE id=?").bind(id).first<EmailJobRow>();
  if (!job) return c.json({ ok: false, error: "任务不存在" }, 404);

  const logs = await c.env.DB.prepare(
    "SELECT * FROM email_logs WHERE job_id=? ORDER BY triggered_at DESC LIMIT 20"
  )
    .bind(id)
    .all();

  return c.json({ ok: true, data: { job, logs: logs.results ?? [] } });
});

emailJobRoutes.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT * FROM email_jobs WHERE id=?").bind(id).first<EmailJobRow>();
  if (!existing) return c.json({ ok: false, error: "任务不存在" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const v = validateEmailJobBody(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

  const chErr = await assertChannelsExist(c.env, v.data.notify_channel_ids);
  if (chErr) return c.json({ ok: false, error: chErr }, 400);

  const now = Date.now();
  const next_run_at = computeNextRun(v.schedule, now, Math.random, v.data.timezone ?? undefined);

  await c.env.DB.prepare(
    `UPDATE email_jobs SET
      name=?, task_type=?, to_emails=?, cc_emails=?, bcc_emails=?, subject=?, content=?, content_type=?,
      http_url=?, http_method=?, http_headers=?, http_body=?, http_expected_status=?,
      wxpusher_uids=?, tg_bot_token=?,
      schedule_json=?, notify=?, notify_channel_ids=?, timezone=?, tg_channels=?, tg_keywords=?,
      enabled=?, next_run_at=?, updated_at=?
    WHERE id=?`
  )
    .bind(
      v.data.name,
      v.data.task_type,
      v.data.to_emails,
      v.data.cc_emails,
      v.data.bcc_emails,
      v.data.subject,
      v.data.content,
      v.data.content_type,
      v.data.http_url,
      v.data.http_method,
      v.data.http_headers,
      v.data.http_body,
      v.data.http_expected_status,
      v.data.wxpusher_uids,
      v.data.tg_bot_token,
      JSON.stringify(v.schedule),
      v.data.notify,
      v.data.notify_channel_ids,
      v.data.timezone,
      v.data.tg_channels,
      v.data.tg_keywords,
      v.enabled,
      next_run_at,
      now,
      id
    )
    .run();

  const updated = await c.env.DB.prepare("SELECT * FROM email_jobs WHERE id=?").bind(id).first<EmailJobRow>();
  return c.json({ ok: true, data: updated });
});

emailJobRoutes.post("/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const job = await c.env.DB.prepare("SELECT * FROM email_jobs WHERE id=?").bind(id).first<EmailJobRow>();
  if (!job) return c.json({ ok: false, error: "任务不存在" }, 404);

  const newEnabled = job.enabled === 1 ? 0 : 1;
  let nextRun = job.next_run_at;
  if (newEnabled === 1) {
    try {
      const sv = validateSchedule(JSON.parse(job.schedule_json));
      if (sv.ok) nextRun = computeNextRun(sv.rule, Date.now(), Math.random, job.timezone ?? undefined);
    } catch {
      /* 保持原值 */
    }
  }

  await c.env.DB.prepare("UPDATE email_jobs SET enabled=?, next_run_at=?, updated_at=?, fail_streak=0 WHERE id=?")
    .bind(newEnabled, nextRun, Date.now(), id)
    .run();

  return c.json({ ok: true, data: { enabled: newEnabled, next_run_at: nextRun } });
});

emailJobRoutes.post("/:id/trigger", async (c) => {
  const id = Number(c.req.param("id"));
  const outcome = await triggerEmailJobOnce(c.env, id, "manual");
  if ("notFound" in outcome) return c.json({ ok: false, error: "任务不存在" }, 404);
  if (!outcome.ok) return c.json({ ok: false, error: outcome.error ?? "执行失败" }, 502);
  return c.json({ ok: true, data: outcome });
});

emailJobRoutes.get("/:id/logs", async (c) => {
  const id = Number(c.req.param("id"));
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("page_size")) || 20));
  const offset = (page - 1) * pageSize;

  const [totalRow, listRow] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM email_logs WHERE job_id=?").bind(id).first<{ total: number }>(),
    c.env.DB.prepare(
      "SELECT * FROM email_logs WHERE job_id=? ORDER BY triggered_at DESC LIMIT ? OFFSET ?"
    )
      .bind(id, pageSize, offset)
      .all(),
  ]);

  return c.json({
    ok: true,
    data: {
      rows: listRow.results ?? [],
      total: totalRow?.total ?? 0,
      page,
      pageSize,
    },
  });
});

emailJobRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM email_logs WHERE job_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM email_jobs WHERE id=?").bind(id),
  ]);
  return c.json({ ok: true, data: null });
});

export default emailJobRoutes;
