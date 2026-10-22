import { describe, expect, it, vi } from "vitest";
import {
  extractPostsFromHtml,
  fetchChannelPosts,
  formatTgEmail,
  parseTgChannels,
  parseTgKeywords,
  type TgPost,
} from "../src/server/tg-monitor";

describe("Telegram Channel Monitor", () => {
  describe("parseTgChannels", () => {
    it("cleans and normalizes various Telegram channel URL formats and usernames", () => {
      const input = `
        @durov
        https://t.me/telegram
        https://t.me/s/cloudflare_status
        t.me/openai_news?start=123
        invalid!!
        @durov
      `;
      const channels = parseTgChannels(input);
      expect(channels).toEqual(["durov", "telegram", "cloudflare_status", "openai_news"]);
    });

    it("handles comma and semicolon separated channel list", () => {
      const input = "channel1, @channel2; https://t.me/channel3, channel1";
      const channels = parseTgChannels(input);
      expect(channels).toEqual(["channel1", "channel2", "channel3"]);
    });

    it("returns empty array for empty inputs", () => {
      expect(parseTgChannels("")).toEqual([]);
      expect(parseTgChannels(null)).toEqual([]);
      expect(parseTgChannels("   \n "));
    });
  });

  describe("parseTgKeywords", () => {
    it("splits keywords by comma, semicolon, and newline", () => {
      const input = "优惠, 折扣; 抽奖\n限免, 优惠";
      const keywords = parseTgKeywords(input);
      expect(keywords).toEqual(["优惠", "折扣", "抽奖", "限免"]);
    });
  });

  describe("extractPostsFromHtml", () => {
    it("extracts posts, text, date and links from Telegram web widget HTML", () => {
      const mockHtml = `
        <div class="tgme_channel_info">Channel Header</div>
        <div class="tgme_widget_message" data-post="my_channel/101">
          <div class="tgme_widget_message_text">First post content with <b>bold</b> text &amp; more.</div>
          <time datetime="2026-10-17T08:00:00+00:00">16:00</time>
        </div>
        <div class="tgme_widget_message" data-post="my_channel/102">
          <div class="tgme_widget_message_text">Second post <a href="https://example.com">Visit site</a></div>
          <time datetime="2026-10-17T09:30:00+00:00">17:30</time>
        </div>
      `;

      const posts = extractPostsFromHtml("my_channel", mockHtml);
      expect(posts.length).toBe(2);
      expect(posts[0].postId).toBe(101);
      expect(posts[0].channel).toBe("my_channel");
      expect(posts[0].link).toBe("https://t.me/my_channel/101");
      expect(posts[0].text).toContain("First post content with bold text & more.");
      expect(posts[0].dateStr).toBe("16:00");

      expect(posts[1].postId).toBe(102);
      expect(posts[1].link).toBe("https://t.me/my_channel/102");
      expect(posts[1].text).toContain("Second post Visit site (https://example.com)");
    });

    it("falls back to data-post regex if widget container split fails", () => {
      const mockHtml = `
        <div data-post="news_channel/555"></div>
        <div data-post="news_channel/556"></div>
      `;
      const posts = extractPostsFromHtml("news_channel", mockHtml);
      expect(posts.length).toBe(2);
      expect(posts[0].postId).toBe(555);
      expect(posts[1].postId).toBe(556);
      expect(posts[0].link).toBe("https://t.me/news_channel/555");
    });
  });

  describe("fetchChannelPosts", () => {
    it("fetches posts and filters messages based on 1-hour time window (sinceTime)", async () => {
      const now = Date.now();
      const thirtyMinsAgo = new Date(now - 30 * 60 * 1000).toISOString();
      const twoHoursAgo = new Date(now - 120 * 60 * 1000).toISOString();

      const mockHtml = `
        <div class="tgme_widget_message" data-post="tech_channel/10">
          <div class="tgme_widget_message_text">Old post from 2 hours ago</div>
          <time datetime="${twoHoursAgo}">10:00</time>
        </div>
        <div class="tgme_widget_message" data-post="tech_channel/11">
          <div class="tgme_widget_message_text">New post from 30 mins ago</div>
          <time datetime="${thirtyMinsAgo}">11:30</time>
        </div>
      `;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => mockHtml,
      });

      // Filter for latest 1 hour (now - 60 mins)
      const oneHourAgo = now - 60 * 60 * 1000;
      const res = await fetchChannelPosts("tech_channel", oneHourAgo, undefined, mockFetch as unknown as typeof fetch);
      expect(res.channel).toBe("tech_channel");
      expect(res.latestId).toBe(11);
      expect(res.newPosts.length).toBe(1);
      expect(res.newPosts[0].postId).toBe(11);
      expect(res.newPosts[0].text).toContain("New post from 30 mins ago");
    });

    it("filters posts by keywords within the time window", async () => {
      const now = Date.now();
      const tenMinsAgo = new Date(now - 10 * 60 * 1000).toISOString();

      const mockHtml = `
        <div class="tgme_widget_message" data-post="deals/201">
          <div class="tgme_widget_message_text">Today has no special promo</div>
          <time datetime="${tenMinsAgo}">11:50</time>
        </div>
        <div class="tgme_widget_message" data-post="deals/202">
          <div class="tgme_widget_message_text">Special DISCOUNT code available now!</div>
          <time datetime="${tenMinsAgo}">11:51</time>
        </div>
      `;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => mockHtml,
      });

      const res = await fetchChannelPosts("deals", now - 3600_000, ["discount", "优惠"], mockFetch as unknown as typeof fetch);
      expect(res.newPosts.length).toBe(1);
      expect(res.newPosts[0].postId).toBe(202);
      expect(res.latestId).toBe(202);
    });

    it("handles fetch failure gracefully without throwing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const res = await fetchChannelPosts("private_or_deleted", 0, undefined, mockFetch as unknown as typeof fetch);
      expect(res.newPosts.length).toBe(0);
      expect(res.error).toContain("HTTP 404");
    });
  });

  describe("formatTgEmail", () => {
    const samplePosts: TgPost[] = [
      {
        channel: "durov",
        postId: 250,
        link: "https://t.me/durov/250",
        text: "Telegram reached 950M active users!",
        dateStr: "12:00",
      },
    ];

    it("interpolates {{tg_count}}, {{tg_channels}}, and {{tg_messages}} in subject and content", () => {
      const { subject, content } = formatTgEmail(
        samplePosts,
        ["durov"],
        "Notice: {{tg_channels}} has {{tg_count}} new messages",
        "Here are the updates:\n{{tg_messages}}\nEnjoy reading!",
        "markdown"
      );

      expect(subject).toBe("Notice: durov has 1 new messages");
      expect(content).toContain("Here are the updates:");
      expect(content).toContain("Telegram reached 950M active users!");
      expect(content).toContain("https://t.me/durov/250");
      expect(content).toContain("Enjoy reading!");
    });

    it("appends messages if template content does not include {{tg_messages}}", () => {
      const { subject, content } = formatTgEmail(
        samplePosts,
        ["durov"],
        "",
        "Custom greeting header",
        "html"
      );

      expect(subject).toBe("Telegram 频道更新: 近 1 小时有 1 条新消息");
      expect(content).toContain("Custom greeting header");
      expect(content).toContain("Telegram 频道更新通知");
      expect(content).toContain("https://t.me/durov/250");
    });
  });
});
