import { useEffect, useState } from "react";
import { errText, get, post, put } from "../api";
import { useToast } from "./Toast";
import type { ResendConfig } from "../types";
import { Badge, Button, Dialog, Field, Input, Textarea } from "../ui";
import { Send, CircleAlert, CircleCheck } from "../ui/icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onConfigSaved?: () => void;
};

export default function ResendConfigDialog({ open, onClose, onConfigSaved }: Props) {
  const toast = useToast();
  const [config, setConfig] = useState<ResendConfig | null>(null);
  const [apiKeysText, setApiKeysText] = useState("");
  const [from, setFrom] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // 测试发信状态
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr("");
    setTestResult(null);
    get<ResendConfig>("/api/email-jobs/config")
      .then((data) => {
        setConfig(data);
        setFrom(data.from || "onboarding@resend.dev");
        setReplyTo(data.replyTo || "");
        setApiKeysText(""); // API Key 明文不回传
      })
      .catch((e) => {
        setErr(errText(e));
      })
      .finally(() => setLoading(false));
  }, [open]);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const payload: Record<string, unknown> = { from, replyTo };
      if (apiKeysText.trim()) {
        payload.apiKeys = apiKeysText.trim();
      }
      const updated = await put<ResendConfig>("/api/email-jobs/config", payload);
      setConfig(updated);
      setApiKeysText("");
      toast("Resend 邮件配置已保存", "ok");
      onConfigSaved?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSend() {
    if (!testTo.trim()) {
      toast("请输入测试收件人邮箱", "err");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await post<{ resendId?: string; latencyMs: number; usedKeyMasked?: string }>("/api/email-jobs/test", {
        to: testTo.trim(),
        apiKeys: apiKeysText.trim() || undefined,
        from: from.trim() || undefined,
        replyTo: replyTo.trim() || undefined,
      });
      setTestResult({
        ok: true,
        msg: `测试邮件发送成功！${res.usedKeyMasked ? `选用密钥 ${res.usedKeyMasked}，` : ""}耗时 ${res.latencyMs}ms (ID: ${res.resendId || "ok"})`,
      });
      toast("测试邮件已成功送出！", "ok");
    } catch (e) {
      const msg = errText(e);
      setTestResult({ ok: false, msg: `发送失败：${msg}` });
      toast(msg, "err");
    } finally {
      setTesting(false);
    }
  }

  const keyCount = config?.keyCount ?? (config?.apiKeysMasked?.length || (config?.isConfigured ? 1 : 0));
  const sourceLabel =
    config?.source === "db"
      ? `数据库存储 (${keyCount} 个密钥)`
      : config?.source === "env"
      ? `环境变量注入 (${keyCount} 个密钥)`
      : "未配置";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="邮件服务配置 (Resend 多密钥支持)"
      width="max-w-lg"
      closeOnClickOutside={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
            保存配置
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="py-8 text-center text-sm text-fg-subtle">正在加载配置…</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-xs">
            <span className="text-fg-muted">当前配置状态</span>
            <Badge tone={config?.isConfigured ? "neutral" : "warn"}>
              {sourceLabel}
            </Badge>
          </div>

          <Field
            label="Resend API Key（多密钥池）"
            hint="可每行填写一个密钥或用逗号分隔。发信时系统随机抽取一个密钥；遇 429 限流或额度超限时自动轮转备用密钥。"
          >
            {({ id }) => (
              <div className="space-y-2">
                {config && config.apiKeysMasked && config.apiKeysMasked.length > 0 && (
                  <div className="rounded-md border border-border bg-surface-raised p-2.5">
                    <div className="flex items-center justify-between text-xs font-medium text-fg mb-1.5">
                      <span>已生效密钥池 ({config.apiKeysMasked.length} 个)</span>
                      <Badge tone="success">随机轮询中</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                      {config.apiKeysMasked.map((k, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center rounded border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-fg-muted"
                        >
                          #{idx + 1}&nbsp;{k}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <Textarea
                  id={id}
                  rows={3}
                  placeholder={
                    config?.isConfigured
                      ? "留空则保持现有密钥不变。若要更新或添加，请在此粘贴新密钥列表（每行一个）：\nre_1234567890abcdef\nre_0987654321fedcba"
                      : "前往 resend.com/api-keys 创建并在此输入密钥。支持每行一个输入多个：\nre_1234567890abcdef\nre_0987654321fedcba"
                  }
                  value={apiKeysText}
                  onChange={(e) => setApiKeysText(e.target.value)}
                />
              </div>
            )}
          </Field>

          <Field
            label="发件人 (From)"
            hint="未验证自定义域名时仅可用 onboarding@resend.dev 发往注册账号邮箱；域名验证后可使用 姓名 <noreply@yourdomain.com>"
          >
            {({ id }) => (
              <Input
                id={id}
                placeholder="系统提醒 <onboarding@resend.dev>"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>

          <Field label="回复地址 (Reply-To)" hint="可选。用户点击回复时接收邮件的地址">
            {({ id }) => (
              <Input
                id={id}
                placeholder="support@yourdomain.com"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
              />
            )}
          </Field>

          {err && <p className="text-xs text-danger">{err}</p>}

          <div className="mt-4 rounded-lg border border-border bg-surface p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-fg">
              <Send className="size-3.5 text-fg-muted" />
              连通性测试
            </h4>
            <p className="mb-2.5 text-xs text-fg-subtle">
              输入接收邮箱，立即发送一封连通性测试邮件以验证发件人域名与 API Key。
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="your-email@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={testing}
                onClick={handleTestSend}
                disabled={!testTo.trim()}
              >
                测试发送
              </Button>
            </div>
            {testResult && (
              <div
                className={`mt-2.5 flex items-start gap-1.5 text-xs ${
                  testResult.ok ? "text-success" : "text-danger"
                }`}
              >
                {testResult.ok ? (
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span>{testResult.msg}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
