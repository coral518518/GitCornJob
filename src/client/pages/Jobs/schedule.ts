import type { Schedule } from "../../types";

export const EMPTY_SCHEDULE: Schedule = { type: "interval", mode: "fixed", value: 45, unit: "m" };

const UNIT_NAME: Record<string, string> = { m: "分钟", h: "小时", d: "天" };

/** 本机时区（新建任务时区下拉的默认值） */
export const LOCAL_TZ: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** 常用时区：覆盖 UTC-11 ~ UTC+12 的主要 IANA 时区（含半小时偏移国家；
 * -12 无主要城市的 IANA 城市时区，从 -11 起步），每个偏移只保留一个代表城市 */
const COMMON_TZS: string[] = [
  "Pacific/Pago_Pago", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
  "America/Denver", "America/Mexico_City", "America/Chicago", "America/New_York",
  "America/Halifax", "America/Sao_Paulo", "America/Noronha", "Atlantic/Azores",
  "Europe/London", "Europe/Paris", "Africa/Cairo", "Europe/Moscow", "Asia/Tehran",
  "Asia/Dubai", "Asia/Kabul", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu",
  "Asia/Dhaka", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
  "Pacific/Noumea", "Pacific/Auckland",
];

/** 时区当前 UTC 偏移标签（如 "UTC+08:00"，含分钟）；按当前时刻计算，
 * 夏令时时区随季节变化。老运行时不支持 longOffset 时返回 null。 */
function tzOffset(tz: string): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    return /^GMT/.test(part) ? part.replace(/^GMT$/, "UTC+00:00").replace(/^GMT/, "UTC") : null;
  } catch {
    return null;
  }
}

/** 时区当前 UTC 偏移的分钟数（排序用），同上按当前时刻计算；异常返回 null */
function tzOffsetMinutes(tz: string): number | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part);
    if (!m) return part === "GMT" ? 0 : null;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return null;
  }
}

/**
 * 时区下拉选项：UTC 置顶（独立语义选项），常用时区按偏移升序，标签为
 * 「UTC 偏移量 + IANA 名称」。本机/当前选中值不在常用列表时置顶补充并标注角色。
 */
export function timezoneOptions(current?: string): { value: string; label: string }[] {
  const common = COMMON_TZS
    .map((tz) => ({ tz, off: tzOffset(tz), min: tzOffsetMinutes(tz) ?? 0 }))
    .sort((a, b) => a.min - b.min)
    .map(({ tz, off }) => ({ value: tz, label: off ? `(${off}) ${tz}` : tz }));

  const extras = [...new Set([LOCAL_TZ, current || ""].filter(
    (tz) => tz && tz !== "UTC" && !COMMON_TZS.includes(tz),
  ))];
  const tagged = extras.map((tz) => {
    const off = tzOffset(tz);
    const tag = tz === LOCAL_TZ ? "本机" : "当前";
    return { value: tz, label: off ? `(${off}) ${tz} · ${tag}` : `${tz} · ${tag}` };
  });

  return [...tagged, { value: "UTC", label: "(UTC+00:00) UTC" }, ...common];
}
/**
 * 任务「调度相关时间」的展示时区：cron 任务按其生效时区（空 = UTC，不再换算
 * 成本机时间）；间隔任务与时区无关，保持本机时区显示。null = 用本机时区。
 */
export function displayTzOf(s: Schedule, tz?: string | null): string | null {
  return s.type === "cron" ? (tz || "UTC") : null;
}

/** 解析后端存的 schedule_json。任何异常输入都兜底为 EMPTY_SCHEDULE，绝不抛错。 */
export function parseSchedule(json: string): Schedule {
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return EMPTY_SCHEDULE;
    return v as Schedule;
  } catch {
    return EMPTY_SCHEDULE;
  }
}

/** 调度规则的紧凑描述（不含时区标注，仪表盘窄列用）：类型词统一前置 */
export function describeRule(s: Schedule): string {
  if (s.type === "cron") return s.expr ? `cron ${s.expr}` : "cron";
  const u = UNIT_NAME[s.unit ?? "m"];
  if (s.mode === "random") return `随机 每 ${s.min}~${s.max} ${u}`;
  return `固定 每 ${s.value} ${u}`;
}

/** 人类可读的调度描述：cron 表达式带生效时区（空/UTC 显示 UTC），中点分隔。 */
export function describeLocal(s: Schedule, tz?: string | null): string {
  const rule = describeRule(s);
  if (s.type !== "cron") return rule;
  return `${rule} · ${tz || "UTC"}`;
}
