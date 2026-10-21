import { describe, expect, it, vi } from "vitest";
import { executeHttpRequest, parseHttpHeaders } from "./email-scheduler";

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
  });
});
