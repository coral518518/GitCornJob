import { useEffect, useState } from "react";
import { del, errText, get, post, put } from "../../api";
import PageHeader from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import type { Channel, EmailJob, ResendConfig } from "../../types";
import { Button, EmptyState, Input, Segmented, SkeletonCard, useConfirm } from "../../ui";
import { CircleAlert, Inbox, Mail, Plus, Settings } from "../../ui/icons";
import { useAlive } from "../../utils/useAlive";
import { useAutoRefresh } from "../../utils/useAutoRefresh";
import ResendConfigDialog from "../../components/ResendConfigDialog";
import EmailJobCard from "./EmailJobCard";
import EmailJobForm, { EMPTY_EMAIL_FORM, type EmailJobFormData } from "./EmailJobForm";
import EmailLogsDialog from "./EmailLogsDialog";
import { parseSchedule } from "../Jobs/schedule";

export default function EmailJobs() {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<EmailJob[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [resendConfig, setResendConfig] = useState<ResendConfig | null>(null);

  // 弹窗与抽屉状态
  const [form, setForm] = useState<EmailJobFormData | null>(null);
  const [snapshot, setSnapshot] = useState<EmailJobFormData | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingSend, setTestingSend] = useState(false);
  const [triggeringId, setTriggeringId] = useState<number | null>(null);
  const [logsJob, setLogsJob] = useState<EmailJob | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  // 过滤状态
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");

  const alive = useAlive();

  async function reloadJobs() {
    try {
      const jobsData = await get<EmailJob[]>("/api/email-jobs");
      if (alive.current) setList(jobsData);
    } catch {
      /* 忽略轮询静默失败 */
    }
  }

  async function loadData() {
    try {
      const [jobsData, channelsData, configData] = await Promise.all([
        get<EmailJob[]>("/api/email-jobs"),
        get<Channel[]>("/api/notify").catch(() => []),
        get<ResendConfig>("/api/email-jobs/config").catch(() => null),
      ]);
      if (!alive.current) return;
      setList(jobsData);
      setChannels(channelsData);
      setResendConfig(configData);
    } catch (e) {
      if (alive.current) toast(`加载数据失败：${errText(e)}`, "err");
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // 免费层优化：60s 周期，且抽屉/弹窗打开时暂停轮询；轮询只刷新任务列表，避免重复请求配置与渠道
  useAutoRefresh(reloadJobs, 60_000, !form && !logsJob && !configOpen);

  function openCreate() {
    const f: EmailJobFormData = { ...EMPTY_EMAIL_FORM };
    setForm(f);
    setSnapshot(f);
  }

  function openEdit(job: EmailJob) {
    const f: EmailJobFormData = {
      id: job.id,
      name: job.name,
      to_emails: job.to_emails,
      cc_emails: job.cc_emails || "",
      bcc_emails: job.bcc_emails || "",
      subject: job.subject,
      content: job.content,
      content_type: job.content_type,
      schedule: parseSchedule(job.schedule_json),
      notify: job.notify,
      channelIds: job.notify_channel_ids ? JSON.parse(job.notify_channel_ids) : null,
      timezone: job.timezone || "Asia/Shanghai",
    };
    setForm(f);
    setSnapshot(f);
  }

  async function handleToggle(job: EmailJob) {
    try {
      const res = await post<{ enabled: number; next_run_at: number }>(
        `/api/email-jobs/${job.id}/toggle`
      );
      setList((prev) =>
        prev
          ? prev.map((j) =>
              j.id === job.id
                ? { ...j, enabled: res.enabled, next_run_at: res.next_run_at, fail_streak: 0 }
                : j
            )
          : null
      );
      toast(res.enabled === 1 ? `已启用「${job.name}」` : `已停用「${job.name}」`, "ok");
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  async function handleTrigger(job: EmailJob) {
    const ok = await confirm({
      title: "立即发送邮件",
      description: `确定立即向「${job.to_emails}」发送一次「${job.name}」吗？`,
      confirmText: "立即发送",
    });
    if (!ok) return;

    setTriggeringId(job.id);
    try {
      await post(`/api/email-jobs/${job.id}/trigger`);
      toast(`「${job.name}」已成功触发发送！`, "ok");
      await loadData();
    } catch (e) {
      toast(`发送失败：${errText(e)}`, "err");
    } finally {
      setTriggeringId(null);
    }
  }

  async function handleDelete(job: EmailJob) {
    const ok = await confirm({
      title: "删除邮件任务",
      description: `确定删除定时邮件「${job.name}」吗？其发信日志也将一并清除，此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;

    try {
      await del(`/api/email-jobs/${job.id}`);
      setList((prev) => (prev ? prev.filter((j) => j.id !== job.id) : null));
      toast(`已删除「${job.name}」`, "ok");
    } catch (e) {
      toast(`删除失败：${errText(e)}`, "err");
    }
  }

  async function handleFormSubmit() {
    if (!form) return;
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        to_emails: form.to_emails.trim(),
        cc_emails: form.cc_emails.trim() || undefined,
        bcc_emails: form.bcc_emails.trim() || undefined,
        subject: form.subject.trim(),
        content: form.content.trim(),
        content_type: form.content_type,
        schedule: form.schedule,
        notify: form.notify,
        notify_channel_ids: form.channelIds,
        timezone: form.timezone,
      };

      if (form.id) {
        await put(`/api/email-jobs/${form.id}`, payload);
        toast(`「${form.name}」已更新`, "ok");
      } else {
        await post("/api/email-jobs", payload);
        toast(`「${form.name}」已创建`, "ok");
      }
      setForm(null);
      await loadData();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function handleTestSendInDrawer() {
    if (!form) return;
    setTestingSend(true);
    try {
      const res = await post<{ resendId?: string; latencyMs: number }>("/api/email-jobs/test", {
        to: form.to_emails,
        subject: form.subject,
        content: form.content,
        contentType: form.content_type,
      });
      toast(`试发成功！耗时 ${res.latencyMs}ms (ID: ${res.resendId || "ok"})`, "ok");
    } catch (e) {
      toast(`试发失败：${errText(e)}`, "err");
    } finally {
      setTestingSend(false);
    }
  }

  const isDirty = form !== null && snapshot !== null && JSON.stringify(form) !== JSON.stringify(snapshot);

  const filtered = (list ?? []).filter((j) => {
    if (statusFilter === "enabled" && j.enabled !== 1) return false;
    if (statusFilter === "disabled" && j.enabled === 1) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      j.name.toLowerCase().includes(q) ||
      j.to_emails.toLowerCase().includes(q) ||
      j.subject.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <PageHeader
        title="定时邮件"
        description="基于 Resend 发信服务的定时邮件派发任务，支持 Cron 与间隔规则、动态模板插值与发送历史追溯。"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfigOpen(true)}
              icon={<Settings className="size-4" />}
            >
              Resend 邮件设置
            </Button>
            <Button
              variant="primary"
              onClick={openCreate}
              icon={<Plus className="size-4" />}
            >
              新建邮件任务
            </Button>
          </div>
        }
      />

      {resendConfig && !resendConfig.isConfigured && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          <div className="flex items-center gap-2">
            <CircleAlert className="size-4 shrink-0" />
            <span>尚未配置 Resend API Key，发信任务将无法执行。请先完成邮件服务配置。</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setConfigOpen(true)}>
            前往配置
          </Button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Segmented
            label="状态过滤"
            value={statusFilter}
            options={[
              { value: "all", label: `全部 (${list?.length ?? 0})` },
              { value: "enabled", label: `启用中 (${list?.filter((j) => j.enabled === 1).length ?? 0})` },
              { value: "disabled", label: `已停用 (${list?.filter((j) => j.enabled !== 1).length ?? 0})` },
            ]}
            onChange={(v) => setStatusFilter(v as "all" | "enabled" | "disabled")}
          />
        </div>
        <div className="w-full sm:w-64">
          <Input
            placeholder="搜索任务名、收件人或主题…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {list === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Mail className="size-8" />}
          title={search ? "未匹配到任何邮件任务" : "暂无定时邮件任务"}
          description={
            search
              ? "尝试更改搜索关键字或状态筛选条件"
              : "创建您的第一个定时邮件任务，定时向指定邮箱发送提醒、报表或通知。"
          }
          action={
            !search && (
              <Button variant="primary" onClick={openCreate} icon={<Plus className="size-4" />}>
                新建邮件任务
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((job) => (
            <EmailJobCard
              key={job.id}
              job={job}
              triggering={triggeringId === job.id}
              onToggle={() => handleToggle(job)}
              onTrigger={() => handleTrigger(job)}
              onEdit={() => openEdit(job)}
              onRemove={() => handleDelete(job)}
              onViewLogs={() => setLogsJob(job)}
            />
          ))}
        </div>
      )}

      {form && (
        <EmailJobForm
          open={form !== null}
          form={form}
          channels={channels}
          busy={busy}
          testingSend={testingSend}
          dirty={isDirty}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSubmit={handleFormSubmit}
          onTestSend={handleTestSendInDrawer}
        />
      )}

      {logsJob && (
        <EmailLogsDialog
          open={logsJob !== null}
          job={logsJob}
          onClose={() => setLogsJob(null)}
        />
      )}

      <ResendConfigDialog
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onConfigSaved={loadData}
      />
    </div>
  );
}
