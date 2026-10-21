import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { errText, post } from "../../api";
import type { Channel, Schedule, TaskType } from "../../types";
import { CHANNEL_TYPE_LABEL } from "../../types";
import { Badge, Button, Checkbox, Field, Input, Segmented, Switch, Textarea, useConfirm } from "../../ui";
import { EMPTY_SCHEDULE, LOCAL_TZ } from "../Jobs/schedule";
import ScheduleEditor from "../Jobs/ScheduleEditor";
import {
  Sparkles,
  Send,
  Eye,
  Code,
  Globe,
  CircleCheck,
  CircleAlert,
  Mail,
  Webhook,
  X,
  Play,
  LoaderCircle,
} from "../../ui/icons";
import { cx, focusRing } from "../../ui/styles";

export type EmailJobFormData = {
  id?: number;
  name: string;
  task_type: TaskType;
  // 邮件字段
  to_emails: string;
  cc_emails: string;
  bcc_emails: string;
  subject: string;
  content: string;
  content_type: "text" | "html" | "markdown";
  tg_enabled: boolean;
  tg_channels: string;
  tg_keywords: string;
  // HTTP 接口字段
  http_url: string;
  http_method: string;
  http_headers: string;
  http_body: string;
  // 调度与告警
  schedule: Schedule;
  notify: number;
  channelIds: number[] | null;
  timezone: string;
};

export const EMPTY_EMAIL_FORM: EmailJobFormData = {
  name: "",
  task_type: "email",
  to_emails: "",
  cc_emails: "",
  bcc_emails: "",
  subject: "",
  content: "",
  content_type: "markdown",
  tg_enabled: false,
  tg_channels: "",
  tg_keywords: "",
  http_url: "",
  http_method: "GET",
  http_headers: "",
  http_body: "",
  schedule: EMPTY_SCHEDULE,
  notify: 0,
  channelIds: null,
  timezone: LOCAL_TZ,
};

type Key = "name" | "to_emails" | "subject" | "content" | "tg_channels" | "http_url";

const ALL_TOUCHED: Record<Key, boolean> = {
  name: true,
  to_emails: true,
  subject: true,
  content: true,
  tg_channels: true,
  http_url: true,
};

function validate(f: EmailJobFormData): Record<Key, string | null> {
  const nameErr = f.name.trim() ? null : "任务名不能为空";

  if (f.task_type === "http") {
    let urlErr: string | null = null;
    if (!f.http_url.trim()) {
      urlErr = "接口 URL 不能为空";
    } else if (!/^https?:\/\//i.test(f.http_url.trim())) {
      urlErr = "接口 URL 格式不正确（必须以 http:// 或 https:// 开头）";
    }
    return {
      name: nameErr,
      http_url: urlErr,
      to_emails: null,
      subject: null,
      content: null,
      tg_channels: null,
    };
  }

  // 邮件任务校验
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emails = f.to_emails
    .split(/[\r\n,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let toErr: string | null = null;
  if (emails.length === 0) {
    toErr = "收件人不能为空";
  } else if (!emails.every((e) => emailRegex.test(e))) {
    toErr = "存在格式不正确的收件人邮箱";
  }

  const tgErr = f.tg_enabled && !f.tg_channels.trim() ? "请填写要监控的 Telegram 频道" : null;

  return {
    name: nameErr,
    to_emails: toErr,
    subject: f.subject.trim() ? null : "邮件标题不能为空",
    content: f.content.trim() ? null : "邮件正文不能为空",
    tg_channels: tgErr,
    http_url: null,
  };
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-border/70 bg-surface/30 p-4">
      <h3 className="mb-3.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
      {children}
    </section>
  );
}

const TEMPLATE_VARS = [
  { label: "{{date}}", tip: "当前日期 (如 2026-10-17)" },
  { label: "{{time}}", tip: "当前时间 (如 12:45:00)" },
  { label: "{{datetime}}", tip: "当前日期与时间 (如 2026-10-17 12:45:00)" },
  { label: "{{weekday}}", tip: "星期几 (如 星期六)" },
  { label: "{{year}}", tip: "四位年份" },
  { label: "{{month}}", tip: "两位月份" },
  { label: "{{day}}", tip: "两位日" },
];

const TG_VARS = [
  { label: "{{tg_messages}}", tip: "Telegram 消息列表卡片（自动排版）" },
  { label: "{{tg_count}}", tip: "检测到的新消息数量" },
  { label: "{{tg_channels}}", tip: "当前监控的频道名列表" },
];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

type Props = {
  open: boolean;
  form: EmailJobFormData;
  channels: Channel[];
  busy: boolean;
  testingSend: boolean;
  dirty: boolean;
  onChange: (next: EmailJobFormData) => void;
  onClose: () => void;
  onSubmit: () => void;
  onTestSend: () => void;
};

export default function EmailJobForm({
  open,
  form,
  channels,
  busy,
  testingSend,
  dirty,
  onChange,
  onClose,
  onSubmit,
  onTestSend,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const confirm = useConfirm();

  const [touched, setTouched] = useState<Partial<Record<Key, boolean>>>({});
  const [schedErr, setSchedErr] = useState<string | null>(null);
  const [showMoreRecipients, setShowMoreRecipients] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  // TG 探测测试状态
  const [testingTg, setTestingTg] = useState(false);
  const [tgTestResult, setTgTestResult] = useState<{
    ok: boolean;
    msg: string;
    previews?: Array<{ channel: string; postId: number; text?: string; link: string }>;
  } | null>(null);

  // HTTP 接口在线测试状态
  const [testingHttp, setTestingHttp] = useState(false);
  const [httpTestResult, setHttpTestResult] = useState<{
    ok: boolean;
    status: number;
    statusText: string;
    latencyMs: number;
    headers: Record<string, string>;
    bodyPreview: string;
    error?: string;
  } | null>(null);

  const attemptClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: "放弃未保存的改动？",
      description: "关闭后本次填写的内容不会保存。",
      confirmText: "放弃",
      tone: "danger",
    });
    if (ok) onClose();
  }, [dirty, onClose, confirm]);

  // 控制原生 dialog 弹出
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    }
    if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // 拦截浏览器 Esc 键，做二次确认
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      void attemptClose();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [attemptClose]);

  useLayoutEffect(() => () => {
    const el = dialogRef.current;
    if (el?.open) el.close();
  }, []);

  async function handleTestTg() {
    if (!form.tg_channels.trim()) return;
    setTestingTg(true);
    setTgTestResult(null);
    try {
      const res = await post<{
        channels: string[];
        totalPosts: number;
        results: Array<{
          channel: string;
          latestId: number;
          posts: Array<{ channel: string; postId: number; text?: string; link: string }>;
          error?: string;
        }>;
      }>("/api/email-jobs/test-tg", {
        channels: form.tg_channels,
        keywords: form.tg_keywords || undefined,
      });

      const errCount = res.results.filter((r) => r.error).length;
      const allPosts = res.results.flatMap((r) => r.posts);

      if (errCount === res.results.length) {
        setTgTestResult({
          ok: false,
          msg: `探测失败：${res.results.map((r) => `@${r.channel}: ${r.error}`).join("; ")}`,
        });
      } else {
        setTgTestResult({
          ok: true,
          msg: `成功探测 ${res.channels.length} 个频道，抓取到 ${res.totalPosts} 条可用消息${
            form.tg_keywords ? "（已应用关键词过滤）" : ""
          }`,
          previews: allPosts.slice(0, 5),
        });
      }
    } catch (e) {
      setTgTestResult({
        ok: false,
        msg: `探测异常：${errText(e)}`,
      });
    } finally {
      setTestingTg(false);
    }
  }

  async function handleTestHttp() {
    if (!form.http_url.trim()) return;
    setTestingHttp(true);
    setHttpTestResult(null);
    try {
      const res = await post<{
        ok: boolean;
        status: number;
        statusText: string;
        latencyMs: number;
        headers: Record<string, string>;
        bodyPreview: string;
        error?: string;
      }>("/api/email-jobs/test-http", {
        url: form.http_url,
        method: form.http_method,
        headers: form.http_headers,
        body: form.http_body,
      });
      setHttpTestResult(res);
    } catch (e) {
      setHttpTestResult({
        ok: false,
        status: 0,
        statusText: "Error",
        latencyMs: 0,
        headers: {},
        bodyPreview: "",
        error: errText(e),
      });
    } finally {
      setTestingHttp(false);
    }
  }

  const errors = validate(form);
  const blocked = Object.values(errors).some(Boolean) || !!schedErr;
  const set = (patch: Partial<EmailJobFormData>) => onChange({ ...form, ...patch });
  const touch = (k: Key) => () => setTouched((t) => ({ ...t, [k]: true }));
  const err = (k: Key) => (touched[k] ? errors[k] : null);

  const notifyError =
    form.notify === 1 &&
    channels.length > 0 &&
    form.channelIds !== null &&
    form.channelIds.length === 0
      ? "请至少勾选一个渠道，或勾选「全部渠道」"
      : null;

  function insertVarToSubject(tag: string) {
    set({ subject: form.subject ? `${form.subject} ${tag}` : tag });
  }

  function insertVarToContent(tag: string) {
    set({ content: form.content ? `${form.content} ${tag}` : tag });
  }

  function insertVarToHttpBody(tag: string) {
    set({ http_body: form.http_body ? `${form.http_body} ${tag}` : tag });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(ALL_TOUCHED);
    if (blocked || notifyError) return;
    onSubmit();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // 绝不点击空白处关闭：点击遮罩 backdrop 绝不调用 onClose
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          e.stopPropagation();
        }
      }}
      className={cx(
        "m-auto w-full max-w-4xl max-h-[92vh] rounded-2xl border border-border bg-panel p-0 text-fg shadow-2xl",
        "backdrop:bg-black/60 backdrop:backdrop-blur-xs open:flex open:flex-col overflow-hidden",
        "open:animate-in-pop"
      )}
    >
      {/* 头部：标题与固定关闭按钮 */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-panel px-6 py-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-fg">
            {form.id ? "编辑定时任务" : "新建定时任务"}
          </h2>
          <p className="mt-0.5 text-xs text-fg-subtle">
            配置定时执行策略，二选一支持发送邮件或调用 HTTP 接口
          </p>
        </div>
        <button
          type="button"
          onClick={() => void attemptClose()}
          aria-label="关闭"
          className={cx(
            "-m-1 rounded-lg p-1.5 text-fg-subtle transition-colors duration-fast hover:bg-panel-hover hover:text-fg",
            focusRing
          )}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* 中部可滚动表单区域 */}
      <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* 基本信息 */}
          <Group title="基本信息">
            <Field label="任务名称" error={err("name")}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={!!err("name")}
                  placeholder="例如：每日打卡提醒 / 数据同步 Webhook / TG 频道更新监控"
                  value={form.name}
                  onBlur={touch("name")}
                  onChange={(e) => set({ name: e.target.value })}
                />
              )}
            </Field>
          </Group>

          {/* 执行方式：二选一必选其一 */}
          <Group title="执行方式（必选且只能选一种）">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* 选项 1：发送邮件 */}
              <button
                type="button"
                onClick={() => set({ task_type: "email" })}
                className={cx(
                  "relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-fast",
                  form.task_type === "email"
                    ? "border-primary bg-primary/8 text-fg shadow-xs ring-2 ring-primary/25"
                    : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg"
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={cx(
                        "flex size-7 items-center justify-center rounded-lg",
                        form.task_type === "email"
                          ? "bg-primary text-white"
                          : "bg-panel text-fg-muted"
                      )}
                    >
                      <Mail className="size-4" />
                    </div>
                    <span className="font-semibold text-sm text-fg">发送邮件</span>
                  </div>
                  <input
                    type="radio"
                    name="task_type"
                    checked={form.task_type === "email"}
                    onChange={() => set({ task_type: "email" })}
                    className="size-4 text-primary accent-primary"
                  />
                </div>
                <p className="mt-2 text-xs text-fg-subtle leading-relaxed">
                  定时发送电子邮件，支持 Markdown/HTML 模板渲染及 Telegram 频道更新联动。
                </p>
              </button>

              {/* 选项 2：定时执行接口 */}
              <button
                type="button"
                onClick={() => set({ task_type: "http" })}
                className={cx(
                  "relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-fast",
                  form.task_type === "http"
                    ? "border-primary bg-primary/8 text-fg shadow-xs ring-2 ring-primary/25"
                    : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg"
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={cx(
                        "flex size-7 items-center justify-center rounded-lg",
                        form.task_type === "http"
                          ? "bg-primary text-white"
                          : "bg-panel text-fg-muted"
                      )}
                    >
                      <Globe className="size-4" />
                    </div>
                    <span className="font-semibold text-sm text-fg">定时执行接口 (HTTP)</span>
                  </div>
                  <input
                    type="radio"
                    name="task_type"
                    checked={form.task_type === "http"}
                    onChange={() => set({ task_type: "http" })}
                    className="size-4 text-primary accent-primary"
                  />
                </div>
                <p className="mt-2 text-xs text-fg-subtle leading-relaxed">
                  定时向目标服务器或 Webhook 发起 HTTP 请求，支持配置 Method、Headers 与 Body。
                </p>
              </button>
            </div>
          </Group>

          {/* 当选择「定时执行接口」时展示的配置项 */}
          {form.task_type === "http" && (
            <Group title="接口请求参数配置">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-1">
                    <Field label="请求方式 (Method)">
                      {({ id }) => (
                        <select
                          id={id}
                          value={form.http_method || "GET"}
                          onChange={(e) => set({ http_method: e.target.value })}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-fg focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          {HTTP_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field
                      label="接口地址 (URL)"
                      hint="支持动态时间变量，如 https://api.example.com/sync?date={{date}}"
                      error={err("http_url")}
                    >
                      {({ id, describedBy }) => (
                        <Input
                          id={id}
                          aria-describedby={describedBy}
                          invalid={!!err("http_url")}
                          placeholder="https://api.example.com/v1/cron-webhook"
                          value={form.http_url}
                          onBlur={touch("http_url")}
                          onChange={(e) => set({ http_url: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                </div>

                <Field
                  label="请求头 (Headers - 可选)"
                  hint="支持换行「Header-Name: Value」或 JSON 格式；支持 {{datetime}} 动态插值"
                >
                  {({ id }) => (
                    <Textarea
                      id={id}
                      rows={3}
                      className="font-mono text-xs"
                      placeholder={
                        "Content-Type: application/json\nAuthorization: Bearer my-secret-token\nX-Timestamp: {{datetime}}"
                      }
                      value={form.http_headers}
                      onChange={(e) => set({ http_headers: e.target.value })}
                    />
                  )}
                </Field>

                {form.http_method !== "GET" && form.http_method !== "HEAD" && (
                  <Field
                    label="请求体 (Body - 可选)"
                    hint="支持纯文本或 JSON 内容，调度触发时将自动替换动态占位符"
                  >
                    {({ id }) => (
                      <>
                        <Textarea
                          id={id}
                          rows={5}
                          className="font-mono text-xs leading-relaxed"
                          placeholder={
                            '{\n  "action": "daily_sync",\n  "date": "{{date}}",\n  "time": "{{time}}"\n}'
                          }
                          value={form.http_body}
                          onChange={(e) => set({ http_body: e.target.value })}
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                          <span className="inline-flex items-center gap-1 font-medium">
                            <Sparkles className="size-3 text-warn" /> 插入动态变量：
                          </span>
                          {TEMPLATE_VARS.map((v) => (
                            <button
                              key={v.label}
                              type="button"
                              title={v.tip}
                              onClick={() => insertVarToHttpBody(v.label)}
                              className="rounded bg-panel px-1.5 py-0.5 text-xs font-mono text-fg-muted transition-colors hover:bg-panel-hover hover:text-fg"
                            >
                              {v.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </Field>
                )}

                {/* 接口测试结果提示 */}
                {httpTestResult && (
                  <div
                    className={cx(
                      "rounded-lg border p-3 text-xs",
                      httpTestResult.ok
                        ? "border-success/30 bg-success/5 text-fg"
                        : "border-danger/30 bg-danger/5 text-fg"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 font-semibold">
                      <div className="flex items-center gap-1.5">
                        {httpTestResult.ok ? (
                          <CircleCheck className="size-4 text-success shrink-0" />
                        ) : (
                          <CircleAlert className="size-4 text-danger shrink-0" />
                        )}
                        <span className={httpTestResult.ok ? "text-success" : "text-danger"}>
                          {httpTestResult.ok
                            ? `请求成功 (HTTP ${httpTestResult.status} ${httpTestResult.statusText})`
                            : `请求失败 (${httpTestResult.error || `HTTP ${httpTestResult.status}`})`}
                        </span>
                      </div>
                      <span className="font-mono text-fg-subtle tabular-nums">
                        耗时：{httpTestResult.latencyMs}ms
                      </span>
                    </div>
                    {httpTestResult.bodyPreview && (
                      <div className="mt-2 max-h-32 overflow-y-auto rounded bg-panel/70 p-2 font-mono text-[11px] text-fg-muted">
                        <span className="text-fg-subtle block mb-1">响应内容预览 (前 500 字符)：</span>
                        <pre className="whitespace-pre-wrap">{httpTestResult.bodyPreview}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Group>
          )}

          {/* 当选择「发送邮件」时展示的配置项 */}
          {form.task_type === "email" && (
            <>
              <Group title="收发件人设置">
                <Field
                  label="收件人 (To)"
                  hint="多个收件人可用英文逗号、分号或换行分隔"
                  error={err("to_emails")}
                >
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      invalid={!!err("to_emails")}
                      rows={2}
                      placeholder="alice@example.com, bob@example.com"
                      value={form.to_emails}
                      onBlur={touch("to_emails")}
                      onChange={(e) => set({ to_emails: e.target.value })}
                    />
                  )}
                </Field>

                <div className="mb-3">
                  <button
                    type="button"
                    onClick={() => setShowMoreRecipients(!showMoreRecipients)}
                    className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    {showMoreRecipients ? "收起抄送/密送" : "+ 添加抄送 (CC) / 密送 (BCC)"}
                  </button>
                </div>

                {showMoreRecipients && (
                  <div className="mb-4 space-y-3 rounded-lg border border-border bg-surface p-3">
                    <Field label="抄送 (CC)" hint="选填，多个邮箱用逗号或换行分隔">
                      {({ id }) => (
                        <Input
                          id={id}
                          placeholder="cc1@example.com, cc2@example.com"
                          value={form.cc_emails}
                          onChange={(e) => set({ cc_emails: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="密送 (BCC)" hint="选填，多个邮箱用逗号或换行分隔">
                      {({ id }) => (
                        <Input
                          id={id}
                          placeholder="bcc@example.com"
                          value={form.bcc_emails}
                          onChange={(e) => set({ bcc_emails: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                )}
              </Group>

              <Group title="关联 Telegram 频道监控 (可选)">
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
                    <div>
                      <div className="text-sm font-medium text-fg">关联 Telegram 频道监控</div>
                      <div className="text-xs text-fg-subtle">
                        满足条件才发信：调度器运行时若检测到新消息才发信，无新消息则自动跳过
                      </div>
                    </div>
                    <Switch
                      checked={form.tg_enabled}
                      label="关联 Telegram 频道监控"
                      onChange={(v) => {
                        const patch: Partial<EmailJobFormData> = { tg_enabled: v };
                        if (v && !form.subject.trim()) {
                          patch.subject = "【频道更新】{{tg_channels}} 有 {{tg_count}} 条新消息";
                        }
                        if (v && !form.content.trim()) {
                          patch.content = "{{tg_messages}}";
                        }
                        set(patch);
                      }}
                    />
                  </div>

                  {form.tg_enabled && (
                    <div className="space-y-3 rounded-lg border border-border bg-surface p-3.5">
                      <Field
                        label="监控频道列表 (Channels)"
                        hint="支持多个频道（每行一个或逗号分隔）。例如：durov、@telegram 或 https://t.me/example"
                        error={err("tg_channels")}
                      >
                        {({ id }) => (
                          <Textarea
                            id={id}
                            rows={2}
                            placeholder="durov, @telegram&#10;https://t.me/example_channel"
                            value={form.tg_channels}
                            onBlur={touch("tg_channels")}
                            onChange={(e) => set({ tg_channels: e.target.value })}
                          />
                        )}
                      </Field>

                      <Field
                        label="关键词过滤 (Keywords - 可选)"
                        hint="选填。多个关键词以逗号或换行分隔；仅抓取包含任一关键词的消息，留空则不过滤"
                      >
                        {({ id }) => (
                          <Input
                            id={id}
                            placeholder="优惠, 折扣, 抽奖, giveaway"
                            value={form.tg_keywords}
                            onChange={(e) => set({ tg_keywords: e.target.value })}
                          />
                        )}
                      </Field>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5">
                        <span className="text-xs text-fg-subtle">
                          时间窗口机制：检索频道过去 1 小时内发布的新消息，初次启动绝不拉取远古旧历史；无新消息则安全跳过。
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          loading={testingTg}
                          disabled={!form.tg_channels.trim()}
                          onClick={() => void handleTestTg()}
                        >
                          测试探测频道
                        </Button>
                      </div>

                      {tgTestResult && (
                        <div
                          className={`rounded-md border p-2.5 text-xs ${
                            tgTestResult.ok
                              ? "border-success/30 bg-success/5 text-success"
                              : "border-danger/30 bg-danger/5 text-danger"
                          }`}
                        >
                          <div className="font-semibold mb-1 flex items-center gap-1.5">
                            {tgTestResult.ok ? (
                              <CircleCheck className="size-3.5 shrink-0" />
                            ) : (
                              <CircleAlert className="size-3.5 shrink-0" />
                            )}
                            <span>{tgTestResult.msg}</span>
                          </div>
                          {tgTestResult.previews && tgTestResult.previews.length > 0 && (
                            <div className="mt-1.5 space-y-1 max-h-36 overflow-y-auto">
                              {tgTestResult.previews.map((p, idx) => (
                                <div
                                  key={idx}
                                  className="rounded border border-border bg-surface px-2 py-1 text-[11px] text-fg"
                                >
                                  <span className="font-semibold text-primary">@{p.channel}</span> #{p.postId}:{" "}
                                  <span className="text-fg-muted">
                                    {p.text ? (p.text.length > 60 ? `${p.text.slice(0, 60)}…` : p.text) : p.link}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Group>

              <Group title="邮件内容">
                <Field label="邮件标题 (Subject)" error={err("subject")}>
                  {({ id, describedBy }) => (
                    <>
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        invalid={!!err("subject")}
                        placeholder="例如：【日常提醒】今天是 {{date}} {{weekday}}"
                        value={form.subject}
                        onBlur={touch("subject")}
                        onChange={(e) => set({ subject: e.target.value })}
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Sparkles className="size-3 text-warn" /> 插入动态变量：
                        </span>
                        {TEMPLATE_VARS.slice(0, 4).map((v) => (
                          <button
                            key={v.label}
                            type="button"
                            title={v.tip}
                            onClick={() => insertVarToSubject(v.label)}
                            className="rounded bg-panel px-1.5 py-0.5 text-xs font-mono text-fg-muted transition-colors hover:bg-panel-hover hover:text-fg"
                          >
                            {v.label}
                          </button>
                        ))}
                        {form.tg_enabled && (
                          <>
                            <span className="text-border">|</span>
                            <span className="inline-flex items-center gap-1 font-medium text-primary">
                              <Globe className="size-3" /> TG变量：
                            </span>
                            {TG_VARS.slice(1).map((v) => (
                              <button
                                key={v.label}
                                type="button"
                                title={v.tip}
                                onClick={() => insertVarToSubject(v.label)}
                                className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary transition-colors hover:bg-primary/20"
                              >
                                {v.label}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </Field>

                <div className="mb-3 flex items-center justify-between">
                  <Segmented
                    label="正文格式"
                    value={form.content_type}
                    options={[
                      { value: "markdown", label: "Markdown" },
                      { value: "html", label: "HTML" },
                      { value: "text", label: "纯文本" },
                    ]}
                    onChange={(ct) => set({ content_type: ct as "text" | "html" | "markdown" })}
                  />
                  {form.content_type !== "text" && (
                    <button
                      type="button"
                      onClick={() => setPreviewMode(!previewMode)}
                      className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
                    >
                      {previewMode ? (
                        <>
                          <Code className="size-3.5" /> 切换代码编辑
                        </>
                      ) : (
                        <>
                          <Eye className="size-3.5" /> 快速预览
                        </>
                      )}
                    </button>
                  )}
                </div>

                <Field label="邮件正文" error={err("content")}>
                  {({ id, describedBy }) => (
                    <>
                      {previewMode && form.content_type !== "text" ? (
                        <div className="min-h-[160px] max-h-[320px] overflow-y-auto rounded-lg border border-border bg-surface p-3 text-sm text-fg">
                          {form.content_type === "html" ? (
                            <div
                              dangerouslySetInnerHTML={{
                                __html: form.content || "<p class='text-fg-subtle text-xs'>（空内容）</p>",
                              }}
                            />
                          ) : (
                            <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                              <pre className="whitespace-pre-wrap font-sans">
                                {form.content || "（空内容）"}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <Textarea
                          id={id}
                          aria-describedby={describedBy}
                          invalid={!!err("content")}
                          rows={8}
                          className="font-mono text-xs leading-relaxed"
                          placeholder={
                            form.tg_enabled
                              ? "在正文中插入 {{tg_messages}} 占位符，发信时将自动替换为新消息卡片列表。\n若未填写 {{tg_messages}}，系统将默认在文末附加新消息列表。"
                              : form.content_type === "markdown"
                              ? "支持 Markdown 语法与动态插值变量：\n# 每日打卡\n今天是 **{{datetime}}**，请按时完成任务！"
                              : form.content_type === "html"
                              ? "<h3>您好！</h3><p>系统于 {{datetime}} 自动生成本邮件。</p>"
                              : "您好，这是一封定时提醒邮件。\n发送时间：{{datetime}}"
                          }
                          value={form.content}
                          onBlur={touch("content")}
                          onChange={(e) => set({ content: e.target.value })}
                        />
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Sparkles className="size-3 text-warn" /> 常用占位符：
                        </span>
                        {TEMPLATE_VARS.map((v) => (
                          <button
                            key={v.label}
                            type="button"
                            title={v.tip}
                            onClick={() => insertVarToContent(v.label)}
                            className="rounded bg-panel px-1.5 py-0.5 text-xs font-mono text-fg-muted transition-colors hover:bg-panel-hover hover:text-fg"
                          >
                            {v.label}
                          </button>
                        ))}
                        {form.tg_enabled && (
                          <>
                            <span className="text-border">|</span>
                            <span className="inline-flex items-center gap-1 font-medium text-primary">
                              <Globe className="size-3" /> TG变量：
                            </span>
                            {TG_VARS.map((v) => (
                              <button
                                key={v.label}
                                type="button"
                                title={v.tip}
                                onClick={() => insertVarToContent(v.label)}
                                className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary transition-colors hover:bg-primary/20"
                              >
                                {v.label}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </Field>
              </Group>
            </>
          )}

          {/* 调度规则 */}
          <Group title="调度规则">
            <ScheduleEditor
              value={form.schedule}
              timezone={form.timezone}
              onTimezoneChange={(tz) => set({ timezone: tz })}
              onError={setSchedErr}
              onChange={(schedule) => set({ schedule })}
            />
          </Group>

          {/* 失败告警设置 */}
          <Group title="告警与异常通知">
            <div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
                <div>
                  <span className="text-sm font-medium text-fg">失败通知 (Webhook 告警)</span>
                  <div className="text-xs text-fg-subtle">
                    任务执行失败或连续达到停用阈值时，自动向已配置的渠道推送告警消息
                  </div>
                </div>
                <Switch
                  checked={form.notify === 1}
                  label="失败通知"
                  onChange={(v) => set({ notify: v ? 1 : 0 })}
                />
              </div>
              {form.notify === 1 &&
                (channels.length > 0 ? (
                  <div className="mt-2 space-y-2 rounded-lg border border-border px-3 py-2.5">
                    <Checkbox
                      checked={form.channelIds === null}
                      onChange={(on) =>
                        set({ channelIds: on ? null : channels.map((ch) => ch.id) })
                      }
                    >
                      全部渠道
                    </Checkbox>
                    {form.channelIds !== null && (
                      <div className="space-y-2 border-t border-border/60 pt-2">
                        {channels.map((ch) => (
                          <Checkbox
                            key={ch.id}
                            checked={form.channelIds!.includes(ch.id)}
                            onChange={(on) =>
                              set({
                                channelIds: on
                                  ? [...form.channelIds!, ch.id]
                                  : form.channelIds!.filter((id) => id !== ch.id),
                              })
                            }
                          >
                            <span className="inline-flex max-w-full items-center gap-2">
                              <span className="truncate">{ch.name}</span>
                              <Badge>{CHANNEL_TYPE_LABEL[ch.type]}</Badge>
                            </span>
                          </Checkbox>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-fg-subtle">
                    暂未添加通知渠道。在「账户 → 通知设置」添加飞书/企业微信/Telegram/Bark等后即可选择推送目标。
                  </p>
                ))}
              {notifyError && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {notifyError}
                </p>
              )}
            </div>
          </Group>
        </div>

        {/* 底部固定操作栏 */}
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-panel px-6 py-3.5">
          <div>
            {form.task_type === "http" ? (
              <Button
                type="button"
                variant="secondary"
                loading={testingHttp}
                disabled={!form.http_url.trim()}
                onClick={() => void handleTestHttp()}
                icon={<Play className="size-3.5" />}
              >
                测试请求接口
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                loading={testingSend}
                disabled={!form.to_emails.trim() || !form.subject.trim()}
                onClick={onTestSend}
                icon={<Send className="size-3.5" />}
              >
                试发一次邮件
              </Button>
            )}
          </div>

          <div className="flex gap-2.5">
            <Button type="button" variant="secondary" onClick={() => void attemptClose()}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              保存任务
            </Button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
