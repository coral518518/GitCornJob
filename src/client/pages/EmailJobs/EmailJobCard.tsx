import { Badge, Card, Switch, iconActionDanger, iconActionInfo, iconActionSuccess } from "../../ui";
import { ArrowRight, CircleCheck, CircleX, Clock, History, LoaderCircle, Mail, Pencil, Play, Timer, Trash2 } from "../../ui/icons";
import type { EmailJob } from "../../types";
import { fmtShort, fmtShortTz, relativeTime } from "../../utils/time";
import { describeLocal, displayTzOf, parseSchedule } from "../Jobs/schedule";

type Props = {
  job: EmailJob;
  triggering: boolean;
  onToggle: () => void;
  onTrigger: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onViewLogs: () => void;
};

export default function EmailJobCard({
  job,
  triggering,
  onToggle,
  onTrigger,
  onEdit,
  onRemove,
  onViewLogs,
}: Props) {
  const scheduleJson = parseSchedule(job.schedule_json);
  const schedule = describeLocal(scheduleJson, job.timezone);
  const dTz = displayTzOf(scheduleJson, job.timezone);

  return (
    <Card className="flex flex-col gap-2.5 p-4 transition-colors duration-fast ease-smooth hover:border-border-strong">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-fg" title={job.name}>
          {job.name}
        </span>
        <div className="flex items-center gap-1.5">
          {job.tg_channels && <Badge tone="neutral">TG 监控</Badge>}
          <Badge tone="neutral">{job.content_type.toUpperCase()}</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-fg-muted">
        <div className="flex items-center gap-1.5 font-mono">
          <Mail className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate" title={job.to_emails}>
            {job.to_emails}
          </span>
        </div>
        {job.tg_channels && (
          <div className="flex items-center gap-1.5 text-xs text-primary font-mono truncate" title={job.tg_channels}>
            <span className="font-semibold text-[11px] rounded bg-primary/10 px-1 py-0.2">TG 频道</span>
            <span className="truncate">{job.tg_channels}</span>
            {job.tg_keywords && (
              <span className="text-fg-subtle truncate text-[11px]">({job.tg_keywords})</span>
            )}
          </div>
        )}
        <div className="truncate text-fg">
          <span className="text-fg-subtle">标题：</span>
          <span title={job.subject}>{job.subject}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <Timer className="size-3.5 shrink-0" aria-hidden />
          {schedule}
        </span>
        {job.enabled === 1 && (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <ArrowRight className="size-3.5 shrink-0" aria-hidden />
            下次 {fmtShortTz(job.next_run_at, dTz)}
            <span className="text-fg-subtle">({relativeTime(job.next_run_at)})</span>
          </span>
        )}
      </div>

      <div className="text-xs">
        {job.last_status === "success" ? (
          <div className="inline-flex items-center gap-1.5 text-success">
            <CircleCheck className="size-3.5 shrink-0" />
            <span>
              最近成功：{job.last_triggered_at ? fmtShort(job.last_triggered_at) : "已完成"} (
              {job.last_triggered_at ? relativeTime(job.last_triggered_at) : ""})
            </span>
          </div>
        ) : job.last_status === "failed" ? (
          <div className="inline-flex items-center gap-1.5 text-danger">
            <CircleX className="size-3.5 shrink-0" />
            <span>
              最近失败：{job.last_triggered_at ? fmtShort(job.last_triggered_at) : "失败"} (
              {job.last_triggered_at ? relativeTime(job.last_triggered_at) : ""})
            </span>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5 text-fg-subtle">
            <Clock className="size-3.5 shrink-0" />
            <span>尚未触发</span>
          </div>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-2">
          {job.enabled === 1 ? (
            <Badge tone="success">启用</Badge>
          ) : (job.fail_streak ?? 0) > 0 ? (
            <Badge tone="warn">已自动暂停</Badge>
          ) : (
            <Badge tone="neutral">停用</Badge>
          )}
          <Switch
            checked={job.enabled === 1}
            onChange={onToggle}
            label={`启用「${job.name}」`}
          />
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-panel-hover hover:text-fg"
            aria-label="查看发信历史"
            title="查看发信历史"
            onClick={onViewLogs}
          >
            <History className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={iconActionSuccess}
            aria-label="立即发送一次"
            title="立即发送一次"
            disabled={triggering}
            onClick={onTrigger}
          >
            {triggering ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            className={iconActionInfo}
            aria-label="编辑"
            title="编辑"
            onClick={onEdit}
          >
            <Pencil className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={iconActionDanger}
            aria-label="删除"
            title="删除"
            onClick={onRemove}
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </Card>
  );
}
