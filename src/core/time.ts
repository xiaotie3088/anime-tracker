/**
 * 时间 / 深夜番 / 季度 工具
 *
 * 这是本项目最容易做错、也最影响体验的一块，先把规则写死在这里：
 *
 * 1. 日本电视台的放送时间常写作「日曜 24:30」，字面小时可以 >= 24。
 *    它表示「放送日历上的周日」，但真实钟点是周一 00:30。
 *    所以我们必须同时保留两个星期，绝不混用：
 *      - broadcastWeekdayJst：放送日历归属（这里是周日）
 *      - clockWeekdayJst    ：真实钟点归属（这里是周一）
 *    错误做法：把 UTC 时间戳转成本地时间再取星期 —— 深夜番会整体错位一天。
 *
 * 2. 所有对外存储的时间统一为 ISO8601 UTC 字符串（形如 2026-10-04T15:30:00.000Z）。
 *
 * 3. 本文件「零依赖、纯函数」，因此 scripts/verify.ts 可以在不装任何依赖的情况下
 *    直接 `node scripts/verify.ts` 做离线自检。
 *
 * 4. 刻意不使用 Intl / 时区数据库：只用固定的 UTC 偏移做算术，
 *    避免 small-icu 构建环境下 Intl 抛错，也保证结果完全确定、可测试。
 */

export const JST_OFFSET_MINUTES = 9 * 60;
export const CN_OFFSET_MINUTES = 8 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
export const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'] as const;

export type ZoneId = 'jst' | 'cn';

export const ZONES: Record<ZoneId, { label: string; offsetMinutes: number }> = {
  jst: { label: 'JST', offsetMinutes: JST_OFFSET_MINUTES },
  cn: { label: 'CST', offsetMinutes: CN_OFFSET_MINUTES },
};

// ---------------------------------------------------------------------------
// 基础换算
// ---------------------------------------------------------------------------

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/** 把墙上钟时间（某时区的年月日时分）当成 UTC 来编码，用于避开时区数据库。 */
function wallClockMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

function assertPlainDate(value: string, label: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new TypeError(`${label} 必须是 YYYY-MM-DD 形式，收到：${value}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new TypeError(`${label} 不是合法日期：${value}`);
  }
  return [year, month, day];
}

// ---------------------------------------------------------------------------
// 放送时刻：「24:30」这类字面时间
// ---------------------------------------------------------------------------

export type HhmmParse = {
  /** 字面小时，可能 >= 24（如 24、25、26） */
  literalHours: number;
  minutes: number;
  /** 越过午夜的天数：24:30 -> 1，23:00 -> 0 */
  overflowDays: number;
  /** 归一化后的展示文本，如 "24:30" */
  normalized: string;
};

/**
 * 解析放送时间字面量。容忍全角冒号与单位数小时（"7:30"）。
 * 不做 0-23 的取模 —— 取模会丢掉「这是深夜番」这个关键信息。
 */
export function parseHhmmJst(input: string): HhmmParse {
  const cleaned = String(input).trim().replace(/：/g, ':');
  const m = /^(\d{1,2}):(\d{2})$/.exec(cleaned);
  if (!m) throw new TypeError(`放送时间必须是 HH:MM 或「24:30」形式，收到：${input}`);
  const literalHours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59) throw new TypeError(`分钟数必须在 00-59 之间，收到：${input}`);
  if (literalHours > 30) throw new TypeError(`小时数过大（应 <= 30），收到：${input}`);
  return {
    literalHours,
    minutes,
    overflowDays: Math.floor(literalHours / 24),
    normalized: `${String(literalHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

export type AiringSlot = {
  /** 放送日历上的日期（JST），如 "2026-10-04" */
  broadcastDateJst: string;
  /** 放送日历归属星期，0=周日 */
  broadcastWeekdayJst: number;
  /** 字面放送时间，如 "24:30" */
  hhmmJst: string;
  /** 越过午夜的天数 */
  overflowDays: number;
  /** 真实钟点归属星期，0=周日 */
  clockWeekdayJst: number;
  /** 真实钟点的 JST 日期，如 "2026-10-05" */
  clockDateJst: string;
  /** 精确时刻，ISO8601 UTC */
  airAtUtc: string;
};

/**
 * 由「放送日历日期 + 字面放送时间」解出完整时刻信息。
 *
 * 例：resolveAiringSlot('2026-10-04', '24:30')
 *   放送日历是 2026-10-04（周日），真实钟点是 2026-10-05（周一）00:30 JST，
 *   即 2026-10-04T15:30:00.000Z。
 */
export function resolveAiringSlot(broadcastDateJst: string, hhmmJst: string): AiringSlot {
  const [year, month, day] = assertPlainDate(broadcastDateJst, 'broadcastDateJst');
  const { literalHours, minutes, overflowDays, normalized } = parseHhmmJst(hhmmJst);

  // 真实钟点的墙上时间 = 放送日历当天 00:00 + 字面小时
  const clockWallMs = wallClockMs(year, month, day, literalHours, minutes);
  const broadcastWallMs = wallClockMs(year, month, day);

  const airAtUtcMs = clockWallMs - JST_OFFSET_MINUTES * MS_PER_MINUTE;

  const clockDate = new Date(clockWallMs);

  return {
    broadcastDateJst: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    broadcastWeekdayJst: new Date(broadcastWallMs).getUTCDay(),
    hhmmJst: normalized,
    overflowDays,
    clockWeekdayJst: clockDate.getUTCDay(),
    clockDateJst: clockDate.toISOString().slice(0, 10),
    airAtUtc: isoUtc(airAtUtcMs),
  };
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/** 某时刻在指定时区的星期（0=周日）。用于「真实钟点归属」。 */
export function weekdayInZone(iso: string, zone: ZoneId): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${iso}`);
  return new Date(ms + ZONES[zone].offsetMinutes * MS_PER_MINUTE).getUTCDay();
}

/** 某时刻在指定时区的日期键，形如 "2026-10-05"。 */
export function dateKeyInZone(iso: string, zone: ZoneId): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${iso}`);
  return new Date(ms + ZONES[zone].offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** 某时刻在指定时区的 HH:MM。 */
export function clockInZone(iso: string, zone: ZoneId): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${iso}`);
  const d = new Date(ms + ZONES[zone].offsetMinutes * MS_PER_MINUTE);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 形如 "周三 00:30"。 */
export function formatInZone(iso: string, zone: ZoneId): string {
  const wd = WEEKDAY_CN[weekdayInZone(iso, zone)];
  return `${wd} ${clockInZone(iso, zone)}`;
}

/** 形如 "周三 00:30 (JST)"。 */
export function formatInZoneLabeled(iso: string, zone: ZoneId): string {
  return `${formatInZone(iso, zone)} (${ZONES[zone].label})`;
}

/** 形如 "10-05 00:30"。 */
export function formatShortInZone(iso: string, zone: ZoneId): string {
  return `${dateKeyInZone(iso, zone).slice(5)} ${clockInZone(iso, zone)}`;
}

// ---------------------------------------------------------------------------
// 倒计时
// ---------------------------------------------------------------------------

export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MS_PER_MINUTE) return '不到 1 分钟';
  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((abs % MS_PER_HOUR) / MS_PER_MINUTE);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${minutes} 分`;
}

export type Countdown = {
  state: 'upcoming' | 'aired';
  /** 正数=还有多久更新；负数=已更新多久 */
  ms: number;
  text: string;
};

export function countdown(airAtUtc: string, now: Date = new Date()): Countdown {
  const target = Date.parse(airAtUtc);
  if (Number.isNaN(target)) throw new TypeError(`不是合法时间：${airAtUtc}`);
  const diff = target - now.getTime();
  if (diff > 0) return { state: 'upcoming', ms: diff, text: `${humanDuration(diff)}后` };
  return { state: 'aired', ms: diff, text: '已更新' };
}

// ---------------------------------------------------------------------------
// 季度
// ---------------------------------------------------------------------------

export const SEASON_MONTHS = [1, 4, 7, 10] as const;
export type SeasonMonth = (typeof SEASON_MONTHS)[number];
export type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export type SeasonInfo = {
  year: number;
  /** 季度起始月：1 / 4 / 7 / 10 */
  month: SeasonMonth;
  /** 形如 "2026-10"，作为本项目内部的季度主键 */
  id: string;
  /** 形如 "2026秋" */
  label: string;
  /** 中文习惯的季节名 */
  seasonCn: '冬' | '春' | '夏' | '秋';
  /** AniList 用的季节枚举 */
  aniList: AniListSeason;
};

/**
 * 中文习惯：1月番=冬，4月番=春，7月番=夏，10月番=秋。
 *
 * 默认按 JST 判定（你选择了「默认日本放送时间」），并且刻意不用本地时区方法，
 * 否则同一份代码在不同时区的机器上会算出不同季度，测试也会跟着飘。
 */
export function seasonOf(date: Date | string = new Date(), zone: ZoneId = 'jst'): SeasonInfo {
  const ms = typeof date === 'string' ? Date.parse(date) : date.getTime();
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${String(date)}`);

  const shifted = new Date(ms + ZONES[zone].offsetMinutes * MS_PER_MINUTE);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const quarter = SEASON_MONTHS[Math.min(3, Math.floor((month - 1) / 3))] as SeasonMonth;
  return seasonFromId(`${year}-${String(quarter).padStart(2, '0')}`);
}

const SEASON_CN: Record<SeasonMonth, '冬' | '春' | '夏' | '秋'> = { 1: '冬', 4: '春', 7: '夏', 10: '秋' };
const SEASON_ANILIST: Record<SeasonMonth, AniListSeason> = { 1: 'WINTER', 4: 'SPRING', 7: 'SUMMER', 10: 'FALL' };

export function seasonFromId(id: string): SeasonInfo {
  const m = /^(\d{4})-(\d{2})$/.exec(id.trim());
  if (!m) throw new TypeError(`季度 ID 必须是 YYYY-MM 形式，收到：${id}`);
  const year = Number(m[1]);
  const month = Number(m[2]) as SeasonMonth;
  if (!SEASON_MONTHS.includes(month)) {
    throw new TypeError(`季度 ID 的月份只能是 ${SEASON_MONTHS.join(' / ')}，收到：${id}`);
  }
  return {
    year,
    month,
    id: `${year}-${String(month).padStart(2, '0')}`,
    label: `${year}${SEASON_CN[month]}`,
    seasonCn: SEASON_CN[month],
    aniList: SEASON_ANILIST[month],
  };
}

export function seasonIdOf(info: SeasonInfo): string {
  return info.id;
}

/**
 * 季度对应的 UTC 时间区间。
 * padDays 用来宽松收纳「提前一周开播」「延后到下一季初才完结」的番。
 */
export function seasonDateRange(id: string, padDays = 15): { startUtc: string; endUtc: string; startDate: string; endDate: string } {
  const info = seasonFromId(id);
  const startMs = Date.UTC(info.year, info.month - 1, 1) - padDays * MS_PER_DAY;
  // 季度末 = 起始月 + 3 个月的 1 号减 1 毫秒
  const endMs = Date.UTC(info.year, info.month - 1 + 3, 1) - 1 + padDays * MS_PER_DAY;
  return {
    startUtc: isoUtc(startMs),
    endUtc: isoUtc(endMs),
    startDate: new Date(Date.UTC(info.year, info.month - 1, 1)).toISOString().slice(0, 10),
    endDate: new Date(Date.UTC(info.year, info.month - 1 + 3, 0)).toISOString().slice(0, 10),
  };
}

/** 上一个 / 下一个季度，offset 可为负。 */
export function shiftSeason(id: string, offset: number): string {
  const info = seasonFromId(id);
  const index = info.year * 4 + SEASON_MONTHS.indexOf(info.month) + offset;
  const year = Math.floor(index / 4);
  const month = SEASON_MONTHS[((index % 4) + 4) % 4] as SeasonMonth;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 补番库辅助
// ---------------------------------------------------------------------------

/**
 * 估算补完剩余集数需要多久。
 * 用途：补番库卡片上显示「还剩 8 小时 20 分」。
 */
export function estimateWatchDuration(episodes: number, durationMin = 24): string {
  if (!Number.isFinite(episodes) || episodes <= 0) return '—';
  return humanDuration(episodes * durationMin * MS_PER_MINUTE);
}

/** 用于「今日补番计划」：按每天 N 集推算还需要几天看完。 */
export function estimateDaysToFinish(remainingEps: number, epsPerDay: number): number {
  if (!Number.isFinite(remainingEps) || remainingEps <= 0) return 0;
  if (!Number.isFinite(epsPerDay) || epsPerDay <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(remainingEps / epsPerDay);
}

/**
 * 从 UTC 时刻反推「日本放送日历上的字面写法」。
 *
 * 为什么需要：bangumi-data 只给 `R/2026-10-07T15:00:00.000Z/P7D` 这样的精确时刻，
 * 但日本电视台的排期表写的是「水曜 24:00」。同一时刻，两种写法对应两个不同的星期，
 * 而你的日历要按放送日历分组就必须还原字面写法。
 *
 * 反推依据是一条业界惯例：**JST 凌晨 0:00 ~ 5:59 播出的番，在日本排期表上属于前一天**。
 * cutoffHour 就是这个分界点（默认 6 点）。
 *
 * 例：2026-10-07T15:00:00.000Z → JST 2026-10-08 00:00 → 还原为 2026-10-07（周三）24:00
 */
export function toLiteralJstTime(
  iso: string,
  cutoffHour = 6,
): { hhmmJst: string; overflowDays: number; broadcastDateJst: string; broadcastWeekdayJst: number } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${iso}`);

  const clock = clockInZone(iso, 'jst');
  const hour = Number(clock.slice(0, 2));
  const overflowDays = hour < cutoffHour ? 1 : 0;
  const literal = overflowDays === 1 ? `${hour + 24}:${clock.slice(3)}` : clock;

  const clockDate = dateKeyInZone(iso, 'jst');
  const broadcastMs = Date.parse(`${clockDate}T00:00:00.000Z`) - overflowDays * MS_PER_DAY;
  const broadcastDateJst = new Date(broadcastMs).toISOString().slice(0, 10);

  return {
    hhmmJst: literal,
    overflowDays,
    broadcastDateJst,
    broadcastWeekdayJst: new Date(broadcastMs).getUTCDay(),
  };
}

// ---------------------------------------------------------------------------
// ISO 8601 重复区间
// ---------------------------------------------------------------------------

/**
 * 解析 ISO 8601 重复区间 —— bangumi-data 的 broadcast 字段就是这个格式。
 *
 *   "R/2026-10-07T15:00:00.000Z/P7D"  =  从该 UTC 时刻起，每 7 天一次
 *
 * 这是实测确认的格式（不是猜的），它直接给出日本放送时刻，无需任何推算。
 */
export function parseIsoRepeatingInterval(value: string): { startUtc: string; periodDays: number } | null {
  const match = /^R\/([^/]+)\/P(\d+)D$/.exec(value.trim());
  if (!match?.[1]) return null;
  const startUtc = match[1];
  if (Number.isNaN(Date.parse(startUtc))) return null;
  const periodDays = Number(match[2] ?? '7');
  if (!Number.isFinite(periodDays) || periodDays <= 0) return null;
  return { startUtc, periodDays };
}

// ---------------------------------------------------------------------------
// 周区间
// ---------------------------------------------------------------------------

/**
 * 以 JST 为基准的「一周」区间，默认从周一 00:00 JST 到下周一 00:00 JST。
 *
 * 为什么用 JST 而不是本地时区：你选择了「默认日本放送时间」，
 * 那么周视图的边界也必须是日本时间的周一零点，否则跨时区时会出现
 * 「周日的番跑到上一周去」这种难以解释的现象。
 *
 * 返回值是 UTC 时刻，直接可以喂给 listSchedule。
 */
export function jstWeekRange(
  reference: Date | string = new Date(),
  weekStartsOn = 1,
): { startUtc: string; endUtc: string; startDateJst: string; endDateJst: string } {
  const ms = typeof reference === 'string' ? Date.parse(reference) : reference.getTime();
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${String(reference)}`);

  const jst = new Date(ms + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const weekday = jst.getUTCDay();
  const daysSinceStart = (weekday - weekStartsOn + 7) % 7;

  const startDateMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - daysSinceStart * MS_PER_DAY;
  const startUtcMs = startDateMs - JST_OFFSET_MINUTES * MS_PER_MINUTE;

  return {
    startUtc: isoUtc(startUtcMs),
    endUtc: isoUtc(startUtcMs + 7 * MS_PER_DAY),
    startDateJst: new Date(startDateMs).toISOString().slice(0, 10),
    endDateJst: new Date(startDateMs + 6 * MS_PER_DAY).toISOString().slice(0, 10),
  };
}
