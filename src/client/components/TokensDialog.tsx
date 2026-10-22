import { useEffect, useState } from "react";
import { del, errText, get, post } from "../api";
import { useToast } from "./Toast";
import { relativeTime } from "../utils/time";
import type { ApiToken } from "../types";
import { Button, Dialog, Field, Input, Skeleton, useConfirm } from "../ui";
import { Copy, Plus, Trash2 } from "../ui/icons";

type Props = { open: boolean; onClose: () => void };

/** 创建成功后的临时态：明文令牌只在这里展示这一次 */
type CreatedToken = { id: number; name: string; token: string };

/** API 令牌管理：供外部系统调用 POST /api/trigger。明文只在创建时展示一次，列表仅脱敏前缀。 */
export default function TokensDialog({ open, onClose }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  // 接口示例：部署域名因人而异（workers.dev 子域或自定义域），弹窗里给占位示例
  const ENDPOINT_EXAMPLE = "POST https://<你的部署域名>/api/trigger";

  async function load() {
    try {
      const d = await get<{ tokens: ApiToken[] }>("/api/tokens");
      setTokens(d.tokens);
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  function close() {
    onClose();
    setTokens(null);
    setCreating(false);
    setName("");
    setNameErr(null);
    setBusy(false);
    setCreated(null);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameErr("令牌名称不能为空");
      return;
    }
    setBusy(true);
    setNameErr(null);
    try {
      const d = await post<{ id: number; name: string; token: string }>("/api/tokens", { name: trimmed });
      setCreating(false); // 「我已保存」后回到列表而不是新建表单
      setCreated(d); // 切到一次性明文展示，不回列表
      setName("");
      await load();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      toast("已复制到剪贴板");
    } catch {
      toast("复制失败，请手动选中复制", "err");
    }
  }

  async function removeToken(t: ApiToken) {
    const ok = await confirm({
      title: `撤销令牌「${t.name}」？`,
      description: "使用该令牌的外部触发会立即开始收到 401，撤销后无法恢复。",
      confirmText: "撤销",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await del(`/api/tokens/${t.id}`);
      toast("令牌已撤销");
      await load();
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  const bodyView = created ? "created" : creating ? "form" : "list";

  return (
    <Dialog open={open} onClose={close} title="API 令牌" width="max-w-lg" closeOnClickOutside={false}
      footer={bodyView === "form" ? (
        <>
          <Button variant="secondary" onClick={() => setCreating(false)}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>创建令牌</Button>
        </>
      ) : bodyView === "list" ? (
        <Button variant="secondary" onClick={close}>关闭</Button>
      ) : undefined}>
      {created ? (
        <div className="space-y-3">
          <p className="text-sm text-fg">
            令牌「{created.name}」已创建。请立即复制保存，<span className="font-medium text-danger">关闭后将无法再次查看</span>。
          </p>
          <div className="rounded-lg border border-border bg-surface px-3 py-2.5 font-mono text-xs break-all text-fg">
            {created.token}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyToken()} icon={<Copy className="size-3.5" />}>复制</Button>
            <Button size="sm" variant="primary" onClick={() => setCreated(null)}>我已保存</Button>
          </div>
        </div>
      ) : bodyView === "form" ? (
        <form onSubmit={e => { e.preventDefault(); void create(); }} noValidate>
          <Field label="令牌名称" hint="便于辨认用途，如「外部 cron 服务」" error={nameErr}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} invalid={!!nameErr}
                value={name} placeholder="如 外部 cron 服务" autoFocus
                onChange={e => setName(e.target.value)} />
            )}
          </Field>
          <p className="text-xs text-fg-subtle">
            创建后明文只展示一次，请当场保存。
          </p>
        </form>
      ) : (
        <div className="space-y-6">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">外部触发接口</h3>
            <div className="rounded-lg border border-border bg-surface px-3 py-2.5 space-y-1.5">
              <p className="font-mono text-xs break-all text-fg">{ENDPOINT_EXAMPLE}</p>
              <p className="text-xs text-fg-subtle">
                请求头携带 <code className="font-mono">Authorization: Bearer &lt;令牌&gt;</code>。
              </p>
              <ul className="text-xs text-fg-subtle list-disc list-inside space-y-0.5">
                <li>完整调度：<code className="font-mono">POST /api/trigger</code></li>
                <li>指定 GithubAction：<code className="font-mono">POST /api/trigger/jobs/:id</code></li>
                <li>指定定时任务：<code className="font-mono">POST /api/trigger/tasks/:id</code></li>
              </ul>
              <p className="text-xs text-fg-subtle">限频 5 次/分钟；令牌可随时撤销。</p>
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">令牌</h3>
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)} icon={<Plus className="size-3.5" />}>新建</Button>
            </div>
            {tokens === null ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-14 w-full rounded-lg" />
                <Skeleton className="h-14 w-full rounded-lg" />
              </div>
            ) : tokens.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-fg-subtle">
                还没有令牌，点右上角「新建」创建第一个
              </p>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border">
                {tokens.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{t.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-fg-subtle">{t.token_prefix}…</p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {relativeTime(t.created_at)}创建 ·{" "}
                        {t.last_used_at === null ? "从未使用" : `${relativeTime(t.last_used_at)}使用`}
                      </p>
                    </div>
                    <button type="button" aria-label={`撤销「${t.name}」`} title="撤销"
                      className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger"
                      onClick={() => void removeToken(t)}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
