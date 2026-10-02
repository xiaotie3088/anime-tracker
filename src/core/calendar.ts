/**
 * 日历分组：把「某一集几点更新」放进「哪一天」的格子里。
 *
 * 本文件存在的唯一理由，是解决深夜番的归属歧义 —— 这是本项目最容易出错的地方。
 *
 * 以「日曜 24:30」为例：
 *   - 真实钟点：周一 00:30（JST）
 *   - 日本电视台的放送日历：周日
 *   - 中国平台通常写成：周一 00:30
 *
 * 所以我们不替用户做决定，而是把两种口径都实现出来，交给 UI 上的开关：
 *   - 'clock'             —— 按真实钟点归属（周一 00:30 落在周一格子里）
 *   - 'broadcast-calendar'—— 按放送日历归属（同一集落在周日格子里）
 */

import { JST_OFFSET_MINUTES, WEEKDAY_CN, dateKeyInZone, isoUtc, parseHhmmJst, weekdayInZone } from './time.ts';

export const DAY_RULES = ['clock', 'broadcast-calendar'] as const;
export type DayRule = (typeof DAY_RULES)[number];

export const DAY_RULE_LABELS: Record<DayRule, string> = {
  clock: '按真实钟点归属',
  'broadcast-calendar': '按日本放送日历归属',
};

const MS_PER_DAY = 86_400_000;

/**
 * 深夜番最多溢出到次日清晨 6 点左右（"30:00" = 次日 06:00）。
 * 查询周区间时按这个值向两侧加宽，避免漏掉边界上的集数；
 * 归属则由 groupByDayJst 决定，不靠加宽来"兜"。
 */
export const DEEP_NIGHT_PAD_MS = 6 * 60 * 60 * 1000;

export type SchedulableItem = {
  /** 日本放送精确时刻（ISO8601 UTC）；为空表示这一集还没有确定时间 */
  airAtUtc: string | null;
  /** 字面放送时间，如 "24:30"；有它才能精确算出放送日历归属 */
  broadcastTimeJst?: string | null;
};

/**
 * 一个条目在 JST 下应归属到哪一天（返回 "YYYY-MM-DD"）。
 *
 * 注意：'broadcast-calendar' 规则只在知道字面放送时间时才能精确回退一天；
 * 拿不到字面时间时退化为真实钟点 —— 这是有意的降级，而不是猜。
 */
export function scheduleDayKeyJst(item: SchedulableItem, rule: DayRule): string | undefined {
  if (!item.airAtUtc) return undefined;
  const clockDate = dateKeyInZone(item.airAtUtc, 'jst');
  if (rule === 'clock') return clockDate;

  let overflowDays = 0;
  if (item.broadcastTimeJst) {
    try {
      overflowDays = parseHhmmJst(item.broadcastTimeJst).overflowDays;
    } catch {
      overflowDays = 0;
    }
  }
  if (overflowDays === 0) return clockDate;

  const back = Date.parse(`${clockDate}T00:00:00.000Z`) - overflowDays * MS_PER_DAY;
  return new Date(back).toISOString().slice(0, 10);
}

export type DayBucket<T> = {
  /** "YYYY-MM-DD"（JST） */
  dateJst: string;
  /** 0=周日 */
  weekdayJst: number;
  weekdayLabel: string;
  items: T[];
};

/**
 * 把条目按 JST 日期分桶。桶内按放送时刻升序；空桶不返回。
 */
export function groupByDayJst<T extends SchedulableItem>(items: readonly T[], rule: DayRule): DayBucket<T>[] {
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const dayKey = scheduleDayKeyJst(item, rule);
    if (!dayKey) continue;
    const list = buckets.get(dayKey);
    if (list) list.push(item);
    else buckets.set(dayKey, [item]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dateJst, list]) => ({
      dateJst,
      weekdayJst: weekdayInZone(`${dateJst}T12:00:00.000Z`, 'jst'),
      weekdayLabel: WEEKDAY_CN[weekdayInZone(`${dateJst}T12:00:00.000Z`, 'jst')] as string,
      items: list.sort((a, b) => Date.parse(a.airAtUtc as string) - Date.parse(b.airAtUtc as string)),
    }));
}

/** 给定 JST 日期（"YYYY-MM-DD"），返回该日 00:00 的 UTC 时刻。 */
export function jstDayStartUtc(dateJst: string): string {
  return isoUtc(Date.parse(`${dateJst}T00:00:00.000Z`) - JST_OFFSET_MINUTES * 60_000);
}

/**
 * 周区间的加宽查询窗口：给 listSchedule 用。
 * 加宽是为了不丢边界上的深夜番，归属仍由 scheduleDayKeyJst 决定。
 */
export function padWindow(startUtc: string, endUtc: string, padMs = DEEP_NIGHT_PAD_MS): {
  startUtc: string;
  endUtc: string;
} {
  return {
    startUtc: isoUtc(Date.parse(startUtc) - padMs),
    endUtc: isoUtc(Date.parse(endUtc) + padMs),
  };
}

/** 列出某个 JST 周区间内的 7 个日期（"YYYY-MM-DD"）。 */
export function datesOfJstWeek(weekStartDateJst: string): string[] {
  const base = Date.parse(`${weekStartDateJst}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * MS_PER_DAY).toISOString().slice(0, 10));
}
