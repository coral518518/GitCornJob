import { describe, expect, it, vi } from "vitest";
import { checkHttpAssertion, executeHttpRequest, parseHttpHeaders } from "../src/server/email-scheduler";

describe("HTTP task execution & header parser", () => {
  describe("parseHttpHeaders", () => {
    it("parses multiline key-value string", () => {
      const raw = `
        Authorization: Bearer secret-token-123
        Content-Type: application/json
        X-Custom-Id: 42
      `;
      const headers = parseHttpHeaders(raw);
      expect(headers).toEqual({
        Authorization: "Bearer secret-token-123",
        "Content-Type": "application/json",
        "X-Custom-Id": "42",
      });
    });

    it("parses JSON formatted string", () => {
      const raw = JSON.stringify({
        Authorization: "Bearer token-abc",
        Accept: "application/json",
        "X-Retry": 3,
      });
      const headers = parseHttpHeaders(raw);
      expect(headers).toEqual({
        Authorization: "Bearer token-abc",
        Accept: "application/json",
        "X-Retry": "3",
      });
    });

    it("returns empty object for empty or whitespace-only headers", () => {
      expect(parseHttpHeaders("")).toEqual({});
      expect(parseHttpHeaders(null)).toEqual({});
      expect(parseHttpHeaders("   \n  ")).toEqual({});
    });

    it("ignores comments and invalid lines", () => {
      const raw = `
        # This is a comment
        // Another comment
        Valid-Header: valid-value
        InvalidLineWithoutColon
      `;
      const headers = parseHttpHeaders(raw);
      expect(headers).toEqual({
        "Valid-Header": "valid-value",
      });
    });
  });

  describe("executeHttpRequest", () => {
    it("successfully sends request and parses response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ success: true, count: 5 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const res = await executeHttpRequest({
        url: "https://api.example.com/sync",
        method: "POST",
        headers: "Authorization: Bearer 123",
        body: JSON.stringify({ action: "test" }),
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.bodyPreview).toContain('"success":true');
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/sync",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "test" }),
        })
      );

      vi.unstubAllGlobals();
    });

    it("handles HTTP 500 error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers(),
        text: async () => "Internal server error occurred",
      });
      vi.stubGlobal("fetch", mockFetch);

      const res = await executeHttpRequest({
        url: "https://api.example.com/fail",
        method: "GET",
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      expect(res.error).toContain("HTTP 500");
      expect(res.error).toContain("Internal server error occurred");

      vi.unstubAllGlobals();
    });

    it("handles fetch network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const res = await executeHttpRequest({
        url: "https://api.example.com/broken",
        method: "GET",
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toContain("Connection refused");

      vi.unstubAllGlobals();
    });

    it("evaluates custom expectedStatus rule like '200,400;data:ok=true'", async () => {
      // 1. 满足 400 且 data.ok === true
      const mockFetch1 = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ data: { ok: true } }),
      });
      vi.stubGlobal("fetch", mockFetch1);

      const res1 = await executeHttpRequest({
        url: "https://api.example.com/custom",
        method: "POST",
        expectedStatus: "200,400;data:ok=true",
      });
      expect(res1.ok).toBe(true);
      expect(res1.status).toBe(400);

      // 2. 状态码 200，但 data.ok === false
      const mockFetch2 = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ data: { ok: false } }),
      });
      vi.stubGlobal("fetch", mockFetch2);

      const res2 = await executeHttpRequest({
        url: "https://api.example.com/custom",
        method: "POST",
        expectedStatus: "200,400;data:ok=true",
      });
      expect(res2.ok).toBe(false);
      expect(res2.error).toContain("不匹配");

      // 3. 仅状态码判定如 '200'，400 应失败
      const res3 = await executeHttpRequest({
        url: "https://api.example.com/custom",
        method: "POST",
        expectedStatus: "200",
      });
      expect(res3.ok).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe("checkHttpAssertion", () => {
    it("handles status code only rule", () => {
      expect(checkHttpAssertion(200, "", "200").ok).toBe(true);
      expect(checkHttpAssertion(201, "", "200").ok).toBe(false);
      expect(checkHttpAssertion(200, "", "200,400").ok).toBe(true);
      expect(checkHttpAssertion(400, "", "200,400").ok).toBe(true);
      expect(checkHttpAssertion(500, "", "200,400").ok).toBe(false);
    });

    it("handles status code and json path assertion", () => {
      const okJson = JSON.stringify({ code: 0, data: { ok: true } });
      const failJson = JSON.stringify({ code: 0, data: { ok: false } });
      const missingJson = JSON.stringify({ code: 0 });

      // 匹配 data:ok=true
      expect(checkHttpAssertion(200, okJson, "200,400;data:ok=true").ok).toBe(true);
      expect(checkHttpAssertion(400, okJson, "200,400;data:ok=true").ok).toBe(true);
      expect(checkHttpAssertion(500, okJson, "200,400;data:ok=true").ok).toBe(false);
      expect(checkHttpAssertion(200, failJson, "200,400;data:ok=true").ok).toBe(false);
      expect(checkHttpAssertion(200, missingJson, "200,400;data:ok=true").ok).toBe(false);

      // 点号路径 data.ok=true
      expect(checkHttpAssertion(200, okJson, "200;data.ok=true").ok).toBe(true);
      // 数字匹配 code=0
      expect(checkHttpAssertion(200, okJson, "200;code=0").ok).toBe(true);
    });

    it("handles non-json body gracefully when body assertion is present", () => {
      const res = checkHttpAssertion(200, "<html>Error</html>", "200;data:ok=true");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("不是有效 JSON");
    });
  });
});
