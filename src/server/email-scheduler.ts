import { computeNextRun, validateSchedule } from "./schedule";
import { getResendConfig, interpolateTemplate, parseEmailList, sendResendEmail } from "./email";
import { checkTgChannelsForJob, formatTgEmail, parseTgChannels } from "./tg-monitor";
import { getChannels, notifyEmailJobAutoPaused, notifyEmailJobFailed, sendNotify, type ChannelRow, type NotifyPayload } from "./notify";
import { DEFAULT_RUN_RETENTION_DAYS, KEY_RUNS_RETENTION, getAutoPauseThreshold, getSetting, setSetting } from "./settings";
import type { EmailJobRow, Env } from "./types";

export type TriggerSource = "schedule" | "manual";
export type WaitUntilHost = { waitUntil(promise: Promise<unknown>): void };

export type EmailDispatchOutcome = {
  ok: boolean;
  httpStatus: number;
  resendId?: string;
  error?: string;
  latencyMs?: number;
  skipped?: boolean;
  skipReason?: string;
  postCount?: number;
};

async function recordEmailLog(
  env: Env,
  jobId: number,
  source: TriggerSource,
  status: "success" | "failed",
  resendId: string | null,
  toEmails: string,
  subject: string,
  errorMessage: string | null,
  latencyMs: number | null
) {
  await env.DB.prepare(
    "INSERT INTO email_logs (job_id, triggered_at, source, status, resend_id, to_emails, subject, error_message, latency_ms) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(jobId, Date.now(), source, status, resendId, toEmails, subject, errorMessage, latencyMs)
    .run();
}

/** 任务级渠道选择：notify=0 关闭；channel_ids 为 JSON 数组多选；NULL/空/损坏 = 全部渠道 */
function emailJobNotifyTargets(job: EmailJobRow, channels: ChannelRow[]): ChannelRow[] {
  if (job.notify !== 1) return [];
  if (!job.notify_channel_ids) return channels;
  try {
    const ids = JSON.parse(job.notify_channel_ids) as unknown;
    if (!Array.isArray(ids) || ids.length === 0) return channels;
    const set = new Set(ids.filter((x): x is number => typeof x === "number"));
    return channels.filter((ch) => set.has(ch.id));
  } catch {
    return channels;
  }
}

export async function dispatchEmailJob(
  env: Env,
  job: EmailJobRow,
  source: TriggerSource,
  cachedConfig?: { apiKey: string; apiKeys?: string[]; from: string; replyTo?: string }
): Promise<EmailDispatchOutcome> {
  const config = cachedConfig ?? (await getResendConfig(env));
  if (!config.apiKey && (!config.apiKeys || config.apiKeys.length === 0)) {
    const msg = "未配置 Resend API Key，请在「邮件设置」中配置";
    await recordEmailLog(env, job.id, source, "failed", null, job.to_emails, job.subject, msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  const toList = parseEmailList(job.to_emails);
  if (toList.length === 0) {
    const msg = "收件人列表无效或为空";
    await recordEmailLog(env, job.id, source, "failed", null, job.to_emails, job.subject, msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  const now = Date.now();
  let finalSubject = interpolateTemplate(job.subject, now, job.timezone);
  let finalContent = interpolateTemplate(job.content, now, job.timezone);

  // 可选 Telegram 频道监控
  const tgChannels = parseTgChannels(job.tg_channels);
  let tgCheckResult: Awaited<ReturnType<typeof checkTgChannelsForJob>> | null = null;

  if (tgChannels.length > 0) {
    tgCheckResult = await checkTgChannelsForJob(job);

    // 若全部频道均抓取失败
    if (
      !tgCheckResult.hasNew &&
      Object.keys(tgCheckResult.channelErrors).length > 0 &&
      Object.keys(tgCheckResult.channelErrors).length >= tgChannels.length
    ) {
      const errMsg = Object.entries(tgCheckResult.channelErrors)
        .map(([ch, err]) => `TG 频道 @${ch} 抓取失败: ${err}`)
        .join("; ");
      await recordEmailLog(env, job.id, source, "failed", null, job.to_emails, finalSubject, errMsg, 0);
      return { ok: false, httpStatus: 502, error: errMsg, latencyMs: 0 };
    }

    // 满足条件才发邮件：若无新消息，跳过本次发信
    if (!tgCheckResult.hasNew) {
      return {
        ok: true,
        httpStatus: 200,
        skipped: true,
        skipReason: "Telegram 频道近 1 小时暂无新消息（未达到发信条件）",
        latencyMs: 0,
      };
    }

    // 格式化带有 Telegram 新消息的标题与正文
    const tgFormatted = formatTgEmail(
      tgCheckResult.posts,
      tgChannels,
      job.subject,
      job.content,
      job.content_type
    );
    finalSubject = interpolateTemplate(tgFormatted.subject, now, job.timezone);
    finalContent = interpolateTemplate(tgFormatted.content, now, job.timezone);
  }

  const ccList = parseEmailList(job.cc_emails);
  const bccList = parseEmailList(job.bcc_emails);

  const result = await sendResendEmail({
    apiKeys: config.apiKeys,
    apiKey: config.apiKey,
    from: config.from,
    to: toList,
    subject: finalSubject,
    content: finalContent,
    contentType: job.content_type,
    cc: ccList.length > 0 ? ccList : undefined,
    bcc: bccList.length > 0 ? bccList : undefined,
    replyTo: config.replyTo,
  });

  if (result.ok && tgCheckResult && tgCheckResult.hasNew) {
    // 邮件发送成功后，记录审计信息
    await env.DB.prepare("UPDATE email_jobs SET tg_state_json=? WHERE id=?")
      .bind(JSON.stringify({ lastSentAt: now, postCount: tgCheckResult.posts.length }), job.id)
      .run();
  }

  await recordEmailLog(
    env,
    job.id,
    source,
    result.ok ? "success" : "failed",
    result.id ?? null,
    toList.join(", "),
    finalSubject,
    result.ok ? null : result.error ?? "发送失败",
    result.latencyMs
  );

  return {
    ok: result.ok,
    httpStatus: result.httpStatus,
    resendId: result.id,
    error: result.error,
    latencyMs: result.latencyMs,
    postCount: tgCheckResult?.posts?.length,
  };
}

export async function triggerEmailJobOnce(
  env: Env,
  jobId: number,
  source: TriggerSource
): Promise<EmailDispatchOutcome | { notFound: true }> {
  const job = await env.DB.prepare("SELECT * FROM email_jobs WHERE id=?").bind(jobId).first<EmailJobRow>();
  if (!job) return { notFound: true };
  return dispatchEmailJob(env, job, source);
}

// 免费层控制单轮并发度与批次，与 GitHub 触发(15)、轮询(15)及探测(10)共同确保单次唤醒 subrequest ≤ 50
const EMAIL_SCHEDULE_CONCURRENCY = 4;
const EMAIL_SCHEDULE_BATCH_LIMIT = 8;

export async function runDueEmailJobs(
  env: Env,
  now: number = Date.now(),
  ctx?: WaitUntilHost
): Promise<{ triggered: number; failed: number }> {
  // 免费层优化：先查是否有到期任务。若无到期任务，直接跳过渠道查询与阈值查询，省下高频 D1 读调用
  const due = await env.DB.prepare(
    `SELECT * FROM email_jobs WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at ASC LIMIT ${EMAIL_SCHEDULE_BATCH_LIMIT}`
  )
    .bind(now)
    .all<EmailJobRow>();
  const rows = due.results ?? [];

  // 每日日志清理：降频为整点检查（每 60 分钟一次），避免每分钟频繁执行设置读取
  if (Math.floor(now / 60_000) % 60 === 0) {
    const lastCleanupStr = await getSetting(env, "last_email_logs_cleanup_at").catch(() => null);
    const lastCleanup = Number(lastCleanupStr) || 0;
    const isDailyCleanup =
      now - lastCleanup >= 24 * 3600 * 1000 &&
      (new Date(now).getUTCHours() >= 3 || now - lastCleanup >= 28 * 3600 * 1000);
    if (isDailyCleanup) {
      try {
        const configured = Number(await getSetting(env, KEY_RUNS_RETENTION));
        const retentionDays = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RUN_RETENTION_DAYS;
        await env.DB.prepare("DELETE FROM email_logs WHERE triggered_at < ?")
          .bind(now - retentionDays * 24 * 3600 * 1000)
          .run();
        await setSetting(env, "last_email_logs_cleanup_at", String(now));
      } catch {
        /* 忽略 */
      }
    }
  }

  if (rows.length === 0) {
    return { triggered: 0, failed: 0 };
  }

  // 仅在确有任务到期时才拉取告警渠道、停用阈值与 Resend 配置，整批复用
  let channels: ChannelRow[] = [];
  try {
    channels = await getChannels(env);
  } catch {
    /* 视同无渠道 */
  }

  const threshold = await getAutoPauseThreshold(env);
  const resendConfig = await getResendConfig(env);
  const notifications: Array<{ channels: ChannelRow[]; payload: NotifyPayload }> = [];

  let triggered = 0;
  let failed = 0;

  async function processJob(job: EmailJobRow): Promise<void> {
    try {
      const v = validateSchedule(JSON.parse(job.schedule_json));
      if (!v.ok) return;

      let newNext = computeNextRun(v.rule, job.next_run_at, Math.random, job.timezone ?? undefined);
      if (newNext <= now) newNext = computeNextRun(v.rule, now, Math.random, job.timezone ?? undefined);

      const claim = await env.DB.prepare(
        "UPDATE email_jobs SET next_run_at=?, updated_at=? WHERE id=? AND next_run_at=? AND enabled=1"
      )
        .bind(newNext, now, job.id, job.next_run_at)
        .run();
      if ((claim.meta.changes ?? 0) !== 1) return;

      const result = await dispatchEmailJob(env, job, "schedule", resendConfig);

      if (result.ok) {
        triggered++;
        await env.DB.prepare("UPDATE email_jobs SET fail_streak=0, last_run_at=? WHERE id=?")
          .bind(now, job.id)
          .run();
      } else {
        failed++;
        const streak = (job.fail_streak ?? 0) + 1;
        let paused = false;
        if (threshold > 0 && streak >= threshold) {
          const pause = await env.DB.prepare(
            "UPDATE email_jobs SET enabled=0, fail_streak=?, last_run_at=?, updated_at=? WHERE id=? AND enabled=1"
          )
            .bind(streak, now, now, job.id)
            .run();
          paused = (pause.meta.changes ?? 0) === 1;
        } else {
          await env.DB.prepare("UPDATE email_jobs SET fail_streak=?, last_run_at=? WHERE id=?")
            .bind(streak, now, job.id)
            .run();
        }

        const jobChannels = emailJobNotifyTargets(job, channels);
        if (jobChannels.length > 0) {
          notifications.push({
            channels: jobChannels,
            payload: paused
              ? notifyEmailJobAutoPaused({ name: job.name, error: result.error })
              : notifyEmailJobFailed({ name: job.name, error: result.error }),
          });
        }
      }
    } catch (e) {
      failed++;
      const msg = `邮件调度器内部错误: ${(e as Error).message}`.slice(0, 500);
      try {
        await recordEmailLog(env, job.id, "schedule", "failed", null, job.to_emails, job.subject, msg, 0);
      } catch {
        /* 记录失败时忽略 */
      }
      try {
        await env.DB.prepare(
          "UPDATE email_jobs SET next_run_at=?, updated_at=? WHERE id=? AND next_run_at=? AND enabled=1"
        )
          .bind(now + 30 * 60_000, now, job.id, job.next_run_at)
          .run();
      } catch {
        /* 兜底推进失败忽略 */
      }
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < rows.length) {
      const job = rows[next++];
      await processJob(job);
    }
  }

  await Promise.all(Array.from({ length: Math.min(EMAIL_SCHEDULE_CONCURRENCY, rows.length) }, () => worker()));

  const tail = (async () => {
    if (notifications.length > 0 && channels.length > 0) {
      const sends: Promise<boolean>[] = [];
      for (const n of notifications) {
        for (const ch of n.channels) sends.push(sendNotify(ch, n.payload));
      }
      await Promise.allSettled(sends);
    }
  })();

  if (ctx) ctx.waitUntil(tail);
  else await tail;

  return { triggered, failed };
}

