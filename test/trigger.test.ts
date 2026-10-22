import { describe, expect, it, vi, beforeEach } from "vitest";
import triggerRoutes from "../src/server/routes/trigger";
import { sha256Hex } from "../src/server/crypto";
import { runDueJobs, triggerJobOnce } from "../src/server/scheduler";
import { runDueMonitors } from "../src/server/monitor";
import { runDueEmailJobs, triggerEmailJobOnce } from "../src/server/email-scheduler";
import type { Env } from "../src/server/types";

vi.mock("../src/server/scheduler", () => ({
  runDueJobs: vi.fn(),
  triggerJobOnce: vi.fn(),
}));

vi.mock("../src/server/monitor", () => ({
  runDueMonitors: vi.fn(),
}));

vi.mock("../src/server/email-scheduler", () => ({
  runDueEmailJobs: vi.fn(),
  triggerEmailJobOnce: vi.fn(),
}));

describe("Trigger routes (/api/trigger)", () => {
  const validToken = "chb_testtoken123456789";
  let tokenHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tokenHash = await sha256Hex(validToken);
  });

  function createMockEnv() {
    return {
      DB: {
        prepare: (sql: string) => {
          let boundParams: unknown[] = [];
          return {
            bind: (...params: unknown[]) => {
              boundParams = params;
              return {
                first: async () => {
                  if (sql.includes("SELECT * FROM api_tokens") && boundParams[0] === tokenHash) {
                    return { id: 1, name: "test", token_hash: tokenHash, last_used_at: Date.now() };
                  }
                  return null;
                },
                run: async () => ({ success: true, meta: { changes: 1 } }),
              };
            },
          };
        },
      },
    } as unknown as Env;
  }

  it("rejects requests without authorization header", async () => {
    const res = await triggerRoutes.request("/", { method: "POST" }, createMockEnv());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "缺少 API Token（Authorization: Bearer <token>）" });
  });

  it("rejects requests with invalid token", async () => {
    const res = await triggerRoutes.request(
      "/",
      { method: "POST", headers: { Authorization: "Bearer invalid_token" } },
      createMockEnv()
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "API Token 无效或已撤销" });
  });

  it("POST / triggers full schedule including runDueEmailJobs", async () => {
    vi.mocked(runDueJobs).mockResolvedValue({ triggered: 2, failed: 0 });
    vi.mocked(runDueMonitors).mockResolvedValue({ probed: 3, down: 1 });
    vi.mocked(runDueEmailJobs).mockResolvedValue({ triggered: 1, failed: 0 });

    const res = await triggerRoutes.request(
      "/",
      { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
      createMockEnv()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      data: {
        triggered: 2,
        failed: 0,
        probed: 3,
        down: 1,
        emailTriggered: 1,
        emailFailed: 0,
      },
    });

    expect(runDueJobs).toHaveBeenCalledTimes(1);
    expect(runDueMonitors).toHaveBeenCalledTimes(1);
    expect(runDueEmailJobs).toHaveBeenCalledTimes(1);
  });

  describe("POST /jobs/:id (single GithubAction trigger)", () => {
    it("validates invalid task ID", async () => {
      const res = await triggerRoutes.request(
        "/jobs/abc",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: "任务 ID 无效" });
    });

    it("returns 404 when GithubAction job does not exist", async () => {
      vi.mocked(triggerJobOnce).mockResolvedValue({ notFound: true });

      const res = await triggerRoutes.request(
        "/jobs/99",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: "GithubAction 任务不存在" });
    });

    it("triggers GithubAction successfully", async () => {
      vi.mocked(triggerJobOnce).mockResolvedValue({ ok: true, httpStatus: 204 });

      const res = await triggerRoutes.request(
        "/jobs/5",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, data: null });
      expect(triggerJobOnce).toHaveBeenCalledWith(expect.anything(), 5, "manual");
    });
  });

  describe("POST /tasks/:id and /email-jobs/:id (single Scheduled Task trigger)", () => {
    it("validates invalid task ID", async () => {
      const res = await triggerRoutes.request(
        "/tasks/-1",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: "任务 ID 无效" });
    });

    it("returns 404 when scheduled task does not exist", async () => {
      vi.mocked(triggerEmailJobOnce).mockResolvedValue({ notFound: true });

      const res = await triggerRoutes.request(
        "/tasks/999",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: "定时任务不存在" });
    });

    it("triggers scheduled task successfully via /tasks/:id", async () => {
      vi.mocked(triggerEmailJobOnce).mockResolvedValue({
        ok: true,
        httpStatus: 200,
        resendId: "msg_123",
      });

      const res = await triggerRoutes.request(
        "/tasks/3",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: { resendId?: string } };
      expect(body.ok).toBe(true);
      expect(body.data.resendId).toBe("msg_123");
      expect(triggerEmailJobOnce).toHaveBeenCalledWith(expect.anything(), 3, "manual");
    });

    it("triggers scheduled task successfully via /email-jobs/:id alias", async () => {
      vi.mocked(triggerEmailJobOnce).mockResolvedValue({
        ok: true,
        httpStatus: 200,
      });

      const res = await triggerRoutes.request(
        "/email-jobs/3",
        { method: "POST", headers: { Authorization: `Bearer ${validToken}` } },
        createMockEnv()
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(triggerEmailJobOnce).toHaveBeenCalledWith(expect.anything(), 3, "manual");
    });
  });
});
