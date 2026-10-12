import { useEffect, useRef } from "react";

/** 无用户操作多久后判定为空闲暂停刷新（毫秒）：5 分钟 */
const IDLE_TIMEOUT_MS = 5 * 60_000;

let lastActivityTime = Date.now();
let activityListenersAttached = false;

function initActivityListeners() {
  if (activityListenersAttached || typeof window === "undefined") return;
  activityListenersAttached = true;
  const update = () => {
    // 节流 1 秒更新，避免高频 mousemove 造成多余写入
    const now = Date.now();
    if (now - lastActivityTime > 1000) {
      lastActivityTime = now;
    }
  };
  const events = ["mousedown", "keydown", "scroll", "touchstart", "mousemove"];
  events.forEach((ev) => window.addEventListener(ev, update, { passive: true }));
}

/**
 * 定时自动刷新：
 * - enabled=false 时不启动（如弹窗/抽屉打开期间暂停）。
 * - 仅在页面可见（document.visibilityState === "visible"）且处于活跃状态时定时调用 fn。
 * - 超过 5 分钟无鼠标/键盘/触屏操作判定为空闲并自动暂停，避免挂机后台或屏幕开着空耗 Cloudflare 请求额度。
 * - 用户从空闲恢复操作时，若暂停期间错过刷新，立即刷新一次并恢复计时。
 * - 页面从后台切回前台时，若距离上次执行超过刷新周期，立即补偿刷新一次。
 */
export function useAutoRefresh(fn: () => void, ms: number, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  const wasIdleRef = useRef(false);
  const lastRunRef = useRef(Date.now());

  useEffect(() => {
    initActivityListeners();
    if (!enabled) return;

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const isIdle = Date.now() - lastActivityTime > IDLE_TIMEOUT_MS;
      if (isIdle) {
        wasIdleRef.current = true;
        return;
      }
      lastRunRef.current = Date.now();
      ref.current();
    };

    const id = setInterval(tick, ms);

    // 唤醒逻辑：从空闲状态恢复用户交互时立即执行一次并重置
    const onWakeFromIdle = () => {
      if (wasIdleRef.current && document.visibilityState === "visible") {
        wasIdleRef.current = false;
        lastRunRef.current = Date.now();
        ref.current();
      }
    };

    // 页面切回可见时补刷
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (Date.now() - lastRunRef.current >= ms) {
          lastRunRef.current = Date.now();
          ref.current();
        }
      }
    };

    const wakeEvents = ["mousedown", "keydown", "touchstart"];
    wakeEvents.forEach((ev) => window.addEventListener(ev, onWakeFromIdle, { passive: true }));
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(id);
      wakeEvents.forEach((ev) => window.removeEventListener(ev, onWakeFromIdle));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ms, enabled]);
}

