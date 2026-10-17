import type { EmailJobRow } from "./types";

export type TgPost = {
  channel: string;
  postId: number;
  link: string;
  text?: string;
  dateStr?: string;
  publishedAt?: number; // 消息发布的毫秒时间戳（从 HTML 中的 <time datetime="..."> 解析）
};

export type TgChannelCheckResult = {
  channel: string;
  latestId: number;
  latestPostTime?: number;
  latestPost?: TgPost;
  newPosts: TgPost[];
  error?: string;
};

export type TgJobCheckResult = {
  enabled: boolean;
  hasNew: boolean;
  posts: TgPost[];
  channelErrors: Record<string, string>;
};

/** 解析并清洗频道输入（支持 @channel、完整 t.me 链接、多行或逗号分隔） */
export function parseTgChannels(input: string | null | undefined): string[] {
  if (!input) return [];
  const rawItems = input.split(/[\r\n,;，；\s]+/);
  const channels: string[] = [];

  for (const raw of rawItems) {
    let s = raw.trim();
    if (!s) continue;

    // 清理 URL 前缀: https://t.me/s/, https://t.me/, t.me/s/, t.me/
    s = s.replace(/^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?/i, "");
    s = s.replace(/^t\.me\/(?:s\/)?/i, "");
    // 清理 @ 前缀
    s = s.replace(/^@/, "");
    // 清理可能跟随的查询参数或斜杠
    s = s.split(/[/?#]/)[0].trim();

    // 频道名仅含字母、数字、下划线
    if (/^[a-zA-Z0-9_]{3,}$/.test(s)) {
      channels.push(s);
    }
  }

  return [...new Set(channels)];
}

/** 解析关键词列表（支持英文/中文逗号、分号、换行分隔） */
export function parseTgKeywords(input: string | null | undefined): string[] {
  if (!input) return [];
  return [
    ...new Set(
      input
        .split(/[\r\n,;，；]+/)
        .map((k) => k.trim())
        .filter(Boolean)
    ),
  ];
}

/** 从 Telegram Web 预览 HTML 中提取帖子列表及准确发布时间戳 */
export function extractPostsFromHtml(channel: string, html: string): TgPost[] {
  const posts: TgPost[] = [];
  const seenIds = new Set<number>();

  // 方式1：按消息 Widget 容器分块解析，可提取完整正文与时间
  const chunks = html.split(/<div class="tgme_widget_message(?:\s|")/);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const postMatch = chunk.match(/data-post="([^"]+)"/);
    if (!postMatch) continue;

    const parts = postMatch[1].split("/");
    const ch = (/^[a-zA-Z0-9_]{3,}$/.test(parts[0]) ? parts[0] : channel).trim();
    const postId = Number(parts[1]);
    if (!Number.isFinite(postId) || postId <= 0 || seenIds.has(postId)) continue;
    seenIds.add(postId);

    let text = "";
    const textMatch = chunk.match(/<div class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (textMatch) {
      text = textMatch[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();
    }

    let dateStr = "";
    let publishedAt = 0;
    // Telegram 官方页面包含标准 ISO 8601 时间戳：<time datetime="2026-10-17T05:30:00+00:00" class="time">13:30</time>
    const timeMatch = chunk.match(/<time\s+[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i);
    if (timeMatch) {
      const isoStr = timeMatch[1].trim();
      const parsed = Date.parse(isoStr);
      if (!Number.isNaN(parsed) && parsed > 0) {
        publishedAt = parsed;
      }
      dateStr = timeMatch[2]?.trim() || isoStr.slice(0, 19).replace("T", " ");
    }

    posts.push({
      channel: ch,
      postId,
      link: `https://t.me/${encodeURIComponent(ch)}/${postId}`,
      text: text || undefined,
      dateStr: dateStr || undefined,
      publishedAt,
    });
  }

  // 方式2：若类名变更分块失效，正则保底直接匹配 data-post 属性
  if (posts.length === 0) {
    const directMatches = [...html.matchAll(/data-post="([^/]+)\/(\d+)"/g)];
    for (const m of directMatches) {
      const ch = m[1];
      const postId = Number(m[2]);
      if (Number.isFinite(postId) && postId > 0 && !seenIds.has(postId)) {
        seenIds.add(postId);
        posts.push({
          channel: ch,
          postId,
          link: `https://t.me/${ch}/${postId}`,
          publishedAt: 0,
        });
      }
    }
  }

  // 按发布时间或 postId 升序排序
  posts.sort((a, b) => (a.publishedAt && b.publishedAt ? a.publishedAt - b.publishedAt : a.postId - b.postId));
  return posts;
}

/** 抓取单个 Telegram 频道的帖子，并筛选指定时间起点（如最新 1 小时内）的新消息 */
export async function fetchChannelPosts(
  channel: string,
  sinceTime: number = 0,
  keywords?: string[],
  fetchFn: typeof fetch = fetch
): Promise<TgChannelCheckResult> {
  const url = `https://t.me/s/${channel}`;

  try {
    const res = await fetchFn(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        channel,
        latestId: 0,
        newPosts: [],
        error: `Telegram 抓取返回 HTTP ${res.status}`,
      };
    }

    const html = await res.text();
    const posts = extractPostsFromHtml(channel, html);

    if (posts.length === 0) {
      return {
        channel,
        latestId: 0,
        newPosts: [],
      };
    }

    // 记录该频道最新的一条消息及其发布时间
    const latestPost = posts[posts.length - 1];
    const latestPostTime = latestPost?.publishedAt || 0;

    // 若未指定 sinceTime，默认取最近 1 小时 (3600_000 ms)
    const effectiveSinceTime = sinceTime > 0 ? sinceTime : Date.now() - 60 * 60 * 1000;

    // 核心改进：按时间筛选“最新 1 小时内”的消息，彻底杜绝初次抓取收到大量历史旧数据
    let candidatePosts = posts.filter((p) => {
      if (!p.publishedAt) return false;
      return p.publishedAt >= effectiveSinceTime;
    });

    // 可选关键词过滤（若设置了关键词，则仅保留包含任一关键词的消息）
    if (keywords && keywords.length > 0) {
      candidatePosts = candidatePosts.filter((p) => {
        const textToSearch = `${p.text || ""} ${p.link}`.toLowerCase();
        return keywords.some((kw) => textToSearch.includes(kw.toLowerCase()));
      });
    }

    return {
      channel,
      latestId: latestPost?.postId || 0,
      latestPostTime,
      latestPost,
      newPosts: candidatePosts,
    };
  } catch (e) {
    return {
      channel,
      latestId: 0,
      newPosts: [],
      error: (e as Error).message || "网络请求异常",
    };
  }
}

/** 检查任务关联的所有 Telegram 频道，汇总最新 1 小时内的新消息 */
export async function checkTgChannelsForJob(
  job: EmailJobRow,
  fetchFn: typeof fetch = fetch
): Promise<TgJobCheckResult> {
  const channels = parseTgChannels(job.tg_channels);
  if (channels.length === 0) {
    return {
      enabled: false,
      hasNew: false,
      posts: [],
      channelErrors: {},
    };
  }

  const keywords = parseTgKeywords(job.tg_keywords);

  // 计算本次抓取的时间起点：
  // 1. 基准为当前时间前 1 小时 (60 分钟)；
  // 2. 若任务上一次执行时间在 1 小时以内（例如定时 1 小时轮询且按时唤醒），
  //    则以上次执行时间起算（严格 > last_run_at），无缝衔接且不重复；
  // 3. 若为初次执行，或停用超过 1 小时后重新启用，自动限制在最近 1 小时内，绝不拉取远古旧帖！
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const isIncremental = Boolean(job.last_run_at && job.last_run_at > oneHourAgo);
  const sinceTime = isIncremental ? (job.last_run_at as number) : oneHourAgo;

  const allNewPosts: TgPost[] = [];
  const channelErrors: Record<string, string> = {};

  for (const ch of channels) {
    const result = await fetchChannelPosts(ch, sinceTime, keywords, fetchFn);

    if (result.error) {
      channelErrors[ch] = result.error;
    }

    if (result.newPosts.length > 0) {
      // 若是增量模式，严格按 > sinceTime 避免毫秒级临界重复
      const validPosts = isIncremental
        ? result.newPosts.filter((p) => (p.publishedAt ?? 0) > sinceTime)
        : result.newPosts;
      allNewPosts.push(...validPosts);
    }
  }

  return {
    enabled: true,
    hasNew: allNewPosts.length > 0,
    posts: allNewPosts,
    channelErrors,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** 格式化 Telegram 消息为 HTML 片段 */
export function renderTgPostsToHtml(posts: TgPost[]): string {
  if (posts.length === 0) return "<p>最近 1 小时暂无新消息</p>";

  const cardsHtml = posts
    .map(
      (p) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;background:#f8fafc;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;">
        <span style="font-weight:600;color:#2563eb;">📢 @${escapeHtml(p.channel)} <span style="color:#94a3b8;font-weight:normal;">#${p.postId}</span></span>
        ${p.dateStr ? `<span style="color:#94a3b8;">${escapeHtml(p.dateStr)}</span>` : ""}
      </div>
      ${
        p.text
          ? `<div style="font-size:14px;color:#334155;white-space:pre-wrap;margin-bottom:10px;line-height:1.5;">${escapeHtml(p.text)}</div>`
          : ""
      }
      <div style="font-size:12px;">
        <a href="${p.link}" target="_blank" rel="noopener" style="color:#3b82f6;text-decoration:none;font-weight:500;">查看原始消息 →</a>
      </div>
    </div>`
    )
    .join("");

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;color:#1e293b;line-height:1.6;">
      <div style="border-bottom:2px solid #3b82f6;padding-bottom:10px;margin-bottom:16px;">
        <h2 style="margin:0 0 4px;font-size:18px;color:#0f172a;">Telegram 频道更新通知 (近 1 小时)</h2>
        <p style="margin:0;font-size:13px;color:#64748b;">共检测到 ${posts.length} 条新消息</p>
      </div>
      <div>
        ${cardsHtml}
      </div>
    </div>
  `;
}

/** 格式化 Telegram 消息为 Markdown 片段 */
export function renderTgPostsToMarkdown(posts: TgPost[]): string {
  if (posts.length === 0) return "最近 1 小时暂无新消息";

  return posts
    .map(
      (p) =>
        `### 📢 @${p.channel} (#${p.postId})${p.dateStr ? ` · *${p.dateStr}*` : ""}\n\n` +
        (p.text ? `${p.text}\n\n` : "") +
        `[查看原始消息](${p.link})`
    )
    .join("\n\n---\n\n");
}

/** 格式化 Telegram 消息为纯文本片段 */
export function renderTgPostsToText(posts: TgPost[]): string {
  if (posts.length === 0) return "最近 1 小时暂无新消息";

  return posts
    .map(
      (p) =>
        `[@${p.channel} #${p.postId}]${p.dateStr ? ` (${p.dateStr})` : ""}\n` +
        (p.text ? `${p.text}\n` : "") +
        `链接: ${p.link}`
    )
    .join("\n----------------------------------------\n");
}

/**
 * 将 Telegram 消息插值到邮件正文与标题中
 * 支持变量：
 * - {{tg_messages}}: 消息列表渲染结果
 * - {{tg_count}}: 新消息数量
 * - {{tg_channels}}: 频道列表（逗号分隔）
 */
export function formatTgEmail(
  posts: TgPost[],
  channels: string[],
  templateSubject: string,
  templateContent: string,
  contentType: "text" | "html" | "markdown"
): { subject: string; content: string } {
  const countStr = String(posts.length);
  const channelsStr = channels.join(", ");

  let subject = templateSubject.trim();
  if (!subject) {
    subject = `Telegram 频道更新: 近 1 小时有 ${countStr} 条新消息`;
  }
  subject = subject
    .replace(/\{\{tg_count\}\}/g, countStr)
    .replace(/\{\{tg_channels\}\}/g, channelsStr);

  let renderedMessages = "";
  if (contentType === "html") {
    renderedMessages = renderTgPostsToHtml(posts);
  } else if (contentType === "markdown") {
    renderedMessages = renderTgPostsToMarkdown(posts);
  } else {
    renderedMessages = renderTgPostsToText(posts);
  }

  let content = templateContent || "";
  if (content.includes("{{tg_messages}}")) {
    content = content.replace(/\{\{tg_messages\}\}/g, renderedMessages);
  } else {
    // 若用户正文中未写占位符，且正文非空，则追加在正文下方；若正文为空则直接使用渲染内容
    if (content.trim()) {
      if (contentType === "html") {
        content = `${content}<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />${renderedMessages}`;
      } else {
        content = `${content}\n\n---\n\n${renderedMessages}`;
      }
    } else {
      content = renderedMessages;
    }
  }

  content = content
    .replace(/\{\{tg_count\}\}/g, countStr)
    .replace(/\{\{tg_channels\}\}/g, channelsStr);

  return { subject, content };
}
