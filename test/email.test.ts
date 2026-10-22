import { describe, expect, it, vi } from "vitest";
import { interpolateTemplate, markdownToHtml, parseApiKeys, parseEmailList, pickRandomApiKey, sendResendEmail } from "../src/server/email";

describe("email utilities", () => {
  describe("parseEmailList", () => {
    it("parses and trims emails separated by commas, semicolons, and newlines", () => {
      const raw = "user1@example.com, user2@test.org;\nuser3@domain.cn,invalid-email,,user4@sub.example.com";
      const result = parseEmailList(raw);
      expect(result).toEqual([
        "user1@example.com",
        "user2@test.org",
        "user3@domain.cn",
        "user4@sub.example.com",
      ]);
    });

    it("returns empty array for empty or whitespace-only input", () => {
      expect(parseEmailList("")).toEqual([]);
      expect(parseEmailList(null)).toEqual([]);
      expect(parseEmailList("   \n  ")).toEqual([]);
    });
  });

  describe("interpolateTemplate", () => {
    it("interpolates date, time, and datetime placeholders", () => {
      // 2026-10-17 12:30:45 UTC
      const timestamp = new Date("2026-10-17T12:30:45Z").getTime();
      const template = "Report for {{date}} at {{time}} (Full: {{datetime}})";
      const res = interpolateTemplate(template, timestamp, "UTC");
      expect(res).toBe("Report for 2026-10-17 at 12:30:45 (Full: 2026-10-17 12:30:45)");
    });

    it("interpolates year, month, and day", () => {
      const timestamp = new Date("2026-05-09T08:00:00Z").getTime();
      const template = "{{year}}/{{month}}/{{day}}";
      const res = interpolateTemplate(template, timestamp, "UTC");
      expect(res).toBe("2026/05/09");
    });

    it("leaves text without template variables untouched", () => {
      const text = "Hello world, no variables here!";
      expect(interpolateTemplate(text)).toBe(text);
    });
  });

  describe("markdownToHtml", () => {
    it("converts basic markdown to styled HTML", () => {
      const md = "# Title\n\nHello **world** and *italic*.\n\n- Item 1\n- Item 2";
      const html = markdownToHtml(md);
      expect(html).toContain("<h1");
      expect(html).toContain("Title");
      expect(html).toContain("<strong>world</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain("<li");
      expect(html).toContain("Item 1");
    });

    it("handles code blocks", () => {
      const md = "```\nconst x = 1;\n```";
      const html = markdownToHtml(md);
      expect(html).toContain("<pre");
      expect(html).toContain("const x = 1;");
    });
  });

  describe("parseApiKeys & pickRandomApiKey", () => {
    it("parses multiple keys separated by newlines, commas, or semicolons", () => {
      const input = "re_key1, re_key2\nre_key3;re_key1\n  re_key4  ";
      const keys = parseApiKeys(input);
      expect(keys).toEqual(["re_key1", "re_key2", "re_key3", "re_key4"]);
    });

    it("parses JSON array format", () => {
      const input = JSON.stringify(["re_alpha", "re_beta", "re_alpha"]);
      const keys = parseApiKeys(input);
      expect(keys).toEqual(["re_alpha", "re_beta"]);
    });

    it("handles empty or whitespace inputs gracefully", () => {
      expect(parseApiKeys("")).toEqual([]);
      expect(parseApiKeys(null)).toEqual([]);
      expect(parseApiKeys("   \n\t ")).toEqual([]);
    });

    it("picks a key from candidate array", () => {
      const keys = ["re_1", "re_2", "re_3"];
      const picked = pickRandomApiKey(keys);
      expect(keys).toContain(picked);
      expect(pickRandomApiKey([])).toBe("");
    });
  });

  describe("sendResendEmail", () => {
    it("returns error if apiKey is missing", async () => {
      const res = await sendResendEmail({
        apiKey: "",
        from: "test@example.com",
        to: ["user@example.com"],
        subject: "Test",
        content: "Hello",
        contentType: "text",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Resend API Key");
    });

    it("sends request to Resend API and parses response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "email_12345" }),
      });

      const res = await sendResendEmail({
        apiKey: "re_test_key",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Hello Subject",
        content: "Hello Content",
        contentType: "text",
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.ok).toBe(true);
      expect(res.id).toBe("email_12345");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer re_test_key",
          }),
        })
      );
    });

    it("fails over to second key when first key hits 429 rate limit", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        callCount++;
        const auth = (init.headers as Record<string, string>)?.Authorization;
        if (callCount === 1) {
          // First attempt returns 429 Rate Limited
          return {
            ok: false,
            status: 429,
            json: async () => ({ message: "Too many requests, rate limit exceeded" }),
          };
        }
        // Second attempt with the other key succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "email_failover_success" }),
        };
      });

      const res = await sendResendEmail({
        apiKeys: ["re_key_limit", "re_key_backup"],
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Hello Multi Key",
        content: "Testing multi key failover",
        contentType: "text",
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.ok).toBe(true);
      expect(res.id).toBe("email_failover_success");
      expect(callCount).toBe(2);
    });
  });
});
