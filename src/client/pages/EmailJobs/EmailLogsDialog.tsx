import { useEffect, useState } from "react";
import { errText, get } from "../../api";
import type { EmailJob, EmailLog } from "../../types";
import { Badge, Button, Dialog, Skeleton } from "../../ui";
import { CircleCheck, CircleX, RefreshCw, Clock } from "../../ui/icons";
import { fmtShort, relativeTime } from "../../utils/time";

type Props = {
  open: boolean;
  job: EmailJob | null;
  onClose: () => void;
};

export default function EmailLogsDialog({ open, job, onClose }: Props) {
  const [logs, setLogs] = useState<EmailLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  function loadLogs() {
    if (!job) return;
    setLoading(true);
    setErr("");
    get<{ rows: EmailLog[]; total: number }>(`/api/email-jobs/${job.id}/logs?page=1&page_size=30`)
      .then((d) => setLogs(d.rows))
      .catch((e) => setErr(errText(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (open && job) {
      loadLogs();
    } else {
      setLogs(null);
    }
  }, [open, job]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={job ? `「${job.name}」发信历史记录` : "发信历史记录"}
      width="max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={loadLogs}
            icon={<RefreshCw className="size-3.5" />}
          >
            刷新
          </Button>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      {err ? (
        <div className="py-6 text-center text-sm text-danger">{err}</div>
      ) : loading && logs === null ? (
        <div className="space-y-3 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      ) : logs === null || logs.length === 0 ? (
        <div className="py-12 text-center">
          <Clock className="mx-auto size-8 text-fg-subtle" />
          <p className="mt-2 text-sm text-fg-muted">暂无发信记录</p>
          <p className="mt-1 text-xs text-fg-subtle">
            任务执行或手动试发后，发信日志将记录在此处。
          </p>
        </div>
      ) : (
        <div className="max-h-[60vh] divide-y divide-border/60 overflow-y-auto pr-1">
          {logs.map((log) => {
            const isSuccess = log.status === "success";
            return (
              <div
                key={log.id}
                className="flex flex-col gap-1.5 py-3 text-xs transition-colors hover:bg-surface/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {isSuccess ? (
                      <CircleCheck className="size-4 text-success" />
                    ) : (
                      <CircleX className="size-4 text-danger" />
                    )}
                    <span className="font-medium text-fg">
                      {isSuccess ? "发送成功" : "发送失败"}
                    </span>
                    <Badge tone="neutral">
                      {log.source === "manual" ? "手动触发" : "定时调度"}
                    </Badge>
                    {log.latency_ms !== null && log.latency_ms > 0 && (
                      <span className="text-fg-subtle tabular-nums">{log.latency_ms}ms</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-fg-subtle">
                    <span>{fmtShort(log.triggered_at)}</span>
                    <span>({relativeTime(log.triggered_at)})</span>
                  </div>
                </div>

                <div className="flex flex-col gap-0.5 pl-6 text-fg-muted">
                  <div>
                    <span className="text-fg-subtle">收件人：</span>
                    <span className="font-mono text-fg">{log.to_emails}</span>
                  </div>
                  <div>
                    <span className="text-fg-subtle">标题：</span>
                    <span>{log.subject}</span>
                  </div>
                  {log.resend_id && (
                    <div className="text-fg-subtle">
                      <span>Resend ID：</span>
                      <span className="font-mono">{log.resend_id}</span>
                    </div>
                  )}
                  {log.error_message && (
                    <div className="rounded bg-danger/10 p-1.5 text-danger">
                      <span>错误：{log.error_message}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
