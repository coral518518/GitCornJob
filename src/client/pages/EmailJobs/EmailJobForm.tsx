import { useState, type ReactNode } from "react";
import { errText, post } from "../../api";
import type { Channel, Schedule } from "../../types";
import { CHANNEL_TYPE_LABEL } from "../../types";
import { Badge, Button, Checkbox, Drawer, Field, Input, Segmented, Switch, Textarea } from "../../ui";
import { EMPTY_SCHEDULE, LOCAL_TZ } from "../Jobs/schedule";
import ScheduleEditor from "../Jobs/ScheduleEditor";
import { Sparkles, Send, Eye, Code, Globe, CircleCheck, CircleAlert } from "../../ui/icons";

export type EmailJobFormData = {
  id?: number;
  name: string;
  to_emails: string;
  cc_emails: string;
  bcc_emails: string;
  subject: string;
  content: string;
  content_type: "text" | "html" | "markdown";
  schedule: Schedule;
  notify: number;
  channelIds: number[] | null;
  timezone: string;
  tg_enabled: boolean;
  tg_channels: string;
  tg_keywords: string;
};

export const EMPTY_EMAIL_FORM: EmailJobFormData = {
  name: "",
  to_emails: "",
  cc_emails: "",
  bcc_emails: "",
  subject: "",
  content: "",
  content_type: "markdown",
  schedule: EMPTY_SCHEDULE,
  notify: 0,
  channelIds: null,
  timezone: LOCAL_TZ,
  tg_enabled: false,
  tg_channels: "",
  tg_keywords: "",
};

type Key = "name" | "to_emails" | "subject" | "content" | "tg_channels";

const ALL_TOUCHED: Record<Key, boolean> = {
  name: true,
  to_emails: true,
  subject: true,
  content: true,
  tg_channels: true,
};

function validate(f: EmailJobFormData): Record<Key, string | null> {
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
    name: f.name.trim() ? null : "任务名不能为空",
    to_emails: toErr,
    subject: f.subject.trim() ? null : "邮件标题不能为空",
    content: f.content.trim() ? null : "邮件正文不能为空",
    tg_channels: tgErr,
  };
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-3 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
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
  const [touched, setTouched] = useState<Partial<Record<Key, boolean>>>({});
  const [schedErr, setSchedErr] = useState<string | null>(null);
  const [showMoreRecipients, setShowMoreRecipients] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  const [testingTg, setTestingTg] = useState(false);
  const [tgTestResult, setTgTestResult] = useState<{
    ok: boolean;
    msg: string;
    previews?: Array<{ channel: string; postId: number; text?: string; link: string }>;
  } | null>(null);

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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(ALL_TOUCHED);
    if (blocked || notifyError) return;
    onSubmit();
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      dirty={dirty}
      title={form.id ? "编辑定时邮件任务" : "新建定时邮件任务"}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Group title="基本设置">
          <Field label="任务名称" error={err("name")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={!!err("name")}
                placeholder="例如：TG 频道更新推送 / 每日打卡提醒"
                value={form.name}
                onBlur={touch("name")}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </Field>

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

          <div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <span className="text-sm text-fg">失败通知 (Webhook 告警)</span>
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

        <Group title="Telegram 频道监控 (可选)">
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

        <Group title="调度规则">
          <ScheduleEditor
            value={form.schedule}
            timezone={form.timezone}
            onTimezoneChange={(tz) => set({ timezone: tz })}
            onError={setSchedErr}
            onChange={(schedule) => set({ schedule })}
          />
        </Group>

        <div className="sticky bottom-0 -mx-5 flex items-center justify-between border-t border-border bg-panel px-5 py-3">
          <Button
            type="button"
            variant="secondary"
            loading={testingSend}
            disabled={!form.to_emails.trim() || !form.subject.trim()}
            onClick={onTestSend}
            icon={<Send className="size-3.5" />}
          >
            试发一次
          </Button>

          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              保存
            </Button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
