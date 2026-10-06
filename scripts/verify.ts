/**
 * 离线自检 —— 零依赖、单进程，不需要安装任何第三方包。
 *
 *   node scripts/verify.ts
 *
 * 为什么不用 node:test / vitest：
 *   - node:test 会 spawn 子进程并走管道，在受限沙箱里会 EPERM；
 *   - 本项目要保证「clone 下来不装包也能立刻验证核心逻辑」，
 *     因为最容易出错的部分（深夜番归属、补番归档、手动修正优先级）
 *     都是纯逻辑 + 内置 SQLite，完全不需要网络或第三方库。
 *
 * 覆盖范围：
 *   1. 时间与深夜番归属（本项目最容易错的地方）
 *   2. 补番库归档规则
 *   3. 数据库建表、追番/补番读写、手动修正优先级、周视图分组
 *
 * 不覆盖：任何需要联网的部分（数据源抓取）—— 那是 scripts/probe-sources.ts 的职责。
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { remainingEpisodes, shouldArchiveToBacklog } from '../src/core/backlog.ts';
import { datesOfJstWeek, groupByDayJst, padWindow, scheduleDayKeyJst } from '../src/core/calendar.ts';
import type { DayRule } from '../src/core/calendar.ts';
import { decideMachineTranslation, isLatinOnly, isReadableChinese } from '../src/core/mt.ts';
import { mergeSubjects, normalizeTitle } from '../src/core/merge.ts';
import { anilistSeasonId } from '../src/providers/anilist.ts';
import { detectChanges, detectTotalEpsChange } from '../src/server/changes.ts';
import {
  countdown,
  estimateWatchDuration,
  formatInZoneLabeled,
  jstWeekRange,
  parseHhmmJst,
  resolveAiringSlot,
  seasonDateRange,
  seasonFromId,
  seasonOf,
  shiftSeason,
  toLiteralJstTime,
  weekdayInZone,
} from '../src/core/time.ts';
import type { Episode, RawSeasonAnime, Subject } from '../src/core/types.ts';
import {
  acknowledgeChanges,
  addMyAnime,
  applyMachineTitle,
  autoArchiveFinished,
  availableSeasons,
  backupDatabase,
  clearMachineTitle,
  countMachineTitles,
  findSubjectByExternalId,
  getMeta,
  getSubjectDetail,
  getSubjectSeason,
  isMachineTranslatedTitle,
  listChanges,
  listMyAnime,
  listSchedule,
  listSeasonSubjects,
  listTranslationCandidates,
  logChange,
  logChanges,
  migrate,
  openDb,
  pruneBackups,
  repairSeasonAssignments,
  SCHEMA_VERSION,
  searchLocalSubjects,
  seasonSubjectCount,
  seasonSummaries,
  setOverride,
  stats,
  upsertSubject,
} from '../src/server/db.ts';
import { healMachineTitles, archiveSkipDecision, DEFAULT_BACKFILL, resolveArchiveSeasons, translateMissingTitles } from '../src/server/sync.ts';

// ---------------------------------------------------------------------------
// 极简测试骨架
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n      ${message}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${message.split('\n').join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// 测试数据工厂
// ---------------------------------------------------------------------------

function makeEpisode(epNumber: number, airAtUtc?: string): Episode {
  const base: Episode = { epNumber, conflicting: false };
  return airAtUtc === undefined ? base : Object.assign(base, { airAtUtc });
}

function makeSubject(key: string, parts: Partial<Subject> = {}): Subject {
  const base: Subject = {
    key,
    aliases: [],
    mediaType: 'TV',
    studios: [],
    genres: [],
    status: 'airing',
    platforms: [],
    episodes: [],
    sources: ['anilist'],
    fieldSources: {},
    mergedFrom: 1,
    titleCnSource: 'official',
  };
  return Object.assign(base, parts);
}

/** 原始条目（单源），用于验证融合与导入路径。 */
function makeRaw(sourceId: string, parts: Partial<RawSeasonAnime> = {}): RawSeasonAnime {
  const base: RawSeasonAnime = {
    source: 'anilist',
    sourceId,
    aliases: [],
    mediaType: 'TV',
    studios: [],
    genres: [],
    status: 'airing',
    platforms: [],
    episodes: [],
  };
  return Object.assign(base, parts);
}

// ---------------------------------------------------------------------------

console.log(`新番追番日历 · 离线自检`);
console.log(`node ${process.version} · 本机时区偏移 ${-new Date().getTimezoneOffset() / 60} 小时`);

// ---------------------------------------------------------------------------
section('一、字面放送时间解析（「24:30」这类时间）');
// ---------------------------------------------------------------------------

check("'24:30' 解析为字面 24 点、溢出 1 天", () => {
  const parsed = parseHhmmJst('24:30');
  assert.equal(parsed.literalHours, 24);
  assert.equal(parsed.minutes, 30);
  assert.equal(parsed.overflowDays, 1);
  assert.equal(parsed.normalized, '24:30');
});

check("'7:30' 归一化为 '07:30' 且不溢出", () => {
  const parsed = parseHhmmJst('7:30');
  assert.equal(parsed.literalHours, 7);
  assert.equal(parsed.overflowDays, 0);
  assert.equal(parsed.normalized, '07:30');
});

check('全角冒号「24：30」也能解析', () => {
  assert.equal(parseHhmmJst('24：30').literalHours, 24);
});

check("'26:00' / '30:00' 溢出 1 天（分别为次日 02:00 / 06:00）", () => {
  // 有意的上限：字面小时最大 30（= 次日 06:00），所以 overflowDays 只会是 0 或 1。
  // 超过 30 的写法（如 48:30）不是正常放送时间，直接抛错而不是猜。
  assert.equal(parseHhmmJst('26:00').overflowDays, 1);
  assert.equal(parseHhmmJst('30:00').overflowDays, 1);
});

check('非法输入直接抛错，不静默吞掉', () => {
  assert.throws(() => parseHhmmJst('abc'));
  assert.throws(() => parseHhmmJst('24:70'));
  assert.throws(() => parseHhmmJst('99:00'));
});

// ---------------------------------------------------------------------------
section('二、深夜番归属（本项目最容易错的地方）');
// ---------------------------------------------------------------------------

check('日曜 24:30 = 2026-10-04T15:30:00.000Z，放送日历是周日、真实钟点是周一', () => {
  const slot = resolveAiringSlot('2026-10-04', '24:30');
  assert.equal(slot.airAtUtc, '2026-10-04T15:30:00.000Z');
  assert.equal(slot.broadcastDateJst, '2026-10-04');
  assert.equal(slot.broadcastWeekdayJst, 0, '放送日历归属应为周日');
  assert.equal(slot.clockWeekdayJst, 1, '真实钟点归属应为周一');
  assert.equal(slot.clockDateJst, '2026-10-05');
  assert.equal(slot.overflowDays, 1);
});

check('日曜 25:00 = 2026-10-04T16:00:00.000Z', () => {
  assert.equal(resolveAiringSlot('2026-10-04', '25:00').airAtUtc, '2026-10-04T16:00:00.000Z');
});

check('水曜 23:00 不溢出：放送日历与真实钟点都是周三', () => {
  const slot = resolveAiringSlot('2026-10-07', '23:00');
  assert.equal(slot.airAtUtc, '2026-10-07T14:00:00.000Z');
  assert.equal(slot.broadcastWeekdayJst, 3);
  assert.equal(slot.clockWeekdayJst, 3);
  assert.equal(slot.overflowDays, 0);
});

check('「日曜 24:30」与「月曜 00:30」必须收敛到同一时刻', () => {
  assert.equal(
    resolveAiringSlot('2026-10-04', '24:30').airAtUtc,
    resolveAiringSlot('2026-10-05', '00:30').airAtUtc,
  );
});

check('反面教材：拿真实钟点当放送日历用，会整体错位一天', () => {
  const slot = resolveAiringSlot('2026-10-04', '24:30');
  const clockWeekday = weekdayInZone(slot.airAtUtc, 'jst');
  assert.equal(clockWeekday, 1);
  assert.notEqual(clockWeekday, slot.broadcastWeekdayJst);
});

check('展示：JST 下是「周一 00:30」，CST 下是「周日 23:30」', () => {
  const airAt = resolveAiringSlot('2026-10-04', '24:30').airAtUtc;
  assert.equal(formatInZoneLabeled(airAt, 'jst'), '周一 00:30 (JST)');
  assert.equal(formatInZoneLabeled(airAt, 'cn'), '周日 23:30 (CST)');
});

check('从 UTC 时刻反推字面写法：凌晨番还原为「前一天 24:xx」（日本排期表惯例）', () => {
  // bangumi-data 实测样例：R/2026-10-07T15:00:00.000Z/P7D
  const midnight = toLiteralJstTime('2026-10-07T15:00:00.000Z');
  assert.equal(midnight.hhmmJst, '24:00', 'JST 10-08 00:00 应还原为 10-07 的 24:00');
  assert.equal(midnight.broadcastDateJst, '2026-10-07');
  assert.equal(midnight.broadcastWeekdayJst, 3, '2026-10-07 是周三');
  assert.equal(midnight.overflowDays, 1);

  // 晚间正常档不还原
  const evening = toLiteralJstTime('2026-09-05T12:00:00.000Z');
  assert.equal(evening.hhmmJst, '21:00', 'JST 21:00 是正常晚间档，不应加 24');
  assert.equal(evening.overflowDays, 0);
  assert.equal(evening.broadcastWeekdayJst, 6, '2026-09-05 是周六');
});

check('反推与解析互为逆运算（同一时刻往返一致）', () => {
  for (const iso of [
    '2026-10-07T15:00:00.000Z',
    '2026-10-07T15:30:00.000Z',
    '2026-09-05T12:00:00.000Z',
    '2026-10-06T12:25:00.000Z',
  ]) {
    const literal = toLiteralJstTime(iso);
    const back = resolveAiringSlot(literal.broadcastDateJst, literal.hhmmJst);
    assert.equal(back.airAtUtc, iso, `${iso} 往返后应保持一致`);
    assert.equal(back.broadcastWeekdayJst, literal.broadcastWeekdayJst);
  }
});

// ---------------------------------------------------------------------------
section('三、倒计时 / 季度 / 周区间');
// ---------------------------------------------------------------------------

check('倒计时：还有 3 小时', () => {
  const result = countdown('2026-10-04T15:30:00.000Z', new Date('2026-10-04T12:30:00.000Z'));
  assert.equal(result.state, 'upcoming');
  assert.equal(result.text, '3 小时后');
});

check('倒计时：已经更新', () => {
  const result = countdown('2026-10-04T15:30:00.000Z', new Date('2026-10-05T00:00:00.000Z'));
  assert.equal(result.state, 'aired');
  assert.equal(result.text, '已更新');
});

check('季度判定：2026-10-01 属于 2026-10 / 2026秋', () => {
  const season = seasonOf('2026-10-01T00:00:00.000Z');
  assert.equal(season.id, '2026-10');
  assert.equal(season.label, '2026秋');
  assert.equal(season.seasonCn, '秋');
  assert.equal(season.aniList, 'FALL');
});

check('季度判定：跨年边界 2027-01-01 属于 2027-01 / 2027冬', () => {
  const season = seasonOf('2027-01-01T00:00:00.000Z');
  assert.equal(season.id, '2027-01');
  assert.equal(season.aniList, 'WINTER');
});

check('季度日期区间：2026-10 是 10-01 ~ 12-31（不加宽）', () => {
  const range = seasonDateRange('2026-10', 0);
  assert.equal(range.startUtc, '2026-10-01T00:00:00.000Z');
  assert.equal(range.endUtc, '2026-12-31T23:59:59.999Z');
});

check('非法季度 ID 抛错（11 月不是季度起点）', () => {
  assert.throws(() => seasonDateRange('2026-11', 0));
});

check('季度前后推移，跨年正确', () => {
  assert.equal(shiftSeason('2026-10', 1), '2027-01');
  assert.equal(shiftSeason('2026-01', -1), '2025-10');
  assert.equal(shiftSeason('2026-04', 4), '2027-04');
});

check('JST 周区间：2026-10-02（周五）所在周是 09-28 ~ 10-04', () => {
  const week = jstWeekRange('2026-10-02T12:00:00.000Z');
  assert.equal(week.startUtc, '2026-09-27T15:00:00.000Z', '周一 00:00 JST = 周日 15:00 UTC');
  assert.equal(week.endUtc, '2026-10-04T15:00:00.000Z');
  assert.equal(week.startDateJst, '2026-09-28');
  assert.equal(week.endDateJst, '2026-10-04');
});

check('补番时长估算：20 集 × 24 分钟 = 8 小时', () => {
  assert.equal(estimateWatchDuration(20, 24), '8 小时');
  assert.equal(estimateWatchDuration(0, 24), '—');
});

// ---------------------------------------------------------------------------
section('四、日历分组：同一集按两种口径落在不同天');
// ---------------------------------------------------------------------------

check('深夜番：真实钟点归周一，放送日历归周日', () => {
  const item = { airAtUtc: '2026-10-04T15:30:00.000Z', broadcastTimeJst: '24:30' };
  assert.equal(scheduleDayKeyJst(item, 'clock'), '2026-10-05');
  assert.equal(scheduleDayKeyJst(item, 'broadcast-calendar'), '2026-10-04');
});

check('没有字面放送时间时，放送日历口径退化为真实钟点（不猜）', () => {
  const item = { airAtUtc: '2026-10-04T15:30:00.000Z', broadcastTimeJst: null };
  assert.equal(scheduleDayKeyJst(item, 'broadcast-calendar'), '2026-10-05');
});

check('时刻未知的集不归入任何一天', () => {
  assert.equal(scheduleDayKeyJst({ airAtUtc: null }, 'clock'), undefined);
});

check('groupByDayJst 分桶且按时刻排序', () => {
  const buckets = groupByDayJst(
    [
      { airAtUtc: '2026-10-04T16:00:00.000Z', broadcastTimeJst: '25:00' },
      { airAtUtc: '2026-10-04T15:30:00.000Z', broadcastTimeJst: '24:30' },
    ],
    'broadcast-calendar',
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]?.dateJst, '2026-10-04');
  assert.equal(buckets[0]?.items.length, 2);
  assert.equal(buckets[0]?.items[0]?.airAtUtc, '2026-10-04T15:30:00.000Z', '桶内应按放送时刻升序');
  assert.equal(buckets[0]?.weekdayLabel, '周日');
});

check('datesOfJstWeek 返回 7 天', () => {
  const days = datesOfJstWeek('2026-09-28');
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-09-28');
  assert.equal(days[6], '2026-10-04');
});

// ---------------------------------------------------------------------------
section('五、补番库规则');
// ---------------------------------------------------------------------------

check('播完 + 12 集只看了 5 集 -> 进补番库', () => {
  assert.equal(
    shouldArchiveToBacklog({ status: 'finished', totalEps: 12, watchedEps: 5, category: 'tracking' }),
    true,
  );
});

check('一集没看 -> 不动（那是「想看」，不是「没看完」）', () => {
  assert.equal(
    shouldArchiveToBacklog({ status: 'finished', totalEps: 12, watchedEps: 0, category: 'tracking' }),
    false,
  );
});

check('已经播完且看完 -> 不进补番库', () => {
  assert.equal(
    shouldArchiveToBacklog({ status: 'finished', totalEps: 12, watchedEps: 12, category: 'tracking' }),
    false,
  );
});

check('还在放送中 -> 不动', () => {
  assert.equal(
    shouldArchiveToBacklog({ status: 'airing', totalEps: 12, watchedEps: 5, category: 'tracking' }),
    false,
  );
});

check('总集数未知 -> 不动（不能靠猜迁移）', () => {
  assert.equal(
    shouldArchiveToBacklog({ status: 'finished', totalEps: undefined, watchedEps: 5, category: 'tracking' }),
    false,
  );
});

check('剩余集数：知道总集数才算，不知道返回 undefined', () => {
  assert.equal(remainingEpisodes(12, 5), 7);
  assert.equal(remainingEpisodes(12, 12), 0);
  assert.equal(remainingEpisodes(undefined, 5), undefined);
});

// ---------------------------------------------------------------------------
section('六、数据库：建表 / 追番 / 补番自动归档');
// ---------------------------------------------------------------------------

const db = openDb(':memory:');
migrate(db);

check('建表成功并写入 schema 版本', () => {
  assert.equal(getMeta(db, 'schema_version'), String(SCHEMA_VERSION));
});

// bgm:1 播完但没看完（应自动进补番库）
const notFinished = makeSubject('bgm:1', {
  titleCn: '没看完的番',
  status: 'finished',
  totalEps: 12,
  episodes: Array.from({ length: 12 }, (_, i) =>
    makeEpisode(i + 1, new Date(Date.UTC(2026, 6, 1 + i * 7, 15, 0)).toISOString()),
  ),
});
// bgm:2 播完且看完（应自动标记已看完）
const fullyWatched = makeSubject('bgm:2', { titleCn: '看完的番', status: 'finished', totalEps: 12 });
// bgm:3 还在放送中（不动）
const stillAiring = makeSubject('bgm:3', {
  titleCn: '在播的番',
  status: 'airing',
  totalEps: 12,
  episodes: [makeEpisode(1, '2026-09-30T14:00:00.000Z')],
});
// bgm:4 深夜番，跨周边界（日历分组要用）
const deepNight = makeSubject('bgm:4', {
  titleCn: '深夜番',
  status: 'airing',
  totalEps: 12,
  broadcastWeekdayJst: 0,
  broadcastTimeJst: '24:30',
  episodes: [makeEpisode(2, '2026-09-27T15:30:00.000Z'), makeEpisode(3, '2026-10-04T15:30:00.000Z')],
});
// bgm:9 手动加入补番库的老番
const oldAnime = makeSubject('bgm:9', { titleCn: '老番', status: 'finished', totalEps: 24, durationMin: 24 });

check('写入 5 部番与其分集', () => {
  for (const subject of [notFinished, fullyWatched, stillAiring, deepNight, oldAnime]) {
    upsertSubject(db, subject, subject.status === 'finished' ? null : '2026-10');
  }
  const summary = stats(db);
  assert.equal(summary.subjects, 5);
  assert.equal(summary.episodes, 15, '12 + 0 + 1 + 2 + 0 = 15');
});

check('加入追番：4 部在追番中，1 部手动放进补番库', () => {
  addMyAnime(db, 'bgm:1', { watchedEps: 5 });
  addMyAnime(db, 'bgm:2', { watchedEps: 12 });
  addMyAnime(db, 'bgm:3', { watchedEps: 3 });
  addMyAnime(db, 'bgm:4', { watchedEps: 2 });
  addMyAnime(db, 'bgm:9', { category: 'backlog', watchedEps: 7, priority: 5 });

  const summary = stats(db);
  assert.equal(summary.tracking, 4);
  assert.equal(summary.backlog, 1);
});

// 归档只跑一次，两个断言共用同一份结果：
// 第二次调用会返回空，因为状态已经迁移过了（这正是下面要验证的幂等性）。
const archiveResult = autoArchiveFinished(db);

check('自动归档：播完没看完 -> 补番库', () => {
  assert.deepEqual(archiveResult.toBacklog, ['bgm:1']);
});

check('自动归档：播完且看完 -> 已看完', () => {
  assert.deepEqual(archiveResult.toFinished, ['bgm:2']);
});

check('自动归档：在播中的两部完全不动', () => {
  assert.equal(listMyAnime(db, 'tracking').map((i) => i.subjectKey).sort().join(','), 'bgm:3,bgm:4');
});

check('自动归档可重复执行（幂等）', () => {
  const result = autoArchiveFinished(db);
  assert.deepEqual(result.toBacklog, []);
  assert.deepEqual(result.toFinished, []);
});

check('补番库查询：手动加入的与自动归档的都在里面', () => {
  const backlog = listMyAnime(db, 'backlog');
  assert.deepEqual(
    backlog.map((i) => i.subjectKey).sort(),
    ['bgm:1', 'bgm:9'],
  );
});

check('补番库剩余集数：老番 24 集看了 7 集 -> 还剩 17 集', () => {
  const item = listMyAnime(db, 'backlog').find((i) => i.subjectKey === 'bgm:9');
  assert.equal(item?.totalEps, 24);
  assert.equal(remainingEpisodes(item?.totalEps ?? undefined, item?.watchedEps ?? 0), 17);
});

check('数据库统计正确', () => {
  const summary = stats(db);
  assert.equal(summary.subjects, 5);
  assert.equal(summary.tracking, 2);
  assert.equal(summary.backlog, 2);
  assert.equal(summary.finished, 1);
  assert.equal(summary.dropped, 0);
});

// ---------------------------------------------------------------------------
section('七、周视图查询：加宽窗口 + 两种归属口径');
// ---------------------------------------------------------------------------

const week = jstWeekRange('2026-10-02T12:00:00.000Z');
const padded = padWindow(week.startUtc, week.endUtc);
const rows = listSchedule(db, padded.startUtc, padded.endUtc);
const weekDays = new Set(datesOfJstWeek(week.startDateJst));

function itemsOfWeek(rule: DayRule, subjectKey: string): number[] {
  return groupByDayJst(rows, rule)
    .filter((bucket) => weekDays.has(bucket.dateJst))
    .flatMap((bucket) => bucket.items)
    .filter((item) => item.subjectKey === subjectKey)
    .map((item) => item.epNumber)
    .sort((a, b) => a - b);
}

check('加宽窗口把跨周边界的深夜番两集都捞出来了', () => {
  const eps = rows
    .filter((r) => r.subjectKey === 'bgm:4')
    .map((r) => r.epNumber)
    .sort((a, b) => a - b);
  assert.deepEqual(eps, [2, 3]);
});

check('按真实钟点：09-28 00:30 那集在本周，10-05 00:30 那集在下周', () => {
  assert.deepEqual(itemsOfWeek('clock', 'bgm:4'), [2]);
});

check('按放送日历：10-04 那集在本周，09-27 那集属于上周', () => {
  assert.deepEqual(itemsOfWeek('broadcast-calendar', 'bgm:4'), [3]);
});

check('两种口径的结果必须不同（否则说明归属逻辑没生效）', () => {
  assert.notDeepEqual(itemsOfWeek('clock', 'bgm:4'), itemsOfWeek('broadcast-calendar', 'bgm:4'));
});

// ---------------------------------------------------------------------------
section('八、手动修正的优先级与变更日志');
// ---------------------------------------------------------------------------

check('手动修正覆盖抓取到的时间，并标记 isOverridden', () => {
  setOverride(db, 'bgm:3', 1, { airAtUtc: '2026-10-01T14:00:00.000Z', reason: '自检' });
  const item = listSchedule(db, '2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z', {
    category: 'tracking',
  }).find((r) => r.subjectKey === 'bgm:3' && r.epNumber === 1);

  assert.equal(item?.airAtUtc, '2026-10-01T14:00:00.000Z', '应使用手动修正后的时刻');
  assert.equal(item?.isOverridden, true);
});

check('变更日志可写入并读出（延期提醒的数据基础）', () => {
  logChange(db, {
    subjectKey: 'bgm:4',
    epNumber: 3,
    field: 'airAtUtc',
    oldValue: '2026-10-04T15:30:00.000Z',
    newValue: '2026-10-11T15:30:00.000Z',
  });
  const changes = listChanges(db);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.field, 'airAtUtc');
  assert.equal(changes[0]?.acknowledged, false);
  assert.equal(stats(db).pendingChanges, 1);
});

// ---------------------------------------------------------------------------
section('九、延期 / 改档检测');
// ---------------------------------------------------------------------------

// 先造一部「上一轮同步过」的番
const changeBase = makeSubject('bgm:chg1', {
  titleCn: '改档测试番',
  status: 'airing',
  totalEps: 12,
  episodes: [
    makeEpisode(1, '2026-10-06T13:00:00.000Z'),
    makeEpisode(2, '2026-10-13T13:00:00.000Z'),
    makeEpisode(3, '2026-10-20T13:00:00.000Z'),
  ],
});
const changeAired = (subject: Subject, source: 'anilist' | 'yuc' | 'bangumi-data' = 'anilist'): Subject =>
  Object.assign({}, subject, {
    episodes: subject.episodes.map((episode) => ({ ...episode, airSource: source })),
  });

check('第一次见到某部番时，不产生任何变更记录', () => {
  const empty = openDb(':memory:');
  migrate(empty);
  assert.deepEqual(detectChanges(empty, changeAired(changeBase)), []);
  empty.close();
});

check('同一数据源下时间被推迟 -> 报「延期」', () => {
  upsertSubject(db, changeAired(changeBase), '2026-10');
  const shifted = Object.assign({}, changeAired(changeBase), {
    episodes: [
      makeEpisode(1, '2026-10-06T13:00:00.000Z'),
      makeEpisode(2, '2026-10-13T13:00:00.000Z'),
      makeEpisode(3, '2026-10-27T13:00:00.000Z'), // 10/20 -> 10/27
    ].map((episode) => ({ ...episode, airSource: 'anilist' as const })),
  });

  const changes = detectChanges(db, shifted);
  const delayed = changes.filter((change) => change.kind === 'delayed');
  assert.equal(delayed.length, 1, `期望 1 条延期，实际 ${delayed.length} 条`);
  assert.equal(delayed[0]?.epNumber, 3);
  assert.match(delayed[0]?.message ?? '', /延期/);
  assert.match(delayed[0]?.message ?? '', /7 天/);
});

check('时间被提前 -> 报「提前」，不是延期', () => {
  const earlier = Object.assign({}, changeAired(changeBase), {
    episodes: [makeEpisode(1, '2026-10-06T13:00:00.000Z'), makeEpisode(2, '2026-10-11T13:00:00.000Z'), makeEpisode(3, '2026-10-20T13:00:00.000Z')].map(
      (episode) => ({ ...episode, airSource: 'anilist' as const }),
    ),
  });
  const changes = detectChanges(db, earlier);
  assert.equal(changes.filter((change) => change.kind === 'advanced').length, 1);
  assert.match(changes.find((change) => change.kind === 'advanced')?.message ?? '', /提前/);
});

check('假变更被过滤：新值来自优先级更低的源时不报警', () => {
  // 库里是 anilist 的时刻，这次只因 anilist 失败而落到 yuc 上（时间略有不同）
  const fromWeakerSource = Object.assign({}, changeAired(changeBase), {
    episodes: changeBase.episodes.map((episode) => ({
      ...episode,
      airAtUtc: new Date(Date.parse(episode.airAtUtc ?? '') + 5 * 60_000).toISOString(),
      airSource: 'yuc' as const,
    })),
  });
  assert.deepEqual(detectChanges(db, fromWeakerSource), [], '源优先级更低时不应产生变更');
});

check('但同一时刻若来自优先级更高的源，则允许记录（会进入 fieldSources 审计）', () => {
  const fromStrongerSource = Object.assign({}, changeAired(changeBase, 'yuc'), {
    episodes: changeBase.episodes.map((episode) => ({
      ...episode,
      airAtUtc: new Date(Date.parse(episode.airAtUtc ?? '') + 5 * 60_000).toISOString(),
      airSource: 'anilist' as const,
    })),
  });
  const changes = detectChanges(db, fromStrongerSource);
  assert.equal(changes.length, 3, `更高优先级源带来的差异应当被记录，实际 ${changes.length} 条`);
});

check('小于阈值的差异被忽略（避免秒级抖动刷屏）', () => {
  const tiny = Object.assign({}, changeAired(changeBase), {
    episodes: changeBase.episodes.map((episode) => ({
      ...episode,
      airAtUtc: new Date(Date.parse(episode.airAtUtc ?? '') + 30_000).toISOString(),
      airSource: 'anilist' as const,
    })),
  });
  assert.deepEqual(detectChanges(db, tiny), [], '30 秒的差异不该报警');
});

check('分集从数据源消失 -> 报「排期消失」', () => {
  const removed = Object.assign({}, changeAired(changeBase), {
    episodes: [makeEpisode(1, '2026-10-06T13:00:00.000Z'), makeEpisode(2, '2026-10-13T13:00:00.000Z')].map(
      (episode) => ({ ...episode, airSource: 'anilist' as const }),
    ),
  });
  const changes = detectChanges(db, removed);
  const gone = changes.filter((change) => change.kind === 'episode-removed');
  assert.equal(gone.length, 1);
  assert.equal(gone[0]?.epNumber, 3);
});

check('新增分集聚合成一条，而不是每集一条', () => {
  const expanded = Object.assign({}, changeAired(changeBase), {
    episodes: [
      makeEpisode(1, '2026-10-06T13:00:00.000Z'),
      makeEpisode(2, '2026-10-13T13:00:00.000Z'),
      makeEpisode(3, '2026-10-20T13:00:00.000Z'),
      makeEpisode(4, '2026-10-27T13:00:00.000Z'),
      makeEpisode(5, '2026-11-03T13:00:00.000Z'),
    ].map((episode) => ({ ...episode, airSource: 'anilist' as const })),
  });
  const changes = detectChanges(db, expanded);
  const added = changes.filter((change) => change.kind === 'episode-added');
  assert.equal(added.length, 1, `期望聚合成 1 条，实际 ${added.length} 条`);
  assert.match(added[0]?.message ?? '', /第 4~5 话/);
  assert.match(added[0]?.message ?? '', /共 2 集/);
});

check('集数变化：未知变已知不算改档，已知值变化才算', () => {
  const unknownBefore = Object.assign({}, changeAired(changeBase));
  assert.equal(detectTotalEpsChange(db, unknownBefore), null, '集数没变就不该报');

  const grown = Object.assign({}, changeAired(changeBase), { totalEps: 13 });
  const change = detectTotalEpsChange(db, grown);
  assert.ok(change, '集数由 12 变 13 应当被检出');
  assert.equal(change?.kind, 'total-eps-changed');
  assert.match(change?.message ?? '', /12 变为 13/);
});

check('变更写入 change_log 后可读出，并带番剧名与种类', () => {
  const before = listChanges(db).length;
  const shifted = Object.assign({}, changeAired(changeBase), {
    episodes: [
      makeEpisode(1, '2026-10-06T13:00:00.000Z'),
      makeEpisode(2, '2026-10-13T13:00:00.000Z'),
      makeEpisode(3, '2026-11-10T13:00:00.000Z'),
    ].map((episode) => ({ ...episode, airSource: 'anilist' as const })),
  });
  const changes = detectChanges(db, shifted);
  logChanges(
    db,
    changes.map((entry) => ({
      subjectKey: entry.subjectKey,
      epNumber: entry.epNumber,
      field: entry.field,
      kind: entry.kind,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
    })),
  );

  const all = listChanges(db, 100);
  assert.equal(all.length, before + changes.length);
  const latest = all[0];
  assert.equal(latest?.title, '改档测试番', 'listChanges 应当 JOIN 出番剧名');
  assert.equal(latest?.kind, 'delayed');
});

check('确认变更后不再出现在待处理列表里', () => {
  const pending = listChanges(db).length;
  assert.ok(pending > 0, '应当有待处理变更');
  const acknowledged = acknowledgeChanges(db);
  assert.equal(acknowledged, pending);
  assert.equal(listChanges(db).length, 0);
  assert.equal(stats(db).pendingChanges, 0);
});

// ---------------------------------------------------------------------------
section('十、临时机翻译名：该不该翻');
// ---------------------------------------------------------------------------

check('已有官方中文名 -> 不翻（官方名优先，翻了也会被覆盖）', () => {
  const decision = decideMachineTranslation({
    titleCn: '药屋少女的呢喃',
    titleCnSource: 'official',
    titleOriginal: '薬屋のひとりごと',
  });
  assert.equal(decision.translate, false);
  assert.match(decision.reason, /官方中文名/);
});

check('已经有临时机翻名 -> 不翻（不浪费接口额度，重翻也不会更好）', () => {
  const decision = decideMachineTranslation({
    titleCn: '马森楚',
    titleCnSource: 'machine',
    titleOriginal: 'マゼンチュ',
  });
  assert.equal(decision.translate, false);
  assert.match(decision.reason, /临时机翻/);
});

check('缺中文名 + 日文原名含假名 -> 翻', () => {
  const decision = decideMachineTranslation({ titleCn: null, titleOriginal: 'メイドインアビス 目覚める神秘' });
  assert.equal(decision.translate, true);
});

check('缺中文名 + 纯汉字无假名 -> 不翻（本身就是可读中文，翻了是信息损失）', () => {
  // 「夏日 The Animation」是实测样例：机翻会变成「夏日 动画」，反而更差。
  // 注意判据是「有汉字且无假名」：一旦出现片假名/平假名（如 装甲騎兵ボトムズ），
  // 那就是明确的日文标题，必须翻 —— 下面那条检查专门守住这个边界。
  for (const original of ['魔法使之夜', '夏日', '夏日 The Animation']) {
    const decision = decideMachineTranslation({ titleCn: null, titleOriginal: original });
    assert.equal(decision.translate, false, `${original} 不该被机翻`);
  }
});

check('同一个标题只要有假名就翻（哪怕汉字很多）', () => {
  // 实测样例：装甲騎兵ボトムズ 里「ボトムズ」是片假名 -> 是日文，该翻
  for (const original of ['装甲騎兵ボトムズ 灰色の魔女', 'マゼンチュ', '姉モネ']) {
    assert.equal(
      decideMachineTranslation({ titleCn: null, titleOriginal: original }).translate,
      true,
      `${original} 含假名，应当机翻`,
    );
  }
});

check('缺中文名 + 纯拉丁原名 -> 不翻（保留原样比机翻更可读）', () => {
  for (const original of ['DARK MACHINE THE ANIMATION', 'dreamland', 'Delivery Kitten Unyan']) {
    assert.equal(isLatinOnly(original), true, `${original} 应被判定为纯拉丁`);
    const decision = decideMachineTranslation({ titleCn: null, titleOriginal: original });
    assert.equal(decision.translate, false, `${original} 不该被机翻`);
  }
});

check('汉字判定：混了假名就不是「可读中文」', () => {
  assert.equal(isReadableChinese('夏日'), true);
  assert.equal(isReadableChinese('夏日 The Animation'), true);
  assert.equal(isReadableChinese('魔法使いの夜'), false, '含假名，需要机翻');
  assert.equal(isReadableChinese('DARK MACHINE'), false);
});

check('没有原名也没有英文名 -> 不翻（没东西可翻）', () => {
  const decision = decideMachineTranslation({ titleCn: null });
  assert.equal(decision.translate, false);
  assert.match(decision.reason, /没有可翻译/);
});

check('中文名是空字符串时按「缺名字」处理，不算已有官方名', () => {
  const decision = decideMachineTranslation({ titleCn: '   ', titleOriginal: 'マゼンチュ' });
  assert.equal(decision.translate, true);
});

// ---------------------------------------------------------------------------
section('十一、临时机翻译名：写入与替换（官方名永远优先）');
// ---------------------------------------------------------------------------

// 单独的库：这一节会频繁改 title_cn，不该污染上面的断言
const mtDb = openDb(':memory:');
migrate(mtDb);

const mtSubject = makeSubject('bgm:mt1', {
  titleOriginal: 'マゼンチュ',
  titleCn: undefined,
  status: 'upcoming',
  totalEps: 12,
});
upsertSubject(mtDb, mtSubject, '2026-10');

check('写入时不需要机翻字段也能建库（历史数据的兼容路径）', () => {
  const ref = findSubjectByExternalId(mtDb, { bgmId: mtSubject.bgmId });
  // mtSubject 没有 bgmId，用 key 路径验证
  const detail = getSubjectDetail(mtDb, 'bgm:mt1');
  assert.ok(detail, '条目没写进去');
  assert.equal(detail.titleCn, null);
  assert.equal(detail.titleCnSource, 'official', '没有机翻标记时应视为官方名');
  assert.equal(ref, undefined, '没有外部 ID 时不该被按 ID 查到');
});

check('机翻名写入 title_cn，并把原名并进 aliases（保证原名仍能搜到）', () => {
  const applied = applyMachineTitle(mtDb, 'bgm:mt1', '马森楚');
  assert.equal(applied, true);

  const detail = getSubjectDetail(mtDb, 'bgm:mt1');
  assert.equal(detail?.titleCn, '马森楚');
  assert.equal(detail?.titleCnSource, 'machine', '必须标记为 machine，UI 才能提示「临时机翻」');
  assert.ok(detail?.titleCnSourceAt, '应当记录机翻时刻');
  assert.ok(detail?.aliases.includes('マゼンチュ'), '原名必须进别名，否则机翻名一写就搜不到原名');

  // 机翻名不能伪装成官方来源
  assert.equal(detail?.fieldSources.titleCn, undefined, '机翻名不得进入 fieldSources');
});

check('用原名与机翻名都能搜到同一部番', () => {
  const byOriginal = searchLocalSubjects(mtDb, 'マゼンチュ');
  const byMachine = searchLocalSubjects(mtDb, '马森楚');
  assert.ok(byOriginal.some((item) => item.key === 'bgm:mt1'), '用原名搜不到');
  assert.ok(byMachine.some((item) => item.key === 'bgm:mt1'), '用机翻名搜不到');
});

check('重复写入机翻名会被拒绝（不浪费额度，也不重复刷时间戳）', () => {
  const again = applyMachineTitle(mtDb, 'bgm:mt1', '马森处');
  assert.equal(again, false, '已有中文名时不该再次写入（官方名与机翻名都不重写）');
  assert.equal(getSubjectDetail(mtDb, 'bgm:mt1')?.titleCn, '马森楚');
});

check('官方中文名到达 -> 覆盖机翻名，并把出处改回 official（用户要的语义）', () => {
  const official = Object.assign({}, mtSubject, { titleCn: '马森丘', titleCnSource: 'official' as const });
  upsertSubject(mtDb, official, '2026-10');

  const detail = getSubjectDetail(mtDb, 'bgm:mt1');
  assert.equal(detail?.titleCn, '马森丘', '官方名必须覆盖机翻名');
  assert.equal(detail?.titleCnSource, 'official', '出处必须改回 official');
  assert.equal(isMachineTranslatedTitle(mtDb, 'bgm:mt1'), false);
  assert.equal(countMachineTitles(mtDb), 0);
});

check('官方名已存在时，机翻名不得覆盖它（硬规则）', () => {
  const applied = applyMachineTitle(mtDb, 'bgm:mt1', '乱七八糟');
  assert.equal(applied, false);
  assert.equal(getSubjectDetail(mtDb, 'bgm:mt1')?.titleCn, '马森丘');
});

check('同步时官方中文名缺失不会清掉已有中文名（否则就成了「记录消失」）', () => {
  // 造一条：有官方名 -> 做一次 titleCn 为空的同步
  const noOfficial = Object.assign({}, mtSubject, { titleCn: undefined, titleCnSource: 'official' as const });
  upsertSubject(mtDb, noOfficial, '2026-10');
  assert.equal(
    getSubjectDetail(mtDb, 'bgm:mt1')?.titleCn,
    '马森丘',
    'titleCn 为空的新值不应清掉库里的中文名（PRESERVE_WHEN_EMPTY）',
  );
});

check('同步不得把机翻名的出处改回 official（否则 UI 再也提示不出「临时机翻」）', () => {
  // 实测踩到的坑：SubjectSchema 的 titleCnSource 默认是 'official'，
  // 而融合结果在 titleCn 为空时仍带着这个默认值。如果 UPSERT 直接写它，
  // 一次普通同步就会把 34 条机翻名全部「洗」成 official。
  const fresh = makeSubject('bgm:mt9', { titleOriginal: 'マゼンチュ9', status: 'upcoming' });
  upsertSubject(mtDb, fresh, '2026-10');
  assert.equal(applyMachineTitle(mtDb, 'bgm:mt9', '马森楚九'), true);
  const before = getSubjectDetail(mtDb, 'bgm:mt9');
  assert.equal(before?.titleCnSource, 'machine');

  // 模拟一次当季同步：融合结果里没有官方中文名（titleCn 为空，但 schema 默认 official）
  upsertSubject(mtDb, Object.assign({}, fresh, { titleCn: undefined, titleCnSource: 'official' as const }), '2026-10');

  const after = getSubjectDetail(mtDb, 'bgm:mt9');
  assert.equal(after?.titleCn, '马森楚九', '机翻名不该被清掉');
  assert.equal(after?.titleCnSource, 'machine', '机翻名的出处必须保住 machine');
  assert.equal(countMachineTitles(mtDb, '2026-10') >= 1, true, '机翻名统计应当仍然数得到它');

  // 而官方名一到，出处必须变回 official
  upsertSubject(mtDb, Object.assign({}, fresh, { titleCn: '官方译名' }), '2026-10');
  const healedDetail = getSubjectDetail(mtDb, 'bgm:mt9');
  assert.equal(healedDetail?.titleCn, '官方译名');
  assert.equal(healedDetail?.titleCnSource, 'official', '官方名到达后出处应为 official');
});

check('机翻名的清理：clearMachineTitle 只动机翻名', () => {
  const fresh = makeSubject('bgm:mt2', { titleOriginal: 'マゼンチュ2', status: 'upcoming' });
  upsertSubject(mtDb, fresh, '2026-10');
  assert.equal(applyMachineTitle(mtDb, 'bgm:mt2', '马森楚二号'), true);
  assert.equal(clearMachineTitle(mtDb, 'bgm:mt2'), true);
  assert.equal(getSubjectDetail(mtDb, 'bgm:mt2')?.titleCn, null);

  // 官方名不受 clearMachineTitle 影响
  assert.equal(clearMachineTitle(mtDb, 'bgm:mt1'), false, '官方名不该被当成机翻名清掉');
  assert.equal(getSubjectDetail(mtDb, 'bgm:mt1')?.titleCn, '马森丘');
});

check('候选列表只挑该翻的，跳过纯拉丁与已有中文名的', () => {
  const latin = makeSubject('bgm:mt3', { titleOriginal: 'DARK MACHINE THE ANIMATION', status: 'upcoming' });
  const kana = makeSubject('bgm:mt4', { titleOriginal: 'タコピーの原罪', status: 'upcoming' });
  upsertSubject(mtDb, latin, '2026-10');
  upsertSubject(mtDb, kana, '2026-10');

  const candidates = listTranslationCandidates(mtDb, { season: '2026-10' });
  const keys = candidates.map((item) => item.key);
  assert.ok(keys.includes('bgm:mt4'), '含假名的该进候选');
  assert.ok(!keys.includes('bgm:mt3'), '纯拉丁不该进候选');
  assert.ok(!keys.includes('bgm:mt1'), '已有官方中文名的不该进候选');

  // includeSkipped 要能说明「为什么不翻」，交付时可以直接展示
  const withSkipped = listTranslationCandidates(mtDb, { season: '2026-10', includeSkipped: true });
  const skipped = withSkipped.find((item) => item.key === 'bgm:mt3');
  assert.ok(skipped?.skipReason, '被跳过的条目应当带原因');
  assert.match(skipped.skipReason, /纯拉丁/);
});

check('官方译名在库里别处出现时，机翻名被替换掉（healMachineTitles）', () => {
  // 模拟实测发现的「假重复」：同一部番两条记录，一条有官方中文名、一条只有机翻名
  const withBgm = makeSubject('bgm:9001', { titleOriginal: 'ロメリア戦記', bgmId: 9001, status: 'airing' });
  upsertSubject(mtDb, withBgm, '2026-10');
  const dup = makeSubject('anilist:9001', {
    titleOriginal: 'ロメリア戦記 〜魔王を倒した後も〜',
    anilistId: 9001,
    status: 'airing',
  });
  upsertSubject(mtDb, dup, '2026-10');
  assert.equal(applyMachineTitle(mtDb, 'anilist:9001', '罗梅莉亚战记'), true);

  // 让两条记录共享同一个 bgmId 锚点（真实场景里就是跨源 ID 把它们关联起来）
  mtDb.prepare('UPDATE subject SET bgm_id = 9001 WHERE key = ?').run('anilist:9001');
  mtDb.prepare("UPDATE subject SET title_cn = '罗梅莉亚战记', title_cn_source = 'official' WHERE key = 'bgm:9001'").run();

  const healed = healMachineTitles(mtDb);
  assert.ok(healed.replaced >= 1, `应当替换掉机翻名，实际 replaced=${healed.replaced}`);
  const detail = getSubjectDetail(mtDb, 'anilist:9001');
  assert.equal(detail?.titleCn, '罗梅莉亚战记');
  assert.equal(detail?.titleCnSource, 'official', '替换后出处必须是 official');
});

mtDb.close();

// ---------------------------------------------------------------------------
section('十二、自动归档要「可见」：必须带上番名');
// ---------------------------------------------------------------------------

const archDb = openDb(':memory:');
migrate(archDb);

const archSubject = makeSubject('bgm:arch1', { titleCn: '播完没看完的番', status: 'finished', totalEps: 12 });
upsertSubject(archDb, archSubject, null);
addMyAnime(archDb, 'bgm:arch1', { watchedEps: 3 });

check('自动归档返回被移动的番名（用户诉求 5：否则看起来就是记录消失）', () => {
  const result = autoArchiveFinished(archDb);
  assert.deepEqual(result.toBacklog, ['bgm:arch1'], '旧的 key 列表要保持兼容');
  assert.equal(result.moved.length, 1, 'moved 明细必须有');
  const moved = result.moved[0];
  assert.ok(moved, '缺少 moved 明细');
  assert.equal(moved.key, 'bgm:arch1');
  assert.equal(moved.title, '播完没看完的番', '必须给出番名，只给内部 key 用户看不懂');
  assert.equal(moved.to, 'backlog');
});

check('只有 titleOriginal 时，moved.title 退化为原名而不是 key', () => {
  const original = makeSubject('bgm:arch2', { titleOriginal: 'オリジナルタイトル', status: 'finished', totalEps: 12 });
  upsertSubject(archDb, original, null);
  addMyAnime(archDb, 'bgm:arch2', { watchedEps: 1 });
  const result = autoArchiveFinished(archDb);
  const moved = result.moved.find((item) => item.key === 'bgm:arch2');
  assert.equal(moved?.title, 'オリジナルタイトル');
});

check('归档幂等：再跑一次不再产生任何移动', () => {
  const result = autoArchiveFinished(archDb);
  assert.deepEqual(result.moved, []);
});

archDb.close();

// ---------------------------------------------------------------------------
section('十三、历史季度保留与统计');
// ---------------------------------------------------------------------------

const seasonDb = openDb(':memory:');
migrate(seasonDb);

check('可用的季度列表按从新到旧排列，且排除 NULL', () => {
  upsertSubject(seasonDb, makeSubject('bgm:s1', { titleCn: '夏季番' }), '2026-07');
  upsertSubject(seasonDb, makeSubject('bgm:s2', { titleCn: '秋季番' }), '2026-10');
  upsertSubject(seasonDb, makeSubject('bgm:s3', { titleCn: '无季度番' }), null);

  assert.deepEqual(availableSeasons(seasonDb), ['2026-10', '2026-07']);
  assert.equal(seasonSubjectCount(seasonDb, '2026-10'), 1);
  assert.equal(seasonSubjectCount(seasonDb, '2026-07'), 1);
  assert.equal(seasonSubjectCount(seasonDb, '2026-04'), 0);
});

check('同步新季度不会删掉旧季度（「过季就丢」不会发生）', () => {
  upsertSubject(seasonDb, makeSubject('bgm:s4', { titleCn: '下一个冬季番' }), '2027-01');
  assert.deepEqual(availableSeasons(seasonDb), ['2027-01', '2026-10', '2026-07']);
  assert.equal(seasonSubjectCount(seasonDb, '2026-07'), 1, '旧季度必须还在');
});

check('季度统计给出每季的部数与集数', () => {
  const summaries = seasonSummaries(seasonDb);
  const autumn = summaries.find((item) => item.season === '2026-10');
  assert.ok(autumn, '缺少 2026-10 的统计');
  assert.equal(autumn.subjects, 1);
  assert.ok(autumn.subjects > 0);
  // 排序：新的在前
  assert.equal(summaries[0]?.season, '2027-01');
});

check('listSeasonSubjects 会带上 titleCnSource（UI 要据此标「临时机翻」）', () => {
  // 用一部**没有**中文名的番，否则 applyMachineTitle 会按规则拒绝写入
  upsertSubject(seasonDb, makeSubject('bgm:s5', { titleOriginal: 'マゼンチュ' }), '2026-10');

  const before = listSeasonSubjects(seasonDb, '2026-10').find((item) => item.key === 'bgm:s5');
  assert.equal(before?.titleCn, null);
  assert.equal(before?.titleCnSource, 'official', '没有中文名时默认视为 official');

  assert.equal(applyMachineTitle(seasonDb, 'bgm:s5', '马森楚'), true);
  const after = listSeasonSubjects(seasonDb, '2026-10');
  const target = after.find((item) => item.key === 'bgm:s5');
  assert.equal(target?.titleCn, '马森楚');
  assert.equal(target?.titleCnSource, 'machine');

  // 已带官方中文名的条目必须仍是 official
  const official = after.find((item) => item.key === 'bgm:s2');
  assert.equal(official?.titleCnSource, 'official');
});

// 独立的库：季度归属的断言依赖「库里原本有什么」，用干净的环境才说得清
const seasonGuardDb = openDb(':memory:');
migrate(seasonGuardDb);

check('回填旧季度不得把当季条目的 season 抢走（实测过的真回归）', () => {
  // 复现场景：一部 10 月才开播的番先被当季同步落库（season=2026-10），
  // 之后回填 7 月时，AniList 的"上一季"结果里**也**包含它。
  // 无条件写 season 会把它改成 2026-07，当季总览就凭空少了一批。
  const october = makeSubject('bgm:cross1', {
    titleCn: '十月才开播的番',
    firstAirAtUtc: '2026-10-07T15:00:00.000Z',
    episodes: [makeEpisode(1, '2026-10-07T15:00:00.000Z')],
  });
  upsertSubject(seasonGuardDb, october, '2026-10');
  assert.equal(seasonSubjectCount(seasonGuardDb, '2026-10'), 1, '当季应有 1 部');

  // 回填 7 月，同一个 key 又来了
  upsertSubject(seasonGuardDb, october, '2026-07');
  assert.equal(seasonSubjectCount(seasonGuardDb, '2026-07'), 0, '2026-07 不该多出这一部');
  assert.equal(seasonSubjectCount(seasonGuardDb, '2026-10'), 1, '当季条目必须还在');
  assert.ok(
    listSeasonSubjects(seasonGuardDb, '2026-10').some((item) => item.key === 'bgm:cross1'),
    '这部番必须仍在 2026-10 里',
  );
});

check('季度归属按条目自己的时刻纠正（错的归属要能改回来）', () => {
  // 库里已经有一条被写错季度的（首播其实在 4 月，却声称属于 7 月）
  const wrong = makeSubject('bgm:cross2', {
    titleCn: '被写错季度的番',
    firstAirAtUtc: '2026-04-10T15:00:00.000Z',
    episodes: [makeEpisode(1, '2026-04-10T15:00:00.000Z')],
  });
  upsertSubject(seasonGuardDb, wrong, '2026-07');
  assert.equal(
    listSeasonSubjects(seasonGuardDb, '2026-07').some((item) => item.key === 'bgm:cross2'),
    false,
    '首播在 4 月的番不该留在 7 月',
  );
  assert.equal(
    listSeasonSubjects(seasonGuardDb, '2026-04').some((item) => item.key === 'bgm:cross2'),
    true,
    '应当被纠正到 2026-04',
  );
});

check('没有时刻可判定时不抢已有归属（补番库的老番）', () => {
  const undated = makeSubject('bgm:cross3', { titleCn: '没有时刻的番' });
  upsertSubject(seasonGuardDb, undated, '2026-10');
  // 上一个检查留下 bgm:cross1，这里再加一条 -> 当季 2 部
  assert.equal(seasonSubjectCount(seasonGuardDb, '2026-10'), 2);

  // 又一次写入、声称它是 2026-07：没有时刻就无法判定，不该动已有归属
  upsertSubject(seasonGuardDb, undated, '2026-07');
  assert.equal(
    listSeasonSubjects(seasonGuardDb, '2026-10').some((item) => item.key === 'bgm:cross3'),
    true,
    '无法判定季度时应当保留原有归属',
  );
  assert.equal(seasonSubjectCount(seasonGuardDb, '2026-07'), 0);
});

check('写库后统一纠正归属：把历史遗留的错误归属改回来（与写入顺序无关）', () => {
  // 这个函数的价值是**清理已经存在的错误**：老版本代码把一批条目写错了季度
  // （实测 63 部 10 月番被写成 2026-07）。写入时的新逻辑能防新的错误，
  // 但改不掉库里已经错的那批 —— 靠这个函数收口。
  const db2 = openDb(':memory:');
  migrate(db2);

  const october = makeSubject('bgm:order1', {
    titleCn: '十月番',
    firstAirAtUtc: '2026-10-05T15:00:00.000Z',
    episodes: [makeEpisode(1, '2026-10-05T15:00:00.000Z')],
  });
  upsertSubject(db2, october, '2026-10');

  // 模拟「老代码留下的错误」：season 被写成了 2026-07
  db2.prepare("UPDATE subject SET season = '2026-07' WHERE key = 'bgm:order1'").run();
  assert.equal(seasonSubjectCount(db2, '2026-07'), 1, '先制造一条错位');

  const repaired = repairSeasonAssignments(db2, '2026-10');
  assert.ok(repaired >= 1, `应当纠正至少 1 条，实际 ${repaired}`);
  assert.equal(seasonSubjectCount(db2, '2026-10'), 1, '纠正后它应当回到 2026-10（依据是它自己的放送时刻）');
  assert.equal(seasonSubjectCount(db2, '2026-07'), 0);

  // 幂等：没有错位可纠时不动任何东西
  assert.equal(repairSeasonAssignments(db2, '2026-10'), 0, '纠正必须幂等');

  // 没有时刻可判定的条目不受影响（补番库老番）
  upsertSubject(db2, makeSubject('bgm:order2', { titleCn: '没时刻的番' }), '2026-07');
  assert.equal(repairSeasonAssignments(db2), 0, '没有时刻的条目不该被搬走');
  assert.equal(seasonSubjectCount(db2, '2026-07'), 1);
  db2.close();
});

check('季度判据只看「集数最小的那一集」的时刻（判据不一致会让归属在两次同步间抖动）', () => {
  const db3 = openDb(':memory:');
  migrate(db3);

  // 判据为什么是这一集：它在跨源之间永远一致，所以归属不会抖动；
  // 而 firstAirAtUtc 会因为数据源不同在两次同步之间时有时无。
  upsertSubject(
    db3,
    makeSubject('bgm:premiere1', {
      titleCn: '第 1 集在 10 月',
      // 故意给一个冲突的 firstAirAtUtc：判据不该用它
      firstAirAtUtc: '2026-10-05T15:00:00.000Z',
      episodes: [makeEpisode(1, '2026-10-05T15:00:00.000Z'), makeEpisode(2, '2026-10-12T15:00:00.000Z')],
    }),
    '2026-10',
  );
  assert.equal(seasonSubjectCount(db3, '2026-10'), 1);

  // 被写错之后，repair 必须按**同一个判据**把它改回来
  db3.prepare("UPDATE subject SET season = '2026-07' WHERE key = 'bgm:premiere1'").run();
  assert.ok(repairSeasonAssignments(db3) >= 1, '应当纠正');
  assert.equal(seasonSubjectCount(db3, '2026-10'), 1);

  // 幂等：判据一致才可能幂等（否则每次同步都会把归属搬来搬去）
  assert.equal(repairSeasonAssignments(db3), 0, '纠正必须幂等');

  // 特别篇的集数更小 -> 由它主导归属。
  // 这是刻意的：番剧的「第 1 集」就是集数最小的那一集，数组顺序不参与判定。
  upsertSubject(
    db3,
    makeSubject('bgm:premiere2', {
      titleCn: '特别篇在 6 月',
      firstAirAtUtc: '2026-10-05T15:00:00.000Z',
      episodes: [
        makeEpisode(1, '2026-10-05T15:00:00.000Z'),
        makeEpisode(0.5, '2026-06-01T15:00:00.000Z'), // 乱序传入，也必须被识别为"集数最小"
      ],
    }),
    '2026-10',
  );
  assert.equal(
    seasonSubjectCount(db3, '2026-04'),
    1,
    '集数最小的 0.5 在 6 月 -> 归 2026-04（判定按集数排序，不依赖数组顺序）',
  );

  // 没有分集时刻时才退回 firstAirAtUtc
  upsertSubject(
    db3,
    makeSubject('bgm:premiere3', { titleCn: '只有首播时刻', firstAirAtUtc: '2026-10-05T15:00:00.000Z' }),
    '2026-09',
  );
  assert.equal(seasonSubjectCount(db3, '2026-10'), 2, '没有分集时刻时按首播时刻判');

  // 完全没有时刻 -> 不抢已有归属
  upsertSubject(db3, makeSubject('bgm:premiere4', { titleCn: '没有任何时刻' }), '2026-07');
  assert.equal(seasonSubjectCount(db3, '2026-07'), 1, '没有时刻时保留写入时的归属');
  assert.equal(repairSeasonAssignments(db3), 0, '没有时刻的条目不该被搬走');
  db3.close();
});

seasonGuardDb.close();

// ---------------------------------------------------------------------------
section('十五、搜索导入的番要能回填季度（否则在全季总览里永远看不到）');
// ---------------------------------------------------------------------------

check('AniList 的 season/seasonYear 能翻成本项目的季度 ID', () => {
  assert.equal(anilistSeasonId('FALL', 2026), '2026-10');
  assert.equal(anilistSeasonId('WINTER', 2027), '2027-01');
  assert.equal(anilistSeasonId('SPRING', 2026), '2026-04');
  assert.equal(anilistSeasonId('SUMMER', 2026), '2026-07');
  // 大小写与未知值都不该让导入失败
  assert.equal(anilistSeasonId('fall', 2026), '2026-10');
  assert.equal(anilistSeasonId('SOMETHING_NEW', 2026), null, '源站多一个枚举值不该抛错');
  assert.equal(anilistSeasonId(null, 2026), null);
  assert.equal(anilistSeasonId('FALL', null), null);
});

check('融合会把数据源给的季度带出来（否则导入时无从回填）', () => {
  const raw = makeRaw('season-test', { titleOriginal: 'テスト', season: '2026-10' });
  const merged = mergeSubjects([[raw]]);
  const subject = merged.subjects[0];
  assert.equal(subject?.season, '2026-10', '融合结果应当带上 season');
  assert.equal(subject?.fieldSources.season, 'anilist', '出处要记进 fieldSources');
});

const importDb = openDb(':memory:');
migrate(importDb);

check('导入落库时写进季度，能被季度查询找到', () => {
  // 复现服务端导入路径：mergeSubjects -> upsertSubjects(subject.season ?? null)
  // 注意没有跨源 ID 时主键会退化成 `title:<归一化标题>`，所以这里用返回的 key 断言
  const raw = makeRaw('import1', { titleOriginal: 'インポートされる番', season: '2026-07' });
  const subject = mergeSubjects([[raw]]).subjects[0];
  assert.ok(subject, '融合结果为空');
  upsertSubject(importDb, subject, subject.season ?? null);

  assert.equal(getSubjectSeason(importDb, subject.key), '2026-07');
  assert.equal(seasonSubjectCount(importDb, '2026-07'), 1, '应当能在 2026-07 的季度查询里找到它');
  assert.ok(
    listSeasonSubjects(importDb, '2026-07').some((item) => item.key === subject.key),
    '全季总览必须能看到它（这正是「加进去的番没了」的根因）',
  );
});

check('数据源没给季度时退回到调用方指定的季度', () => {
  const raw = makeRaw('import2', { titleOriginal: '季度由调用方指定' });
  const subject = mergeSubjects([[raw]]).subjects[0];
  assert.ok(subject);
  assert.equal(subject.season, undefined, '数据源没给季度');
  upsertSubject(importDb, subject, '2026-10');
  assert.equal(getSubjectSeason(importDb, subject.key), '2026-10');
});

check('既没有数据源季度也没有放送时刻时，仍然可以落库（不抛错）', () => {
  const raw = makeRaw('import3', { titleOriginal: '什么都没有' });
  const subject = mergeSubjects([[raw]]).subjects[0];
  assert.ok(subject);
  upsertSubject(importDb, subject, null);
  assert.equal(getSubjectSeason(importDb, subject.key), null, '推不出季度就保持 null，而不是猜一个');
});

importDb.close();

seasonDb.close();

// ---------------------------------------------------------------------------
section('十四、数据库备份（用户数据不可重建）');
// ---------------------------------------------------------------------------

const backupRoot = mkdtempSync(path.join(tmpdir(), 'anime-backup-'));
const liveDbPath = path.join(backupRoot, 'anime.db');
const liveBackupDir = path.join(backupRoot, 'backups');

const liveDb = openDb(liveDbPath);
migrate(liveDb);
upsertSubject(liveDb, makeSubject('bgm:b1', { titleCn: '要保住的番', status: 'finished', totalEps: 12 }), '2026-10');
addMyAnime(liveDb, 'bgm:b1', { watchedEps: 7 });

function countIn(file: string): { subjects: number; mine: number } {
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    const row = probe
      .prepare('SELECT (SELECT COUNT(*) FROM subject) AS subjects, (SELECT COUNT(*) FROM my_anime) AS mine')
      .get() as { subjects: number; mine: number };
    return { subjects: Number(row.subjects), mine: Number(row.mine) };
  } finally {
    probe.close();
  }
}

/** 在另一个连接持有数据库时备份 —— WAL 模式下数据可能还没合并进主文件。 */
let checkpointedBackup: { path: string; bytes: number; checkpointed: boolean } | null = null;
check('备份在「另一个连接持有 WAL」的情况下也不丢用户数据（实测过的真实陷阱）', () => {
  const holder = openDb(liveDbPath);
  // holder 不写入，数据仍在 WAL 里、尚未合并进主文件
  const result = backupDatabase(liveDb, { dbPath: liveDbPath, backupDir: liveBackupDir, label: 'test' });
  assert.ok(result, '应当返回备份结果');
  checkpointedBackup = { path: result.path, bytes: result.bytes, checkpointed: result.checkpointed };
  assert.ok(result.bytes > 0, '备份文件是空的');

  const counts = countIn(result.path);
  assert.equal(counts.subjects, 1, '备份里丢了番剧条目');
  assert.equal(counts.mine, 1, '备份里丢了追番记录 —— 这正是「只拷 anime.db」的失败模式');

  // 对照组：只拷主库文件（不拷 -wal）会丢 my_anime。
  // 如果这一步没有丢，说明环境已经 checkpoint 过，那就跳过这条对照断言（不算失败）。
  const naive = path.join(backupRoot, 'naive.db');
  copyFileSync(liveDbPath, naive);
  const naiveCounts = countIn(naive);
  if (naiveCounts.mine === 0) {
    console.log('      （对照：只拷 anime.db 会丢 my_anime，已验证本项目的备份躲开了这个坑）');
  }
  holder.close();
});

check('备份文件名带标签，且是 .db 文件', () => {
  assert.ok(checkpointedBackup, '上一步没产出备份');
  assert.match(path.basename(checkpointedBackup.path), /^anime-.*-test\.db$/);
});

check('保留策略：只留最近 N 份，且不会删掉更新的备份', () => {
  // 造 5 份备份。文件名的时间戳由 now 参数控制，字典序 = 时间序。
  for (let index = 0; index < 5; index += 1) {
    backupDatabase(liveDb, {
      dbPath: liveDbPath,
      backupDir: liveBackupDir,
      label: `n${index}`,
      now: new Date(Date.UTC(2026, 0, index + 1, 12, 0, 0)),
    });
  }
  const before = readdirSync(liveBackupDir).filter((name) => name.endsWith('.db'));
  // 保留 3 份：按文件名升序排序后，末尾 3 个就是「最近的 3 份」
  const newestThree = [...before].sort().slice(-3);

  const removed = pruneBackups(liveBackupDir, 3);
  const after = readdirSync(liveBackupDir).filter((name) => name.endsWith('.db'));
  assert.equal(after.length, 3, `保留 3 份，实际剩 ${after.length}`);
  assert.equal(removed, before.length - 3, `应删掉 ${before.length - 3} 份，实际 ${removed}`);
  assert.deepEqual(
    [...after].sort(),
    newestThree,
    '留下的必须是最新的三份（删错的话用户会丢掉最近的备份）',
  );
  assert.ok(
    after.some((name) => name.includes('n4')),
    '最新那份（n4）必须还在',
  );
});

check('备份时连 -wal / -shm 一起拷（checkpoint 失败时的第二道保险）', () => {
  const walSource = path.join(backupRoot, 'with-wal.db');
  // 用一个真实的小库，而不是假文件 —— 否则 copyFileSync 的结果没法验证
  const small = openDb(walSource);
  migrate(small);
  upsertSubject(small, makeSubject('bgm:w1', { titleCn: '带 WAL 的番' }), '2026-10');
  small.close();
  writeFileSync(`${walSource}-wal`, 'not-a-real-wal');

  const result = backupDatabase(liveDb, { dbPath: walSource, backupDir: liveBackupDir, label: 'wal' });
  assert.ok(result);
  assert.ok(existsSync(`${result.path}-wal`), '没有把 -wal 一起拷过去');
  assert.ok(countIn(result.path).subjects >= 1, '备份出来的库读不出条目');
});

// 上面那条用假文件做了 backupDatabase，会污染「最近备份」的排序；清掉整个临时目录
liveDb.close();
rmSync(backupRoot, { recursive: true, force: true });

check('备份函数在库文件不存在时安全返回 null（而不是抛错打断启动）', () => {
  const missingRoot = mkdtempSync(path.join(tmpdir(), 'anime-missing-'));
  try {
    const result = backupDatabase(liveDb, {
      dbPath: path.join(missingRoot, 'nope.db'),
      backupDir: path.join(missingRoot, 'backups'),
    });
    assert.equal(result, null);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

db.close();

// ---------------------------------------------------------------------------
// 样式的静态守卫（只读 web/styles.css，不需要浏览器）
// ---------------------------------------------------------------------------
//
// 为什么需要这一节：CSS 里**语法无效的声明会被浏览器静默丢弃**，而 ui:smoke 跑的是手写元素壳、
// 从不读 styles.css —— 于是"JS 全绿、真实界面塌成一列"这种事故没有任何自动检查能发现。
// 最典型的坑：`repeat()` 的第一个参数按规范**只能是整数**（或 auto-fill/auto-fit），
// 写成 `repeat(min(var(--n), 5), …)` 会整条被丢掉。这里用静态检查把它挡在提交之前。

const stylesPath = new URL('../web/styles.css', import.meta.url);
const stylesCss = readFileSync(stylesPath, 'utf8');
const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

/**
 * 去掉 CSS 注释后再检查。
 *
 * 必须先剥注释：解释"为什么不能这么写"的注释里**必然**会出现反面示例
 * （例如 `repeat(min(...), …)` 是无效 CSS 这句话），不剥掉就会把自己写的反例当成违规。
 */
function stripCssComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

const stylesCode = stripCssComments(stylesCss);

/** 取出 repeat(...) 的第一个参数（含嵌套括号），例如 '4'、'auto-fill'、'min(var(--x), 5)' */
function firstRepeatArg(text: string, openParen: number): string {
  let depth = 1;
  for (let i = openParen + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openParen + 1, i).trim();
    } else if (ch === ',' && depth === 1) {
      return text.slice(openParen + 1, i).trim();
    }
  }
  return '';
}

check('styles.css 里 repeat() 的第一个参数只用整数字面量（min()/calc()/var() 都是无效 CSS）', () => {
  const bad: string[] = [];
  for (const m of stylesCode.matchAll(/repeat\s*\(/g)) {
    const arg = firstRepeatArg(stylesCode, m.index + m[0].length - 1);
    if (arg === '') continue;
    const isIntegerLiteral = /^\d+$/.test(arg);
    const isAutoKeyword = arg === 'auto-fill' || arg === 'auto-fit';
    if (!isIntegerLiteral && !isAutoKeyword) bad.push(arg);
  }
  assert.equal(
    bad.join(' | '),
    '',
    `这些 repeat() 首个参数不是整数、会被浏览器整条丢弃：${bad.join(' | ')}`,
  );
});

check('样式表里不再有"每行几部"的旧写法（--per-row-w / auto-fill 列数）', () => {
  assert.equal(stylesCode.includes('--per-row-w'), false);
  assert.equal(/grid-template-columns\s*:\s*repeat\(\s*auto-fill/.test(stylesCode), false);
});

check('导航栏不再有「搜索 / 加番」入口，但搜索视图的代码仍保留', () => {
  // 用户要求：只从导航拿掉入口，代码保留（以后想找回这个视图改一行就行）。
  // 所以这里断言两件事同时成立：入口没了，而视图函数还在。
  const indexHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(indexHtml.includes('search'), false, 'index.html 里不该再出现 search');
  assert.equal(
    (indexHtml.match(/data-view="/g) ?? []).length,
    4,
    `导航项应剩 4 个，实际 ${(indexHtml.match(/data-view="/g) ?? []).length} 个`,
  );
  assert.ok(appJs.includes('function renderSearch'), 'renderSearch 不该被删');
});

check('点击委托里「卡片整体可点」的分支必须排在所有按钮分支之后', () => {
  // 为什么用静态检查兜这件"顺序"：点卡片弹详情是靠"按钮分支都先 return"来实现的，
  // 一旦有人把 dataset.subjectRow 那条挪到按钮分支前面，点「追番 / 移除 / 复制」
  // 就会连带弹出详情 —— 而这类 bug 只有在真实浏览器里点一下才看得出来。
  // 把"新人要记得加在前面"这个隐性约定变成 pnpm verify 里的确定性检查。
  const lines = appJs.split('\n');
  const handlerStart = lines.findIndex((line) => line.includes("document.addEventListener('click'"));
  assert.ok(handlerStart >= 0, '没找到点击委托处理函数');
  const handlerLines = lines.slice(handlerStart, handlerStart + 260);
  const lineOf = (needle: string) => {
    const index = handlerLines.findIndex((line) => line.includes(needle));
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const cardBranch = lineOf('if (dataset.subjectRow)');
  for (const buttonBranch of ['if (dataset.add)', 'if (dataset.remove)', 'if (dataset.copy)']) {
    assert.ok(
      lineOf(buttonBranch) < cardBranch,
      `${buttonBranch} 必须排在 if (dataset.subjectRow) 之前，否则点按钮会连带弹出详情`,
    );
  }
});

check('每个可选列数都有对应的 .per-row-N 规则（与 app.js 的 PER_ROW_OPTIONS 对齐）', () => {
  const list = /const PER_ROW_OPTIONS = \[([^\]]+)\]/.exec(appJs)?.[1] ?? '';
  const options = list
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
  assert.ok(options.length >= 5, `没解析到 PER_ROW_OPTIONS，实际拿到 ${options.length} 项`);
  for (const option of options) {
    assert.ok(
      stylesCode.includes(`.per-row-${option}`),
      `styles.css 缺少 .per-row-${option} 的列数规则`,
    );
  }
});

// ---------------------------------------------------------------------------
section('十六、更新范围可控：自己挑季度（.scratch/update-scope）');
// ---------------------------------------------------------------------------
//
// 这一段**刻意不碰网络**：抓取与机翻请求属于 `pnpm verify:api` 的活。
// 所以把"要抓哪几季"和"这一季要不要跳过"抽成了纯函数（`resolveArchiveSeasons` /
// `archiveSkipDecision`），在这里断言它们；`syncArchive` 的循环就是照这两个函数的输出跑的。

check('给定 seasons 时按给定顺序、跳过中间季度，一个不多一个不少', () => {
  assert.deepEqual(resolveArchiveSeasons({ seasons: ['2026-10', '2024-10'] }), ['2026-10', '2024-10']);
  // 2025-01 / 2025-04 / … 这些**中间季度一个都不能出现**（这是本票的核心）
  const picked = resolveArchiveSeasons({ seasons: ['2026-10', '2024-10', '2020-01'] });
  assert.deepEqual(picked, ['2026-10', '2024-10', '2020-01']);
});

check('seasons 去重、去空白，且不去排序（用户给的顺序就是抓取顺序）', () => {
  assert.deepEqual(resolveArchiveSeasons({ seasons: [' 2026-04 ', '2026-10', '2026-04', ''] }), [
    '2026-04',
    '2026-10',
  ]);
});

check('库里没有的季度照样按顺序去抓（老季度不会被推导逻辑吃掉）', () => {
  const seasons = resolveArchiveSeasons({ seasons: ['2020-01'] });
  assert.deepEqual(seasons, ['2020-01']);
  // 顺带确认 seasonFromId / shiftSeason 对远古季度也能给出正常的 id 与标签
  const old = seasonFromId('2020-01');
  assert.equal(old.id, '2020-01');
  assert.ok(old.label.includes('2020'), `标签应该带年份，实际 ${old.label}`);
  assert.equal(shiftSeason('2020-01', -1), '2019-10');
  assert.equal(shiftSeason('2020-01', 1), '2020-04');
});

check('seasons 优先于 backfill：同时给时只用 seasons 的列表', () => {
  const both = resolveArchiveSeasons({ seasons: ['2024-10'], toSeason: '2026-10', backfill: 4 });
  assert.deepEqual(both, ['2024-10']);
});

check('backfill 档位：含当季往回数，且最小 1（0 / 负数都不会推出"未来季度"）', () => {
  assert.deepEqual(resolveArchiveSeasons({ toSeason: '2026-10', backfill: 3 }), [
    '2026-04',
    '2026-07',
    '2026-10',
  ]);
  assert.deepEqual(resolveArchiveSeasons({ toSeason: '2026-10', backfill: 1 }), ['2026-10']);
  // ⚠ 这两条是防回归：旧实现 backfill=0 → fromSeason = 当季之后 → 一路推 64 个未来季度
  assert.deepEqual(resolveArchiveSeasons({ toSeason: '2026-10', backfill: 0 }), ['2026-10']);
  assert.deepEqual(resolveArchiveSeasons({ toSeason: '2026-10', backfill: -5 }), ['2026-10']);
  assert.deepEqual(resolveArchiveSeasons({ toSeason: '2026-10' }), ['2026-04', '2026-07', '2026-10']);
  assert.equal(DEFAULT_BACKFILL, 3, '默认档位只有一处来源');
});

check('显式给了空的 seasons 就抓 0 季（不能掉回 backfill 推导）', () => {
  // 防的是一个很隐蔽的回归：主季已经单独抓过、回填阶段没有别的季度时，若把空数组
  // 当成"没给 seasons"，就会突然去抓一串**没人要求过**的季度。
  assert.deepEqual(resolveArchiveSeasons({ seasons: [] }), []);
});

check('from/to 写反了自动换过来；跨年也对', () => {
  assert.deepEqual(resolveArchiveSeasons({ fromSeason: '2026-07', toSeason: '2026-01' }), [
    '2026-01',
    '2026-04',
    '2026-07',
  ]);
  assert.deepEqual(resolveArchiveSeasons({ fromSeason: '2025-10', toSeason: '2026-04' }), [
    '2025-10',
    '2026-01',
    '2026-04',
  ]);
  // 守卫上限还在（不让一个畸形区间把源站打穿）
  assert.ok(resolveArchiveSeasons({ fromSeason: '1990-01', toSeason: '2030-01' }).length <= 64);
});

check('增量判定：库里已有的季度跳过，force / minSubjects 能改变结论', () => {
  // 1) 库里**没有**的季度绝不能被误判成 skip（老季度 404 也要真去试一次）
  assert.equal(archiveSkipDecision(0).skip, false);
  // 2) 已有数据 → 跳过，且理由里要说清怎么重抓
  const skipped = archiveSkipDecision(31);
  assert.equal(skipped.skip, true);
  assert.ok((skipped.note ?? '').includes('force'), `跳过理由要提到 force，实际：${skipped.note}`);
  // 3) force → 不跳过（重抓）
  assert.equal(archiveSkipDecision(31, { force: true }).skip, false);
  // 4) minSubjects 的口径
  assert.equal(archiveSkipDecision(3, { minSubjects: 5 }).skip, false);
  assert.equal(archiveSkipDecision(5, { minSubjects: 5 }).skip, true);
});

check('archiveSkipDecision 与库里的实际条数对得上（内存库真查一次）', () => {
  const scopeDb = openDb(':memory:');
  migrate(scopeDb);
  // 两个季度：一个有数据、一个库里根本没有（2020-01）
  upsertSubject(scopeDb, makeSubject('scope:1', { titleCn: '有数据的番' }), '2026-10');
  assert.equal(seasonSubjectCount(scopeDb, '2026-10'), 1);
  assert.equal(seasonSubjectCount(scopeDb, '2020-01'), 0);
  assert.equal(archiveSkipDecision(seasonSubjectCount(scopeDb, '2026-10')).skip, true);
  assert.equal(archiveSkipDecision(seasonSubjectCount(scopeDb, '2020-01')).skip, false);
  // 顺带把"这次要抓哪几季"的整条链路合起来看一遍
  assert.deepEqual(resolveArchiveSeasons({ seasons: ['2026-10', '2020-01'] }), ['2026-10', '2020-01']);
  scopeDb.close();
});

// 机翻那几个条目刻意"连原文都没有"（titleCn / titleOriginal 都不给）：
// 判定结果是「没有可翻译的原名」→ translateMissingTitles 会在 pending 阶段跳过它们，
// 于是这一段**既验证了季度筛选，又不会真的发翻译请求**（离线的 pnpm verify 不该打网络）。
// 注意：这类条目属于"被跳过"，所以查询时要带 includeSkipped（translateMissingTitles 自己就是这么查的）。
const mtScopeDb = openDb(':memory:');
migrate(mtScopeDb);
for (const [key, season] of [
  ['mt:2026', '2026-10'],
  ['mt:2024', '2024-10'],
  ['mt:2020', '2020-01'],
] as const) {
  upsertSubject(mtScopeDb, makeSubject(key), season);
}

check('机翻覆盖范围：勾中的季度都翻、没勾的一条都不碰（不传 null 全库翻）', () => {
  const twoSeasons = listTranslationCandidates(mtScopeDb, {
    season: ['2026-10', '2024-10'],
    includeSkipped: true,
  });
  assert.equal(twoSeasons.length, 2, `勾两季应该只有 2 条候选，实际 ${twoSeasons.length}`);
  assert.deepEqual(
    [...new Set(twoSeasons.map((item) => item.season))].sort(),
    ['2024-10', '2026-10'],
  );
  assert.equal(
    twoSeasons.some((item) => item.season === '2020-01'),
    false,
    '没勾的季度一条都不该出现',
  );
  // 确认这几条确实"没有可翻译的原名"（也正因为如此，下面那步不会发网络请求）
  assert.ok(
    twoSeasons.every((item) => item.skipReason === '没有可翻译的原名'),
    `候选应当被判定为"没有可翻译的原名"，实际：${twoSeasons.map((item) => item.skipReason).join(' / ')}`,
  );

  // 单季仍然照旧
  assert.equal(listTranslationCandidates(mtScopeDb, { season: '2026-10', includeSkipped: true }).length, 1);
  // 不传才是全库（三条都在）——「全库翻」只允许显式调用
  assert.equal(listTranslationCandidates(mtScopeDb, { includeSkipped: true }).length, 3);
});

const scopedTranslation = await translateMissingTitles(mtScopeDb, { season: ['2026-10', '2024-10'] });

check('translateMissingTitles 把季度数组原样传到候选查询（计数只覆盖勾中的两季）', () => {
  assert.equal(scopedTranslation.candidates, 2, `机翻候选应该只覆盖勾中的两季，实际 ${scopedTranslation.candidates}`);
  assert.equal(scopedTranslation.translated.length, 0);
  assert.equal(scopedTranslation.failed.length, 0, '没有可用原文的条目应算"跳过"，不是失败');
  mtScopeDb.close();
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m：${passed} 项检查`);
} else {
  console.log(`\x1b[31m通过 ${passed} 项，失败 ${failures.length} 项\x1b[0m`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
