/**
 * .ics 日历导出（RFC 5545）。
 *
 * 为什么这个功能值得先做：它是「手机上也能看」成本最低的方案。
 * 生成一次文件导入系统日历，之后不用打开这个软件就能看到更新时间；
 * 比做 PWA、响应式页面、原生 App 都省事得多。
 *
 * 实现要点：
 *   - 时间一律用 UTC（`DTSTART:20261004T153000Z`），由系统日历时区转换，避免我们猜时区。
 *   - 每集一个 VEVENT，UID 稳定（key + 集号），这样**重新导入会更新而不是重复添加**。
 *   - 长行按 75 字节折行（RFC 规定），否则部分日历客户端会解析失败。
 *   - 文本转义：反斜杠、逗号、分号、换行。
 */

import type { ScheduleItem } from './db.ts';

/**
 * 一个待导出的事件。
 *
 * `originalAirAtUtc` 的存在理由：按「日本放送日历」口径导出时，DTSTART 会被回退一天
 * （让事件落在排期表上的那一天），但描述文本里的「日本放送 xx:xx」必须仍是**真实**时刻，
 * 否则会写成「周日 00:00」而实际是「周日 24:00 / 周一 00:00」。
 */
export type IcsEvent = ScheduleItem & {
  originalAirAtUtc?: string;
};

const PRODID = '-//anime-tracker//新番追番日历//CN';

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** "2026-10-04T15:30:00.000Z" → "20261004T153000Z" */
export function toIcsStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`不是合法时间：${iso}`);
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545：每行不超过 75 字节，超出部分以空格开头续行。注意按 UTF-8 字节切，不是字符。 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // 不要把多字节字符切开
    while (end > start && end < bytes.length && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
      end -= 1;
    }
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // 续行首字节是空格，所以少 1
  }
  return chunks.join('\r\n ');
}

/**
 * 用「我追的番」的更新安排生成日历文件。
 *
 * @param items 已应用手动修正的安排（来自 listSchedule）
 * @param options.calendarName 日历名称，显示在系统日历里
 */
export function buildIcs(
  items: readonly IcsEvent[],
  options: { calendarName?: string; now?: Date; includePubTime?: boolean } = {},
): string {
  const { calendarName = '新番追番日历', now = new Date(), includePubTime = true } = options;
  const stamp = toIcsStamp(now.toISOString());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'X-WR-TIMEZONE:Asia/Tokyo',
  ];

  for (const item of items) {
    if (!item.airAtUtc) continue;

    const title = item.titleCn ?? item.titleOriginal ?? item.subjectKey;
    const duration = item.durationMin ?? 24;
    const air = toIcsStamp(item.airAtUtc);
    const end = toIcsStamp(new Date(Date.parse(item.airAtUtc) + duration * 60_000).toISOString());

    const descriptionParts = [
      `第 ${item.epNumber} 话`,
      `日本放送：${formatJstForDescription(item.originalAirAtUtc ?? item.airAtUtc)}`,
      item.pubAtUtc && includePubTime ? `国内可看：${formatCnForDescription(item.pubAtUtc)}` : '',
      item.airSource ? `时刻来源：${item.airSource}` : '',
      item.isOverridden ? '（已手动修正）' : '',
    ].filter(Boolean);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(`${item.subjectKey}-ep${item.epNumber}@anime-tracker`)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${air}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(`${title} 第${item.epNumber}话`)}`,
      `DESCRIPTION:${escapeText(descriptionParts.join('\n'))}`,
      // 刻意不加 ATTACH 封面：长 URL 折行在部分日历客户端上会解析异常，
      // 而系统日历基本也不渲染远程图片 —— 收益小、风险大。
      'BEGIN:VALARM',
      'TRIGGER:-PT30M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`${title} 第${item.epNumber}话 即将更新`)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');

  // 必须用 CRLF，且以 CRLF 结尾
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

function formatJstForDescription(iso: string): string {
  const ms = Date.parse(iso) + 9 * 3_600_000;
  const date = new Date(ms);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getUTCDay()] ?? '';
  return `${date.toISOString().slice(0, 10)} ${weekday} ${date.toISOString().slice(11, 16)} (JST)`;
}

function formatCnForDescription(iso: string): string {
  const ms = Date.parse(iso) + 8 * 3_600_000;
  const date = new Date(ms);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} (CST)`;
}

/** 供界面显示的日历文件建议文件名。 */
export function icsFileName(season: string, now = new Date()): string {
  return `anime-${season}-${now.toISOString().slice(0, 10)}.ics`;
}
