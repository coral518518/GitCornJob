import { computeNextRun, validateSchedule } from "./schedule";
import { getResendConfig, interpolateTemplate, parseEmailList, sendResendEmail } from "./email";
import { checkTgChannelsForJob, formatTgEmail, parseTgChannels } from "./tg-monitor";
import { getChannel, getChannels, notifyEmailJobAutoPaused, notifyEmailJobFailed, sendNotify, type ChannelRow, type NotifyPayload } from "./notify";
import { DEFAULT_RUN_RETENTION_DAYS, KEY_RUNS_RETENTION, getAutoPauseThreshold, getSetting, setSetting } from "./settings";
import {
  extractTgBotToken,
  fetchTgBotUpdates,
  formatTgUpdatesToMarkdown,
  getWxPusherConfig,
  parseWxPusherUids,
  resolveTgBotToken,
  sendWxPusherMessage,
} from "./wxpusher";
import { parseExpectedCodes } from "./monitor";
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

export function parseHttpHeaders(headersStr?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headersStr || !headersStr.trim()) return result;
  const trimmed = headersStr.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          result[k.trim()] = String(v);
        }
      }
      return result;
    } catch {
      /* fallback to line parsing */
    }
  }
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#") || l.startsWith("//")) continue;
    const colonIdx = l.indexOf(":");
    if (colonIdx > 0) {
      const key = l.slice(0, colonIdx).trim();
      const val = l.slice(colonIdx + 1).trim();
      if (key) result[key] = val;
    }
  }
  return result;
}

/**
 * 校验 HTTP 响应是否满足配置的成功判定规则。
 * 规则语法：[状态码规则];[响应结构/内容规则] 或 仅 [状态码规则]
 * 例如：
 * - "200"：仅当状态码为 200 算成功
 * - "200,400"：状态码为 200 或 400 算成功
 * - "200,400;data:ok=true"：状态码为 200 或 400，且响应 JSON 的 data.ok 属性值为 true
 * - "200;code=0"：状态码为 200，且 code 为 0
 * - "200;data.status=success"：支持 . 或 : 作为层级路径
 */
export function checkHttpAssertion(
  status: number,
  bodyText: string,
  ruleStr: string | null | undefined
): { ok: boolean; error?: string } {
  const trimmed = (ruleStr ?? "").trim();
  if (!trimmed) {
    const is2xx = status >= 200 && status <= 299;
    return {
      ok: is2xx,
      error: is2xx ? undefined : `HTTP ${status}: 响应状态码不在 2xx 成功范围内`,
    };
  }

  const parts = trimmed.split(";");
  const statusPart = parts[0]?.trim() || "";
  const bodyPart = parts.slice(1).join(";").trim();

  // 1. 状态码校验
  if (statusPart) {
    const ranges = parseExpectedCodes(statusPart);
    const matched = ranges.some(([lo, hi]) => status >= lo && status <= hi);
    if (!matched) {
      const allowedStr = ranges.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}-${hi}`)).join(",");
      return {
        ok: false,
        error: `HTTP ${status}: 状态码不符合期望（期望: ${allowedStr}）`,
      };
    }
  } else {
    if (status < 200 || status > 299) {
      return {
        ok: false,
        error: `HTTP ${status}: 状态码不在 2xx 范围内`,
      };
    }
  }

  // 2. 响应结构/内容校验
  if (!bodyPart) {
    return { ok: true };
  }

  const assertions = bodyPart.split(",").map((s) => s.trim()).filter(Boolean);
  if (assertions.length === 0) {
    return { ok: true };
  }

  let jsonBody: unknown;
  let isJson = false;
  try {
    jsonBody = JSON.parse(bodyText);
    isJson = true;
  } catch {
    isJson = false;
  }

  for (const assertion of assertions) {
    const eqIdx = assertion.indexOf("=");
    if (eqIdx > 0) {
      const pathStr = assertion.slice(0, eqIdx).trim();
      const rawExpectedVal = assertion.slice(eqIdx + 1).trim();

      if (!isJson || typeof jsonBody !== "object" || jsonBody === null) {
        return {
          ok: false,
          error: `HTTP ${status} 满足，但响应体不是有效 JSON，无法校验期望「${assertion}」`,
        };
      }

      const pathKeys = pathStr.split(/[:.]/).map((k) => k.trim()).filter(Boolean);
      let cur: any = jsonBody;
      let found = true;
      for (const k of pathKeys) {
        if (cur !== null && typeof cur === "object" && k in cur) {
          cur = cur[k];
        } else {
          found = false;
          break;
        }
      }

      if (!found) {
        return {
          ok: false,
          error: `HTTP ${status} 满足，但响应 JSON 缺少字段「${pathStr}」（期望值为 ${rawExpectedVal}）`,
        };
      }

      let expectedVal: unknown = rawExpectedVal;
      if (rawExpectedVal === "true") expectedVal = true;
      else if (rawExpectedVal === "false") expectedVal = false;
      else if (rawExpectedVal === "null") expectedVal = null;
      else if (/^-?\d+(\.\d+)?$/.test(rawExpectedVal)) expectedVal = Number(rawExpectedVal);
      else if (
        (rawExpectedVal.startsWith('"') && rawExpectedVal.endsWith('"')) ||
        (rawExpectedVal.startsWith("'") && rawExpectedVal.endsWith("'"))
      ) {
        expectedVal = rawExpectedVal.slice(1, -1);
      }

      if (cur !== expectedVal && String(cur) !== String(expectedVal)) {
        return {
          ok: false,
          error: `HTTP ${status} 满足，但字段「${pathStr}」不匹配: 期望 ${String(expectedVal)}，实际为 ${JSON.stringify(cur)}`,
        };
      }
    } else {
      if (!bodyText.includes(assertion)) {
        return {
          ok: false,
          error: `HTTP ${status} 满足，但响应体不包含期望内容「${assertion}」`,
        };
      }
    }
  }

  return { ok: true };
}

export async function executeHttpRequest(opts: {
  url: string;
  method?: string;
  headers?: string | Record<string, string> | null;
  body?: string | null;
  expectedStatus?: string | null;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  latencyMs: number;
  bodyPreview: string;
  error?: string;
}> {
  const method = (opts.method || "GET").toUpperCase();
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15000;

  let headerObj: Record<string, string> = {};
  if (typeof opts.headers === "object" && opts.headers !== null) {
    headerObj = opts.headers;
  } else if (typeof opts.headers === "string") {
    headerObj = parseHttpHeaders(opts.headers);
  }

  // 非 GET/HEAD 且有 body 时，若为 JSON 格式且未显式指定 Content-Type，默认补齐 application/json
  if (
    opts.body &&
    method !== "GET" &&
    method !== "HEAD" &&
    !Object.keys(headerObj).some((k) => k.toLowerCase() === "content-type")
  ) {
    const trimmedBody = opts.body.trim();
    if (
      (trimmedBody.startsWith("{") && trimmedBody.endsWith("}")) ||
      (trimmedBody.startsWith("[") && trimmedBody.endsWith("]"))
    ) {
      headerObj["Content-Type"] = "application/json";
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const reqInit: RequestInit = {
      method,
      headers: headerObj,
      signal: controller.signal,
      redirect: "follow",
    };
    if (method !== "GET" && method !== "HEAD" && opts.body !== undefined && opts.body !== null) {
      reqInit.body = opts.body;
    }

    const res = await fetch(opts.url, reqInit);
    clearTimeout(timer);
    const latencyMs = Date.now() - start;

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    let resBody = "";
    try {
      resBody = await res.text();
    } catch {
      resBody = "";
    }
    const bodyPreview = resBody.slice(0, 500);

    const check = checkHttpAssertion(res.status, resBody, opts.expectedStatus);
    const isSuccess = check.ok;
    let errorDetail = check.error;
    if (!isSuccess && errorDetail && bodyPreview && !errorDetail.includes(bodyPreview.slice(0, 30))) {
      errorDetail = `${errorDetail}: ${bodyPreview.slice(0, 150)}`.trim();
    }
    return {
      ok: isSuccess,
      status: res.status,
      statusText: res.statusText || (isSuccess ? "OK" : "Error"),
      headers: resHeaders,
      latencyMs,
      bodyPreview,
      error: isSuccess ? undefined : (errorDetail || `HTTP ${res.status}: ${bodyPreview.slice(0, 150)}`.trim()),
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = (err as Error)?.name === "AbortError"
      ? `请求超时（超过 ${timeoutMs}ms）`
      : ((err as Error)?.message || "网络请求异常");
    return {
      ok: false,
      status: 0,
      statusText: "FetchError",
      headers: {},
      latencyMs,
      bodyPreview: "",
      error: msg,
    };
  }
}

export async function dispatchHttpJob(
  env: Env,
  job: EmailJobRow,
  source: TriggerSource
): Promise<EmailDispatchOutcome> {
  const now = Date.now();
  if (!job.http_url || !job.http_url.trim()) {
    const msg = "未配置目标接口 URL";
    await recordEmailLog(env, job.id, source, "failed", null, "", "HTTP 请求失败", msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  const finalUrl = interpolateTemplate(job.http_url.trim(), now, job.timezone);
  const finalHeaders = job.http_headers ? interpolateTemplate(job.http_headers, now, job.timezone) : null;
  const finalBody = job.http_body ? interpolateTemplate(job.http_body, now, job.timezone) : null;
  const method = (job.http_method || "GET").toUpperCase();

  const res = await executeHttpRequest({
    url: finalUrl,
    method,
    headers: finalHeaders,
    body: finalBody,
    expectedStatus: job.http_expected_status,
    timeoutMs: 15000,
  });

  const subjectStr = `${method} ${finalUrl}`;
  await recordEmailLog(
    env,
    job.id,
    source,
    res.ok ? "success" : "failed",
    res.status > 0 ? `HTTP ${res.status}` : null,
    finalUrl,
    subjectStr,
    res.ok ? null : res.error ?? "请求接口失败",
    res.latencyMs
  );

  return {
    ok: res.ok,
    httpStatus: res.status || 502,
    resendId: res.status > 0 ? `HTTP ${res.status}` : undefined,
    error: res.error,
    latencyMs: res.latencyMs,
  };
}

export async function dispatchClawBotJob(
  env: Env,
  job: EmailJobRow,
  source: TriggerSource
): Promise<EmailDispatchOutcome> {
  const now = Date.now();

  // 1. 获取 Telegram Bot Token（支持直接填 Token 或引用已有通知渠道）
  let botToken = await resolveTgBotToken(job.tg_bot_token || "", env);

  // 兜底：如果任务本身未指定 botToken，尝试从现有的 Telegram 告警渠道中自动借用第一个
  if (!botToken) {
    try {
      const allChannels = await getChannels(env);
      const tgChannel = allChannels.find((c) => c.type === "telegram");
      if (tgChannel) {
        botToken = extractTgBotToken(tgChannel.url);
      }
    } catch {
      /* 忽略 */
    }
  }

  if (!botToken) {
    const msg = "未找到可用的 Telegram Bot Token，请在任务中选择或填写";
    await recordEmailLog(env, job.id, source, "failed", null, "", "微信ClawBot推送失败", msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  // 2. 获取 WxPusher 配置与接收 UID
  const wxConfig = await getWxPusherConfig(env);
  if (!wxConfig.appToken) {
    const msg = "未配置 WxPusher App Token，请点击「WxPusher 微信设置」进行配置";
    await recordEmailLog(env, job.id, source, "failed", null, "", "微信ClawBot推送失败", msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  let uids = parseWxPusherUids(job.wxpusher_uids);
  if (uids.length === 0) {
    uids = parseWxPusherUids(wxConfig.defaultUids);
  }
  if (uids.length === 0) {
    const msg = "未指定接收消息的 WxPusher UID（请在任务编辑中填写）";
    await recordEmailLog(env, job.id, source, "failed", null, "", "微信ClawBot推送失败", msg, 0);
    return { ok: false, httpStatus: 400, error: msg, latencyMs: 0 };
  }

  // 3. 读取已读游标防重复拉取
  let lastUpdateId: number | undefined = undefined;
  if (job.tg_state_json) {
    try {
      const st = JSON.parse(job.tg_state_json) as { lastUpdateId?: number };
      if (typeof st.lastUpdateId === "number") {
        lastUpdateId = st.lastUpdateId;
      }
    } catch {
      /* 忽略 */
    }
  }

  // 4. 调用 Telegram Bot API getUpdates 拉取未读更新
  const offset = typeof lastUpdateId === "number" ? lastUpdateId + 1 : undefined;
  const tgRes = await fetchTgBotUpdates(botToken, offset, 0);
  if (!tgRes.ok) {
    await recordEmailLog(
      env,
      job.id,
      source,
      "failed",
      null,
      uids.join(", "),
      "微信ClawBot推送失败",
      tgRes.error || "获取 Telegram 消息异常",
      tgRes.latencyMs
    );
    return {
      ok: false,
      httpStatus: 502,
      error: tgRes.error || "获取 Telegram 更新失败",
      latencyMs: tgRes.latencyMs,
    };
  }

  // 5. 无新消息则安全跳过本次推送
  if (tgRes.updates.length === 0) {
    // 免费层优化：仅在用户前端手动点击试跑时记录一条跳过日志，定时轮询不写 D1 避免日志膨胀
    if (source === "manual") {
      await recordEmailLog(
        env,
        job.id,
        source,
        "success",
        "已跳过",
        uids.join(", "),
        "微信ClawBot推送（无新消息）",
        "Telegram 机器人暂无新未读消息，安全跳过本次微信推送",
        tgRes.latencyMs
      );
    }
    return {
      ok: true,
      httpStatus: 200,
      skipped: true,
      skipReason: "Telegram 机器人暂无新未读消息（未触发推送）",
      latencyMs: tgRes.latencyMs,
    };
  }

  // 6. 有新消息：计算最大 update_id，排版为 Markdown 消息并推送到微信 WxPusher
  const maxUpdateId = tgRes.updates.reduce((max, u) => Math.max(max, u.update_id), 0);
  const formatted = formatTgUpdatesToMarkdown(tgRes.updates, job.timezone ?? undefined);

  const pushRes = await sendWxPusherMessage({
    appToken: wxConfig.appToken,
    content: formatted.content,
    summary: formatted.summary,
    uids,
  });

  const totalLatency = tgRes.latencyMs + pushRes.latencyMs;

  if (!pushRes.ok) {
    const errMsg = `WxPusher 推送失败: ${pushRes.msg || "未知原因"}`;
    await recordEmailLog(
      env,
      job.id,
      source,
      "failed",
      pushRes.code ? `CODE ${pushRes.code}` : null,
      uids.join(", "),
      `推送 ${tgRes.updates.length} 条未读消息失败`,
      errMsg,
      totalLatency
    );
    // 关键防丢机制：推送失败时绝不更新游标，确保下一次轮询仍能重新拉取未读消息进行重推
    return {
      ok: false,
      httpStatus: 502,
      error: errMsg,
      latencyMs: totalLatency,
    };
  }

  // 7. 推送成功：更新数据库已读游标与执行状态
  await env.DB.prepare("UPDATE email_jobs SET tg_state_json=? WHERE id=?")
    .bind(
      JSON.stringify({
        lastUpdateId: maxUpdateId,
        lastPushedAt: now,
        lastCount: tgRes.updates.length,
      }),
      job.id
    )
    .run();

  await recordEmailLog(
    env,
    job.id,
    source,
    "success",
    "WxPusher 成功",
    uids.join(", "),
    `推送 ${tgRes.updates.length} 条 Telegram 消息至微信`,
    null,
    totalLatency
  );

  return {
    ok: true,
    httpStatus: 200,
    resendId: "WxPusher 成功",
    latencyMs: totalLatency,
    postCount: tgRes.updates.length,
  };
}

export async function dispatchEmailJob(
  env: Env,
  job: EmailJobRow,
  source: TriggerSource,
  cachedConfig?: { apiKey: string; apiKeys?: string[]; from: string; replyTo?: string }
): Promise<EmailDispatchOutcome> {
  // 如果任务类型为微信 ClawBot 推送，分发至 ClawBot 执行器
  if (job.task_type === "clawbot") {
    return dispatchClawBotJob(env, job, source);
  }

  // 如果任务类型为 HTTP 定时接口请求，分发至 HTTP 执行器
  if (job.task_type === "http") {
    return dispatchHttpJob(env, job, source);
  }

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

// 免费层控制单轮并发度与批次，严格限制在 subrequest 阈值内（单轮至多 4 个任务）
const EMAIL_SCHEDULE_CONCURRENCY = 2;
const EMAIL_SCHEDULE_BATCH_LIMIT = 4;

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
              ? notifyEmailJobAutoPaused({ name: job.name, error: result.error, taskType: job.task_type })
              : notifyEmailJobFailed({ name: job.name, error: result.error, taskType: job.task_type }),
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

