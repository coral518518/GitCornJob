import { describe, expect, it, vi } from "vitest";
import { interpolateTemplate, markdownToHtml, parseEmailList, sendResendEmail } from "./email";

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
  });
});
