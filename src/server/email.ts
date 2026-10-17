import { getSetting, setSetting } from "./settings";
import type { Env } from "./types";

export const KEY_RESEND_API_KEY = "resend_api_key";
export const KEY_RESEND_FROM = "resend_from";
export const KEY_RESEND_REPLY_TO = "resend_reply_to";

export type ResendConfig = {
  apiKey: string;
  apiKeys: string[];
  from: string;
  replyTo?: string;
  source: "db" | "env" | "none";
};

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

/** 解析单行、多行或 JSON 格式的多个 API Key */
export function parseApiKeys(input: string | null | undefined): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
      }
    } catch {
      /* 回退到按行分割 */
    }
  }
  return [...new Set(trimmed.split(/[\r\n,;，；]+/).map((s) => s.trim()).filter(Boolean))];
}

/** 从密钥列表中随机选取一个 */
export function pickRandomApiKey(keys: string[]): string {
  if (!keys || keys.length === 0) return "";
  return keys[Math.floor(Math.random() * keys.length)];
}

export async function getResendConfig(env: Env): Promise<ResendConfig> {
  const [dbKey, dbFrom, dbReplyTo] = await Promise.all([
    getSetting(env, KEY_RESEND_API_KEY).catch(() => null),
    getSetting(env, KEY_RESEND_FROM).catch(() => null),
    getSetting(env, KEY_RESEND_REPLY_TO).catch(() => null),
  ]);

  let apiKeys: string[] = [];
  let source: ResendConfig["source"] = "none";

  if (dbKey && dbKey.trim()) {
    apiKeys = parseApiKeys(dbKey);
    if (apiKeys.length > 0) source = "db";
  }

  if (apiKeys.length === 0 && env.RESEND_API_KEY && env.RESEND_API_KEY.trim()) {
    apiKeys = parseApiKeys(env.RESEND_API_KEY);
    if (apiKeys.length > 0) source = "env";
  }

  const apiKey = pickRandomApiKey(apiKeys);
  const from = (dbFrom && dbFrom.trim()) || (env.RESEND_FROM && env.RESEND_FROM.trim()) || "onboarding@resend.dev";
  const replyTo = (dbReplyTo && dbReplyTo.trim()) || undefined;

  return { apiKey, apiKeys, from, replyTo, source };
}

export async function saveResendConfig(
  env: Env,
  config: { apiKey?: string; apiKeys?: string[]; from?: string; replyTo?: string }
): Promise<void> {
  if (config.apiKeys !== undefined) {
    await setSetting(env, KEY_RESEND_API_KEY, JSON.stringify(config.apiKeys));
  } else if (config.apiKey !== undefined) {
    const keys = parseApiKeys(config.apiKey);
    await setSetting(env, KEY_RESEND_API_KEY, JSON.stringify(keys));
  }
  if (config.from !== undefined) {
    await setSetting(env, KEY_RESEND_FROM, config.from.trim());
  }
  if (config.replyTo !== undefined) {
    await setSetting(env, KEY_RESEND_REPLY_TO, config.replyTo.trim());
  }
}

/** 邮箱简易正则：含 @ 且两侧非空，域名含点 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 解析并清洗多收件人输入（支持英文/中文逗号、分号、换行分隔） */
export function parseEmailList(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(/[\r\n,;，；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && EMAIL_RE.test(s));
}

/**
 * 模板变量插值：替换常见的日期时间占位符
 * 支持占位符：
 * - {{date}}: 2026-10-17
 * - {{time}}: 12:45:00
 * - {{datetime}}: 2026-10-17 12:45:00
 * - {{year}}: 2026
 * - {{month}}: 10
 * - {{day}}: 17
 * - {{weekday}}: 星期六
 * - {{timestamp}}: 1729140000000
 */
export function interpolateTemplate(template: string, now: number = Date.now(), tz?: string | null): string {
  if (!template || !template.includes("{{")) return template;

  const dateObj = new Date(now);
  const timeZone = tz && tz.trim() ? tz.trim() : "Asia/Shanghai";

  let parts: Record<string, string> = {};
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
      hour12: false,
    });

    const formattedParts = formatter.formatToParts(dateObj);
    for (const part of formattedParts) {
      parts[part.type] = part.value;
    }
  } catch {
    // 时区异常时 fallback 到 UTC
    const utcStr = dateObj.toISOString();
    return template
      .replace(/\{\{date\}\}/g, utcStr.slice(0, 10))
      .replace(/\{\{time\}\}/g, utcStr.slice(11, 19))
      .replace(/\{\{datetime\}\}/g, utcStr.slice(0, 19).replace("T", " "))
      .replace(/\{\{timestamp\}\}/g, String(now));
  }

  const year = parts.year || String(dateObj.getFullYear());
  const month = parts.month || String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = parts.day || String(dateObj.getDate()).padStart(2, "0");
  const hour = parts.hour || "00";
  const minute = parts.minute || "00";
  const second = parts.second || "00";
  const weekday = parts.weekday || "";

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hour}:${minute}:${second}`;
  const dateTimeStr = `${dateStr} ${timeStr}`;

  return template
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{datetime\}\}/g, dateTimeStr)
    .replace(/\{\{year\}\}/g, year)
    .replace(/\{\{month\}\}/g, month)
    .replace(/\{\{day\}\}/g, day)
    .replace(/\{\{weekday\}\}/g, weekday)
    .replace(/\{\{timestamp\}\}/g, String(now));
}

/** 转义 HTML 特殊字符 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 专为邮件设计的轻量 Markdown 到 HTML 渲染器
 * 生成自包含内联样式的邮件兼容 HTML
 */
export function markdownToHtml(md: string): string {
  if (!md) return "";

  const lines = md.split(/\r?\n/);
  const htmlParts: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // 代码块处理
    if (rawLine.trim().startsWith("```")) {
      if (inCodeBlock) {
        htmlParts.push(
          `<pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:6px;padding:12px;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.45;"><code>${escapeHtml(
            codeBlockContent.join("\n")
          )}</code></pre>`
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        if (inList) {
          htmlParts.push("</ul>");
          inList = false;
        }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (inList) {
        htmlParts.push("</ul>");
        inList = false;
      }
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        htmlParts.push('<ul style="margin:8px 0;padding-left:24px;">');
        inList = true;
      }
      const itemText = formatInline(trimmed.replace(/^[-*]\s+/, ""));
      htmlParts.push(`<li style="margin:4px 0;line-height:1.6;">${itemText}</li>`);
      continue;
    } else if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }

    // 标题
    if (/^###\s+/.test(trimmed)) {
      htmlParts.push(`<h3 style="font-size:16px;font-weight:600;margin:16px 0 8px 0;color:#18181b;">${formatInline(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      htmlParts.push(`<h2 style="font-size:18px;font-weight:600;margin:20px 0 8px 0;color:#18181b;">${formatInline(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      htmlParts.push(`<h1 style="font-size:22px;font-weight:700;margin:24px 0 12px 0;color:#09090b;">${formatInline(trimmed.slice(2))}</h1>`);
      continue;
    }

    // 引用块
    if (/^>\s+/.test(trimmed)) {
      htmlParts.push(
        `<blockquote style="border-left:4px solid #d4d4d8;margin:12px 0;padding:6px 12px;color:#52525b;background:#fafafa;border-radius:0 4px 4px 0;">${formatInline(
          trimmed.slice(2)
        )}</blockquote>`
      );
      continue;
    }

    // 普通段落
    htmlParts.push(`<p style="margin:8px 0;line-height:1.6;color:#27272a;">${formatInline(trimmed)}</p>`);
  }

  if (inCodeBlock && codeBlockContent.length > 0) {
    htmlParts.push(
      `<pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:6px;padding:12px;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.45;"><code>${escapeHtml(
        codeBlockContent.join("\n")
      )}</code></pre>`
    );
  }
  if (inList) {
    htmlParts.push("</ul>");
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#27272a;background:#ffffff;"><div style="max-width:600px;margin:0 auto;">${htmlParts.join("\n")}</div></body></html>`;
}

/** 行内格式处理（加粗、斜体、行内代码、链接） */
function formatInline(text: string): string {
  let s = escapeHtml(text);
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, '<code style="background:#f4f4f5;padding:2px 5px;border-radius:4px;font-size:12px;font-family:monospace;color:#09090b;">$1</code>');
  // 加粗 **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 斜体 *italic*
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">$1</a>');
  return s;
}

export type SendEmailOptions = {
  apiKey?: string;
  apiKeys?: string[];
  from: string;
  to: string[];
  subject: string;
  content: string;
  contentType: "text" | "html" | "markdown";
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type SendEmailResult = {
  ok: boolean;
  id?: string;
  httpStatus: number;
  error?: string;
  latencyMs: number;
  usedKeyMasked?: string;
};

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 通过 Resend 发送单次邮件，多密钥时随机选用一个，遭遇额度超限/429 时自动回退至其他可用密钥 */
export async function sendResendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const start = Date.now();

  const candidateKeys = (
    opts.apiKeys && opts.apiKeys.length > 0
      ? opts.apiKeys
      : opts.apiKey ? [opts.apiKey] : []
  ).filter(k => k && k.trim());

  if (candidateKeys.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      error: "未配置 Resend API Key，请在「邮件设置」中配置后再发送",
      latencyMs: 0,
    };
  }

  if (!opts.to || opts.to.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      error: "收件人列表为空",
      latencyMs: 0,
    };
  }

  let htmlBody: string | undefined;
  let textBody: string | undefined;

  if (opts.contentType === "markdown") {
    htmlBody = markdownToHtml(opts.content);
    textBody = opts.content;
  } else if (opts.contentType === "html") {
    htmlBody = opts.content;
  } else {
    textBody = opts.content;
  }

  const payload: Record<string, unknown> = {
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
  };

  if (htmlBody) payload.html = htmlBody;
  if (textBody) payload.text = textBody;
  if (opts.cc && opts.cc.length > 0) payload.cc = opts.cc;
  if (opts.bcc && opts.bcc.length > 0) payload.bcc = opts.bcc;
  if (opts.replyTo && opts.replyTo.trim()) payload.reply_to = opts.replyTo.trim();

  // 随机排序候选密钥列表（每次随机选一个开始）
  const keysToTry = shuffleArray(candidateKeys);
  let lastError = "未知错误";
  let lastHttpStatus = 0;

  for (let i = 0; i < keysToTry.length; i++) {
    const key = keysToTry[i];
    try {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const latencyMs = Date.now() - start;
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (res.ok) {
        return {
          ok: true,
          id: typeof data.id === "string" ? data.id : undefined,
          httpStatus: res.status,
          latencyMs,
          usedKeyMasked: maskApiKey(key),
        };
      }

      const errorMsg =
        typeof data.message === "string"
          ? data.message
          : typeof data.error === "string"
          ? data.error
          : `Resend HTTP ${res.status}`;

      lastError = errorMsg;
      lastHttpStatus = res.status;

      // 若遇到限流 (429) 或配额超限/受限 (403/quota)，且还有其他备用密钥，则继续尝试下一个
      const isQuotaOrRateLimit =
        res.status === 429 ||
        res.status === 403 ||
        /rate\s*limit|quota|exceeded|restricted/i.test(errorMsg);

      if (isQuotaOrRateLimit && i < keysToTry.length - 1) {
        continue;
      }

      return {
        ok: false,
        httpStatus: res.status,
        error: errorMsg,
        latencyMs,
        usedKeyMasked: maskApiKey(key),
      };
    } catch (e) {
      lastError = (e as Error).message || "网络请求超时或未知错误";
      lastHttpStatus = 0;
      if (i < keysToTry.length - 1) {
        continue;
      }
    }
  }

  return {
    ok: false,
    httpStatus: lastHttpStatus,
    error: lastError,
    latencyMs: Date.now() - start,
  };
}
