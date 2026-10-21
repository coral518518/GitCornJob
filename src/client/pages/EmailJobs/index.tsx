import { useEffect, useState } from "react";
import { del, errText, get, post, put } from "../../api";
import PageHeader from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import type { Channel, EmailJob, ResendConfig, WxPusherConfig } from "../../types";
import { Button, EmptyState, Input, Segmented, SkeletonCard, useConfirm } from "../../ui";
import { Bot, CircleAlert, Clock, Plus, Settings } from "../../ui/icons";
import { useAlive } from "../../utils/useAlive";
import { useAutoRefresh } from "../../utils/useAutoRefresh";
import ResendConfigDialog from "../../components/ResendConfigDialog";
import WxPusherConfigDialog from "../../components/WxPusherConfigDialog";
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
  const [wxPusherConfig, setWxPusherConfig] = useState<WxPusherConfig | null>(null);

  // 弹窗与抽屉状态
  const [form, setForm] = useState<EmailJobFormData | null>(null);
  const [snapshot, setSnapshot] = useState<EmailJobFormData | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingSend, setTestingSend] = useState(false);
  const [triggeringId, setTriggeringId] = useState<number | null>(null);
  const [logsJob, setLogsJob] = useState<EmailJob | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [wxPusherOpen, setWxPusherOpen] = useState(false);

  // 过滤状态
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "email" | "http" | "clawbot">("all");

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
      const [jobsData, channelsRes, configData, wxData] = await Promise.all([
        get<EmailJob[]>("/api/email-jobs"),
        get<{ channels: Channel[] }>("/api/notify/channels").catch(() => ({ channels: [] })),
        get<ResendConfig>("/api/email-jobs/config").catch(() => null),
        get<WxPusherConfig>("/api/email-jobs/wxpusher-config").catch(() => null),
      ]);
      if (!alive.current) return;
      setList(jobsData);
      setChannels(channelsRes.channels);
      setResendConfig(configData);
      setWxPusherConfig(wxData);
    } catch (e) {
      if (alive.current) toast(`加载数据失败：${errText(e)}`, "err");
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // 免费层优化：60s 周期，且弹窗打开时暂停轮询；轮询只刷新任务列表，避免重复请求配置与渠道
  useAutoRefresh(reloadJobs, 60_000, !form && !logsJob && !configOpen && !wxPusherOpen);

  function openCreate() {
    const f: EmailJobFormData = { ...EMPTY_EMAIL_FORM };
    setForm(f);
    setSnapshot(f);
  }

  function openEdit(job: EmailJob) {
    const f: EmailJobFormData = {
      id: job.id,
      name: job.name,
      task_type: job.task_type || "email",
      to_emails: job.to_emails || "",
      cc_emails: job.cc_emails || "",
      bcc_emails: job.bcc_emails || "",
      subject: job.subject || "",
      content: job.content || "",
      content_type: job.content_type || "markdown",
      schedule: parseSchedule(job.schedule_json),
      notify: job.notify,
      channelIds: job.notify_channel_ids ? JSON.parse(job.notify_channel_ids) : null,
      timezone: job.timezone || "Asia/Shanghai",
      tg_enabled: !!(job.tg_channels && job.tg_channels.trim()),
      tg_channels: job.tg_channels || "",
      tg_keywords: job.tg_keywords || "",
      http_url: job.http_url || "",
      http_method: job.http_method || "GET",
      http_headers: job.http_headers || "",
      http_body: job.http_body || "",
      wxpusher_uids: job.wxpusher_uids || "",
      tg_bot_token: job.tg_bot_token || "",
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
    const isHttp = job.task_type === "http";
    const isClawBot = job.task_type === "clawbot";
    const targetDesc = isHttp
      ? `请求「${job.http_method || "GET"} ${job.http_url}」`
      : isClawBot
      ? `拉取 TG 消息并推送微信（UID: ${job.wxpusher_uids || "默认"}）`
      : `投递至「${job.to_emails}」`;

    const ok = await confirm({
      title: isHttp ? "立即请求目标接口" : isClawBot ? "立即触发微信 ClawBot 推送" : "立即发送邮件",
      description: `确定立即执行一次「${job.name}」（${targetDesc}）吗？${
        !isHttp && !isClawBot && job.tg_channels ? "（已关联 Telegram 监控，有新消息时才发信）" : ""
      }`,
      confirmText: "立即执行",
    });
    if (!ok) return;

    setTriggeringId(job.id);
    try {
      const res = await post<{ ok: boolean; skipped?: boolean; skipReason?: string; postCount?: number }>(
        `/api/email-jobs/${job.id}/trigger`
      );
      if (res.skipped) {
        toast(`执行完成：${res.skipReason || "暂无新消息，跳过发信"}`, "ok");
      } else {
        toast(
          `「${job.name}」已成功触发执行！${typeof res.postCount === "number" ? `包含 ${res.postCount} 条新消息` : ""}`,
          "ok"
        );
      }
      await loadData();
    } catch (e) {
      toast(`执行失败：${errText(e)}`, "err");
    } finally {
      setTriggeringId(null);
    }
  }

  async function handleDelete(job: EmailJob) {
    const ok = await confirm({
      title: "删除定时任务",
      description: `确定删除定时任务「${job.name}」吗？其运行历史日志也将一并清除，此操作不可恢复。`,
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
        task_type: form.task_type,
        to_emails: form.to_emails.trim(),
        cc_emails: form.cc_emails.trim() || undefined,
        bcc_emails: form.bcc_emails.trim() || undefined,
        subject: form.subject.trim(),
        content: form.content.trim(),
        content_type: form.content_type,
        http_url: form.http_url.trim() || undefined,
        http_method: form.http_method || undefined,
        http_headers: form.http_headers.trim() || undefined,
        http_body: form.http_body || undefined,
        wxpusher_uids: form.wxpusher_uids.trim() || undefined,
        tg_bot_token: form.tg_bot_token.trim() || undefined,
        schedule: form.schedule,
        notify: form.notify,
        notify_channel_ids: form.channelIds,
        timezone: form.timezone,
        tg_channels: form.tg_enabled && form.tg_channels.trim() ? form.tg_channels.trim() : null,
        tg_keywords: form.tg_enabled && form.tg_keywords.trim() ? form.tg_keywords.trim() : null,
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

  async function handleTestSendInModal() {
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
    if (typeFilter === "email" && j.task_type !== "email") return false;
    if (typeFilter === "http" && j.task_type !== "http") return false;
    if (typeFilter === "clawbot" && j.task_type !== "clawbot") return false;

    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      j.name.toLowerCase().includes(q) ||
      (j.to_emails && j.to_emails.toLowerCase().includes(q)) ||
      (j.subject && j.subject.toLowerCase().includes(q)) ||
      (j.http_url && j.http_url.toLowerCase().includes(q)) ||
      (j.wxpusher_uids && j.wxpusher_uids.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <PageHeader
        title="定时任务"
        description="支持定时发送邮件（支持 Telegram 频道监控更新推送）与定时调用 HTTP 接口任务，支持 Cron 表达式、时区与运行历史追溯。"
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
              variant="secondary"
              onClick={() => setWxPusherOpen(true)}
              icon={<Bot className="size-4" />}
            >
              WxPusher 微信设置
            </Button>
            <Button
              variant="primary"
              onClick={openCreate}
              icon={<Plus className="size-4" />}
            >
              新建定时任务
            </Button>
          </div>
        }
      />

      {resendConfig && !resendConfig.isConfigured && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          <div className="flex items-center gap-2">
            <CircleAlert className="size-4 shrink-0" />
            <span>提示：尚未配置 Resend API Key，若需执行「邮件发送」类定时任务请先完成配置。HTTP 接口任务不受影响。</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setConfigOpen(true)}>
            前往配置
          </Button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented
            label="类型筛选"
            value={typeFilter}
            options={[
              { value: "all", label: "全部类型" },
              { value: "email", label: "邮件" },
              { value: "http", label: "HTTP 接口" },
              { value: "clawbot", label: "微信ClawBot" },
            ]}
            onChange={(v) => setTypeFilter(v as "all" | "email" | "http" | "clawbot")}
          />
          <Segmented
            label="状态筛选"
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
            placeholder="搜索任务名、URL、收件人或标题…"
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
          icon={<Clock className="size-8" />}
          title={search ? "未匹配到任何定时任务" : "暂无定时任务"}
          description={
            search
              ? "尝试更改搜索关键字或状态筛选条件"
              : "创建您的第一个定时任务，支持定时请求 HTTP 接口或定时发送邮件。"
          }
          action={
            !search && (
              <Button variant="primary" onClick={openCreate} icon={<Plus className="size-4" />}>
                新建定时任务
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
          onTestSend={handleTestSendInModal}
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

      <WxPusherConfigDialog
        open={wxPusherOpen}
        onClose={() => setWxPusherOpen(false)}
        onConfigSaved={loadData}
      />
    </div>
  );
}
