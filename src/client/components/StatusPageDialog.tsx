import { useEffect, useState } from "react";
import { errText, get, put } from "../api";
import { useToast } from "./Toast";
import type { Monitor, StatusPageConfig } from "../types";
import { Button, Checkbox, Dialog, Field, Input, Skeleton, Switch } from "../ui";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Props = { open: boolean; onClose: () => void };

/** 公开状态页配置：启用开关、自定义路径 /status/<slug>、勾选要公开的监控。 */
export default function StatusPageDialog({ open, onClose }: Props) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(0);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState<{ slug?: string; title?: string; monitors?: string }>({});

  async function load() {
    try {
      const [cfg, list] = await Promise.all([
        get<{ config: StatusPageConfig }>("/api/status-page"),
        get<Monitor[]>("/api/monitors"),
      ]);
      setEnabled(cfg.config.enabled);
      setSlug(cfg.config.slug);
      setTitle(cfg.config.title);
      setSelected(cfg.config.monitor_ids);
      setMonitors(list);
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  function close() {
    onClose();
    setBusy(false);
    setFieldErr({});
  }

  function toggleMonitor(id: number, on: boolean) {
    setSelected(sel => (on ? [...sel, id] : sel.filter(x => x !== id)));
  }

  async function save() {
    const errs: typeof fieldErr = {};
    if (enabled === 1) {
      const s = slug.trim();
      if (!s || s.length > 50 || !SLUG_RE.test(s)) errs.slug = "仅支持小写字母、数字与中划线（≤50 字符）";
      const t = title.trim();
      if (!t || t.length > 60) errs.title = "标题必填（≤60 字）";
      if (selected.length === 0) errs.monitors = "至少勾选一个要公开的监控";
    }
    setFieldErr(errs);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      await put("/api/status-page", {
        enabled,
        slug: slug.trim(),
        title: title.trim() || "服务状态",
        monitor_ids: selected,
      });
      toast(enabled === 1 ? "状态页设置已保存" : "公开状态页已关闭");
      onClose();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  const eligible = (monitors ?? []).filter(m => m.enabled === 1);

  return (
    <Dialog open={open} onClose={close} title="公开状态页" width="max-w-lg"
      footer={
        <>
          {enabled === 1 && slug && (
            <Button variant="secondary" onClick={() => window.open(`/status/${slug}`, "_blank", "noopener")}>
              打开公开页
            </Button>
          )}
          <Button variant="secondary" onClick={close}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button>
        </>
      }>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
          <span className="text-sm text-fg">对外开放状态页</span>
          <Switch checked={enabled === 1} onChange={v => setEnabled(v ? 1 : 0)} label="启用公开状态页" />
        </div>

        <Field label="公开路径" hint="小写字母、数字与中划线；访客通过该路径免登录访问" error={fieldErr.slug ?? null}>
          {({ id, describedBy }) => (
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-sm text-fg-subtle">/status/</span>
              <Input id={id} aria-describedby={describedBy} invalid={!!fieldErr.slug}
                value={slug} placeholder="service-status" className="font-mono text-sm"
                onChange={e => setSlug(e.target.value)} />
            </div>
          )}
        </Field>

        <Field label="页面标题" error={fieldErr.title ?? null}>
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} invalid={!!fieldErr.title}
              value={title} placeholder="服务状态"
              onChange={e => setTitle(e.target.value)} />
          )}
        </Field>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">公开的监控</h3>
            {fieldErr.monitors && <p role="alert" className="text-xs text-danger">{fieldErr.monitors}</p>}
          </div>
          {monitors === null ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ) : eligible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-fg-subtle">
              还没有启用中的监控，先到监控页创建
            </p>
          ) : (
            <div className="divide-y divide-border/60 rounded-lg border border-border px-3">
              {eligible.map(m => (
                <div key={m.id} className="py-2">
                  <Checkbox checked={selected.includes(m.id)}
                    onChange={on => toggleMonitor(m.id, on)}>
                    <span className="min-w-0 truncate">{m.name}</span>
                  </Checkbox>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-fg-subtle">
            公开页只展示名称、状态、心跳条带、在线率与平均延迟；探测地址和错误详情不会公开。停用监控会自动从状态页隐藏。
          </p>
        </section>
      </div>
    </Dialog>
  );
}
