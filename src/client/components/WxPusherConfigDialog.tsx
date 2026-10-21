import { useEffect, useState } from "react";
import { errText, get, post, put } from "../api";
import { useToast } from "./Toast";
import type { WxPusherConfig } from "../types";
import { Badge, Button, Dialog, Field, Input } from "../ui";
import { CircleAlert, CircleCheck, Send } from "../ui/icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onConfigSaved?: () => void;
};

export default function WxPusherConfigDialog({ open, onClose, onConfigSaved }: Props) {
  const toast = useToast();
  const [config, setConfig] = useState<WxPusherConfig | null>(null);
  const [appToken, setAppToken] = useState("");
  const [defaultUids, setDefaultUids] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // 测试推送状态
  const [testUid, setTestUid] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr("");
    setTestResult(null);
    get<WxPusherConfig>("/api/email-jobs/wxpusher-config")
      .then((data) => {
        setConfig(data);
        setDefaultUids(data.defaultUids || "");
        setAppToken(""); // App Token 明文不回传
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
      const payload: Record<string, unknown> = { defaultUids };
      if (appToken.trim()) {
        payload.appToken = appToken.trim();
      }
      const updated = await put<WxPusherConfig>("/api/email-jobs/wxpusher-config", payload);
      setConfig(updated);
      setAppToken("");
      toast("WxPusher 微信配置已保存", "ok");
      onConfigSaved?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSend() {
    const targetUid = testUid.trim() || defaultUids.trim();
    if (!targetUid) {
      toast("请输入用于测试推送的 WxPusher UID", "err");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await post<{ latencyMs: number; msg: string }>("/api/email-jobs/wxpusher-test", {
        uids: targetUid,
        appToken: appToken.trim() || undefined,
      });
      setTestResult({
        ok: true,
        msg: `测试推送成功！耗时 ${res.latencyMs}ms，微信客户端已收到通知。`,
      });
      toast("测试微信已成功送出！", "ok");
    } catch (e) {
      const msg = errText(e);
      setTestResult({ ok: false, msg: `发送失败：${msg}` });
      toast(msg, "err");
    } finally {
      setTesting(false);
    }
  }

  const sourceLabel =
    config?.source === "db"
      ? "数据库存储"
      : config?.source === "env"
      ? "环境变量 (WXPUSHER_APP_TOKEN)"
      : "未配置";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="WxPusher 微信推送服务配置"
      width="max-w-xl"
      closeOnClickOutside={false}
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="text-xs text-fg-subtle">
            配置将安全保存在 Cloudflare D1 settings 表
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>
              保存配置
            </Button>
          </div>
        </div>
      }
    >
      <form onSubmit={handleSave} className="space-y-4">
        {/* 当前状态栏 */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-fg">当前状态</span>
              {config?.isConfigured ? (
                <Badge tone="success">已配置</Badge>
              ) : (
                <Badge tone="danger">未配置</Badge>
              )}
            </div>
            <p className="text-xs text-fg-subtle">来源：{sourceLabel}</p>
          </div>
          {config?.appTokenMasked && (
            <div className="text-right">
              <span className="text-[11px] text-fg-subtle">当前 App Token：</span>
              <span className="font-mono text-xs font-medium text-fg block">
                {config.appTokenMasked}
              </span>
            </div>
          )}
        </div>

        {err && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
            {err}
          </div>
        )}

        {/* 表单项 */}
        <Field
          label="WxPusher App Token"
          hint="请登录 wxpusher.zjiecode.com 控制台获取应用的 appToken。若不修改请留空。"
        >
          {({ id }) => (
            <Input
              id={id}
              type="password"
              placeholder={config?.isConfigured ? "已配置（输入新 Token 即可覆盖）" : "例如：AT_AbcDefGhiJklMnOp..."}
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
            />
          )}
        </Field>

        <Field
          label="默认接收用户 UID (可选)"
          hint="多个 UID 用逗号或换行分隔。任务中若未单独指定 UID，将自动回退到此默认 UID。"
        >
          {({ id }) => (
            <Input
              id={id}
              placeholder="UID_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={defaultUids}
              onChange={(e) => setDefaultUids(e.target.value)}
            />
          )}
        </Field>

        {/* 微信测试推送区域 */}
        <div className="rounded-xl border border-border bg-surface p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-fg">连通性测试 (向微信推送测试卡片)</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={testing}
              onClick={handleTestSend}
              icon={<Send className="size-3.5" />}
            >
              发送测试
            </Button>
          </div>

          <Field label="测试目标 UID" hint="关注微信服务号后在「我的 -> 个人中心」获取">
            {({ id }) => (
              <Input
                id={id}
                placeholder="UID_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={testUid}
                onChange={(e) => setTestUid(e.target.value)}
              />
            )}
          </Field>

          {testResult && (
            <div
              className={`rounded-lg border p-2.5 text-xs ${
                testResult.ok
                  ? "border-success/30 bg-success/5 text-success"
                  : "border-danger/30 bg-danger/5 text-danger"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {testResult.ok ? (
                  <CircleCheck className="size-4 shrink-0" />
                ) : (
                  <CircleAlert className="size-4 shrink-0" />
                )}
                <span>{testResult.msg}</span>
              </div>
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}
