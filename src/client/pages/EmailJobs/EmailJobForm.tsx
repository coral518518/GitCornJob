import { useState, type ReactNode } from "react";
import type { Channel, Schedule } from "../../types";
import { CHANNEL_TYPE_LABEL } from "../../types";
import { Badge, Button, Checkbox, Drawer, Field, Input, Segmented, Switch, Textarea } from "../../ui";
import { EMPTY_SCHEDULE, LOCAL_TZ } from "../Jobs/schedule";
import ScheduleEditor from "../Jobs/ScheduleEditor";
import { Sparkles, Send, Eye, Code } from "../../ui/icons";

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
};

type Key = "name" | "to_emails" | "subject" | "content";

const ALL_TOUCHED: Record<Key, boolean> = {
  name: true,
  to_emails: true,
  subject: true,
  content: true,
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

  return {
    name: f.name.trim() ? null : "任务名不能为空",
    to_emails: toErr,
    subject: f.subject.trim() ? null : "邮件标题不能为空",
    content: f.content.trim() ? null : "邮件正文不能为空",
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
                placeholder="例如：每日打卡提醒 / 每周工作简报"
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
                      form.content_type === "markdown"
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
