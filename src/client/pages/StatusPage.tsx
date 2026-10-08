import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get } from "../api";
import SiteFooter from "../components/SiteFooter";
import ThemeToggle from "../components/ThemeToggle";
import { useTheme } from "../theme";
import type { StatusPageData } from "../types";
import { Badge, Skeleton } from "../ui";
import { LayoutDashboard, UserRound } from "../ui/icons";
import HeartbeatBar from "../ui/HeartbeatBar";
import { cx, focusRing } from "../ui/styles";
import { useAlive } from "../utils/useAlive";
import { useAutoRefresh } from "../utils/useAutoRefresh";

/** 公开状态页（/status/:slug）：免登录展示选中监控的运行概况，数据已在服务端脱敏。 */
export default function StatusPage() {
  const { slug = "" } = useParams();
  const alive = useAlive();
  useTheme(); // 挂载即应用主题偏好（与 index.html 防闪脚本同一规则）

  const [data, setData] = useState<StatusPageData | null>(null);
  const [missing, setMissing] = useState(false);
  // 登录态探测：已登录入口直达仪表盘，未登录去登录页。null = 检测中，先按访客渲染
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    get("/api/auth/me")
      .then(() => { if (alive.current) setLoggedIn(true); })
      .catch(() => { if (alive.current) setLoggedIn(false); });
  }, []);

  function load() {
    get<StatusPageData>(`/api/status/${encodeURIComponent(slug)}`)
      .then(d => {
        if (!alive.current) return;
        setData(d);
        setMissing(false);
      })
      .catch(() => {
        // 已有数据时保留旧内容等下一轮重试；首屏失败才落「未开放」
        if (alive.current && data === null) setMissing(true);
      });
  }

  useEffect(load, [slug]);
  useAutoRefresh(load, 30_000);

  useEffect(() => {
    document.title = data?.title ?? "状态页";
  }, [data?.title]);

  const downCount = data?.monitors.filter(m => m.status === "down").length ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      {/* 主题切换贴页面右上角 */}
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-fg">{data?.title ?? "状态页"}</h1>
          <Link
            to={loggedIn ? "/" : "/login"}
            aria-label={loggedIn ? "前往仪表盘" : "管理员登录"}
            title={loggedIn ? "前往仪表盘" : "管理员登录"}
            className={cx(
              "rounded-md p-2 text-fg-subtle",
              "transition-colors duration-fast hover:bg-panel-hover hover:text-fg",
              focusRing,
            )}>
            {loggedIn
              ? <LayoutDashboard className="size-4" aria-hidden />
              : <UserRound className="size-4" aria-hidden />}
          </Link>
        </div>
      {missing ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-fg-subtle">状态页不存在或未开放。</p>
        </div>
      ) : data === null ? (
        <div className="mt-6 space-y-4" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <div className={cx(
            "mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium",
            downCount > 0
              ? "border-danger/40 bg-danger-soft text-danger"
              : "border-success/40 bg-success-soft text-success",
          )}>
            <span className={cx("size-2 rounded-full", downCount > 0 ? "bg-danger" : "bg-success")} aria-hidden />
            {downCount > 0 ? `${downCount} 个服务故障` : "所有系统正常"}
          </div>

          {data.monitors.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-border py-10 text-center text-sm text-fg-subtle">
              管理员还没有公开任何监控。
            </p>
          ) : (
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {data.monitors.map(m => {
                const info = `24h 在线 ${m.uptime_24h === null ? "—" : `${m.uptime_24h}%`}${m.avg_latency_24h !== null ? ` · 平均延迟 ${m.avg_latency_24h}ms` : ""}`;
                return (
                  <div key={m.id} className="flex flex-col rounded-xl border border-border bg-panel p-4">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{m.name}</span>
                      <span title={info} className="shrink-0 cursor-pointer">
                        <Badge tone={m.status === "up" ? "success" : m.status === "down" ? "danger" : "neutral"}>
                          {m.status === "up" ? "正常" : m.status === "down" ? "故障" : "待探测"}
                        </Badge>
                      </span>
                    </div>
                    <HeartbeatBar beats={m.beats} slots={40} className="mt-3" />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      </div>
      <div className="mt-auto"><SiteFooter /></div>
    </div>
  );
}
