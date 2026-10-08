import { cx } from "./styles";
import { fmtTime } from "../utils/time";
import type { Heartbeat } from "../types";

type Props = {
  /** 旧→新排序的心跳；不足 slots 时左侧补空格。只需 created_at/status（公开页数据经裁剪后无 id） */
  beats: Array<{
    id?: number;
    created_at: number;
    status: "up" | "down";
    http_status?: number | null;
    latency_ms?: number | null;
    error_message?: string | null;
  }>;
  /** 条带格数 */
  slots?: number;
  /** 条带整体高度（Tailwind 类） */
  size?: "sm" | "lg";
  className?: string;
  /** 传入后整条可点（列表用它打开详情抽屉）；详情抽屉内的条带不传 */
  onClick?: () => void;
};

/** 心跳条带：每格一次探测，绿=成功 红=失败 灰=暂无数据，
 * 原生 title 提示详情。纯 div 实现，无图表库依赖。 */
export default function HeartbeatBar({ beats, slots = 20, size = "sm", className, onClick }: Props) {
  // 不足补位放在左侧：右侧对齐最新的探测，与时间轴方向一致
  const pad = Math.max(0, slots - beats.length);
  const shown = beats.slice(-slots);
  return (
    // 条带点击只是鼠标便利；容器保持 role="img"，键盘走卡片/行的「查看详情」按钮。
    <div
      onClick={onClick}
      className={cx("flex w-full gap-[2px]", onClick && "cursor-pointer", className)}
      role="img"
      aria-label={`最近 ${shown.length} 次探测，${shown.filter(b => b.status === "up").length} 次成功`}
    >
      {Array.from({ length: pad }, (_, i) => (
        // 空位淡灰预填充，零数据时整条也可见
        <div key={`pad-${i}`}
          className={cx("min-w-0 flex-1 rounded-[2px] bg-border/60", size === "sm" ? "h-5" : "h-8")} />
      ))}
      {shown.map((b, i) => (
        <div
          key={b.id ?? i}
          title={beatTitle(b)}
          className={cx(
            "min-w-0 flex-1 cursor-pointer rounded-[2px] transition-transform duration-fast ease-smooth hover:scale-125",
            size === "sm" ? "h-5" : "h-8",
            b.status === "up" ? "bg-success" : "bg-danger",
          )}
        />
      ))}
    </div>
  );
}

function beatTitle(b: {
  created_at: number;
  status: "up" | "down";
  http_status?: number | null;
  latency_ms?: number | null;
  error_message?: string | null;
}): string {
  const head = `${fmtTime(b.created_at)} · ${b.status === "up" ? "成功" : "失败"}`;
  if (b.status === "up") {
    return `${head} · HTTP ${b.http_status ?? "-"} · ${b.latency_ms ?? "-"}ms`;
  }
  const detail = b.error_message ?? (b.http_status != null ? `HTTP ${b.http_status}` : "-");
  return `${head} · ${detail}`;
}
