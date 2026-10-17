import { Hono } from "hono";
import { computeNextRun, isValidTimezone, validateSchedule, type ScheduleRule } from "../schedule";
import { getResendConfig, maskApiKey, parseApiKeys, parseEmailList, saveResendConfig, sendResendEmail } from "../email";
import { fetchChannelPosts, parseTgChannels, parseTgKeywords, type TgPost } from "../tg-monitor";
import { triggerEmailJobOnce } from "../email-scheduler";
import { assertChannelsExist } from "./jobs";
import type { EmailJobRow, Env } from "../types";

const emailJobRoutes = new Hono<{ Bindings: Env }>();

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
  to_emails: string;
  cc_emails: string | null;
  bcc_emails: string | null;
  subject: string;
  content: string;
  content_type: "text" | "html" | "markdown";
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

  const to_emails = typeof body.to_emails === "string" ? body.to_emails.trim() : "";
  const parsedTo = parseEmailList(to_emails);
  if (parsedTo.length === 0) return { ok: false, error: "请填写至少一个有效的收件人邮箱" };

  const cc_emails = typeof body.cc_emails === "string" && body.cc_emails.trim() ? body.cc_emails.trim() : null;
  const bcc_emails = typeof body.bcc_emails === "string" && body.bcc_emails.trim() ? body.bcc_emails.trim() : null;

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject || subject.length > 300) return { ok: false, error: "邮件标题必填（≤300 字）" };

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return { ok: false, error: "邮件内容不能为空" };

  let content_type: "text" | "html" | "markdown" = "html";
  if (body.content_type === "text" || body.content_type === "markdown" || body.content_type === "html") {
    content_type = body.content_type;
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

  let tg_channels: string | null = null;
  if (typeof body.tg_channels === "string" && body.tg_channels.trim()) {
    const chs = parseTgChannels(body.tg_channels);
    tg_channels = chs.length > 0 ? chs.join(", ") : null;
  }

  let tg_keywords: string | null = null;
  if (typeof body.tg_keywords === "string" && body.tg_keywords.trim()) {
    const kws = parseTgKeywords(body.tg_keywords);
    tg_keywords = kws.length > 0 ? kws.join(", ") : null;
  }

  return {
    ok: true,
    data: {
      name,
      to_emails: parsedTo.join(", "),
      cc_emails,
      bcc_emails,
      subject,
      content,
      content_type,
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
      name, to_emails, cc_emails, bcc_emails, subject, content, content_type,
      schedule_json, notify, notify_channel_ids, timezone, tg_channels, tg_keywords, tg_state_json,
      enabled, next_run_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      v.data.name,
      v.data.to_emails,
      v.data.cc_emails,
      v.data.bcc_emails,
      v.data.subject,
      v.data.content,
      v.data.content_type,
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
  if (!job) return c.json({ ok: false, error: "邮件任务不存在" }, 404);

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
  if (!existing) return c.json({ ok: false, error: "邮件任务不存在" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as never);
  const v = validateEmailJobBody(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

  const chErr = await assertChannelsExist(c.env, v.data.notify_channel_ids);
  if (chErr) return c.json({ ok: false, error: chErr }, 400);

  const now = Date.now();
  const next_run_at = computeNextRun(v.schedule, now, Math.random, v.data.timezone ?? undefined);

  await c.env.DB.prepare(
    `UPDATE email_jobs SET
      name=?, to_emails=?, cc_emails=?, bcc_emails=?, subject=?, content=?, content_type=?,
      schedule_json=?, notify=?, notify_channel_ids=?, timezone=?, tg_channels=?, tg_keywords=?,
      enabled=?, next_run_at=?, updated_at=?
    WHERE id=?`
  )
    .bind(
      v.data.name,
      v.data.to_emails,
      v.data.cc_emails,
      v.data.bcc_emails,
      v.data.subject,
      v.data.content,
      v.data.content_type,
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
  if (!job) return c.json({ ok: false, error: "邮件任务不存在" }, 404);

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
  if ("notFound" in outcome) return c.json({ ok: false, error: "邮件任务不存在" }, 404);
  if (!outcome.ok) return c.json({ ok: false, error: outcome.error ?? "发送失败" }, 502);
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
