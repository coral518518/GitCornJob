import { describe, expect, it } from "vitest";
import {
  extractTgBotToken,
  formatTgUpdatesToMarkdown,
  maskAppToken,
  parseWxPusherUids,
  resolveTgBotToken,
  type TgUpdate,
} from "./wxpusher";
import type { Env } from "./types";

describe("wxpusher helper functions", () => {
  describe("extractTgBotToken", () => {
    it("extracts token from standard bot api URL", () => {
      const url = "https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage?chat_id=-100123456789";
      expect(extractTgBotToken(url)).toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    });

    it("extracts token from URL without query params", () => {
      const url = "https://api.telegram.org/bot987654:XYZ_bot_token";
      expect(extractTgBotToken(url)).toBe("987654:XYZ_bot_token");
    });

    it("accepts raw token string directly", () => {
      const token = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";
      expect(extractTgBotToken(token)).toBe(token);
    });

    it("returns empty string when input is empty", () => {
      expect(extractTgBotToken("")).toBe("");
      expect(extractTgBotToken("   ")).toBe("");
    });
  });

  describe("resolveTgBotToken", () => {
    it("resolves raw token directly without database query", async () => {
      const mockEnv = {} as Env;
      const res = await resolveTgBotToken("123456:ABC_direct_token", mockEnv);
      expect(res).toBe("123456:ABC_direct_token");
    });

    it("resolves channel reference by querying database", async () => {
      const mockEnv = {
        DB: {
          prepare: (sql: string) => ({
            bind: (...args: unknown[]) => ({
              first: async () => ({
                url: "https://api.telegram.org/bot999888:Channel_Token/sendMessage",
              }),
            }),
          }),
        },
      } as unknown as Env;

      const res = await resolveTgBotToken("channel:42", mockEnv);
      expect(res).toBe("999888:Channel_Token");
    });

    it("returns empty string when channel not found", async () => {
      const mockEnv = {
        DB: {
          prepare: (sql: string) => ({
            bind: (...args: unknown[]) => ({
              first: async () => null,
            }),
          }),
        },
      } as unknown as Env;

      const res = await resolveTgBotToken("channel:999", mockEnv);
      expect(res).toBe("");
    });
  });

  describe("parseWxPusherUids", () => {
    it("parses single UID", () => {
      expect(parseWxPusherUids("UID_abc123")).toEqual(["UID_abc123"]);
    });

    it("splits comma, semicolon, space, newline separated UIDs and deduplicates", () => {
      const input = "UID_1, UID_2; UID_3\nUID_1\r\n UID_4  ";
      expect(parseWxPusherUids(input)).toEqual(["UID_1", "UID_2", "UID_3", "UID_4"]);
    });

    it("returns empty array for empty input", () => {
      expect(parseWxPusherUids("")).toEqual([]);
      expect(parseWxPusherUids(undefined)).toEqual([]);
    });
  });

  describe("maskAppToken", () => {
    it("masks tokens properly", () => {
      expect(maskAppToken("AT_1234567890abcdef")).toBe("AT_12••••cdef");
      expect(maskAppToken("short")).toBe("••••••••");
      expect(maskAppToken("")).toBe("");
    });
  });

  describe("formatTgUpdatesToMarkdown", () => {
    it("formats multiple Telegram updates into readable Markdown object", () => {
      const updates: TgUpdate[] = [
        {
          update_id: 1001,
          message: {
            message_id: 10,
            date: 1729488000,
            from: { id: 111, first_name: "Alice", username: "alice_w" },
            chat: { id: 111, type: "private" },
            text: "Hello ClawBot! 自动化提醒测试。",
          },
        },
        {
          update_id: 1002,
          channel_post: {
            message_id: 20,
            date: 1729488060,
            chat: { id: -100999, title: "DevOps 发布频道", type: "channel" },
            text: "服务已平滑升级至 v2.5.0",
          },
        },
      ];

      const res = formatTgUpdatesToMarkdown(updates, "Asia/Shanghai");
      expect(res.title).toContain("Telegram 未读消息汇总 (2 条)");
      expect(res.content).toContain("### 🤖 Telegram 新消息汇总 (2 条)");
      expect(res.content).toContain("Alice (@alice_w)");
      expect(res.content).toContain("Hello ClawBot! 自动化提醒测试。");
      expect(res.content).toContain("DevOps 发布频道");
      expect(res.content).toContain("服务已平滑升级至 v2.5.0");
      expect(res.summary).toContain("收到 2 条新消息");
    });

    it("handles updates with captions and photo/document placeholders", () => {
      const updates: TgUpdate[] = [
        {
          update_id: 2001,
          message: {
            message_id: 15,
            date: 1729488100,
            from: { id: 222, first_name: "Bob" },
            chat: { id: 222, type: "private" },
            caption: "查看报表截图",
          },
        },
      ];

      const res = formatTgUpdatesToMarkdown(updates);
      expect(res.content).toContain("Bob");
      expect(res.content).toContain("查看报表截图");
    });
  });
});
