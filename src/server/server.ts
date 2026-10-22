/**
 * 本地 Web 服务：REST API + 静态文件（界面）。
 *
 *   node src/server/server.ts          # 默认 http://127.0.0.1:8787
 *   $env:PORT=9000; node src/server/server.ts
 *
 * 刻意只用 node:http，不引 Fastify/Express：
 *   - 路由就十几个，自己写反而更清楚
 *   - 保持「装完依赖就能跑、没有构建步骤」这个特性（见 docs/决策记录.md T1）
 *   - 只监听 127.0.0.1，不对外暴露（这是单人本机工具，不需要鉴权）
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { datesOfJstWeek, groupByDayJst, padWindow } from '../core/calendar.ts';
import type { DayRule } from '../core/calendar.ts';
import { mergeSubjects } from '../core/merge.ts';
import { WEEKDAY_CN, countdown, jstWeekRange, seasonFromId, seasonOf } from '../core/time.ts';
import type { SeasonInfo } from '../core/time.ts';
import { RawSeasonAnimeSchema, TRACK_CATEGORIES, TRACK_CATEGORY_LABELS } from '../core/types.ts';
import type { TrackCategory } from '../core/types.ts';
import { anilistProvider } from '../providers/anilist.ts';
import { DEFAULT_TRANSLATE_CONCURRENCY } from '../providers/mt.ts';
import {
  acknowledgeChanges,
  addMyAnime,
  availableSeasons,
  backupDatabase,
  DEFAULT_DB_PATH,
  getSubjectDetail,
  getSubjectSeason,
  listChanges,
  listMyAnime,
  listSchedule,
  listSeasonSubjects,
  listSyncRuns,
  listUpcoming,
  migrate,
  openDb,
  pruneBackups,
  removeMyAnime,
  resolveSeasonSort,
  resolveSubjectIdentity,
  searchLocalSubjects,
  seasonSummaries,
  setBacklogPlan,
  setCategory,
  setOverride,
  setWatchedEps,
  stats,
  upsertSubjects,
} from './db.ts';
import { changeKindLabel, describeChangeItem } from './changes.ts';
import { buildIcs, icsFileName } from './ics.ts';
import { DEFAULT_BACKFILL, runFullUpdate, syncSeason, translateMissingTitles } from './sync.ts';
import type { FullUpdateResult } from './sync.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
// ⚠ 库路径只认 db.ts 的 DEFAULT_DB_PATH（它读 `ANIME_DB_PATH` 逃生口）——
//   以前这里自己拼了一遍 `DATA_DIR/anime.db`，于是"在副本上起一个服务验证"根本做不到。
const dbPath = DEFAULT_DB_PATH;
const db = openDb(dbPath);
migrate(db);

// 启动时自动备份一次用户数据，并清理过旧的备份（见 docs/决策记录.md D10）。
// 失败只提示、不阻断启动 —— 界面本身比备份更重要。
try {
  const startupBackup = backupDatabase(db, { dbPath, label: 'startup' });
  pruneBackups();
  if (startupBackup) console.log(`已备份数据库：${startupBackup.path}`);
} catch (error) {
  console.warn(`启动备份失败（不影响使用）：${error instanceof Error ? error.message : String(error)}`);
}

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------

/** 接口处理函数只负责算数据，怎么发由路由层通过 reply 决定。 */
type Reply = (status: number, payload: unknown) => void;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function resolveSeason(raw: string | null): SeasonInfo {
  if (!raw) return seasonOf(new Date());
  try {
    return seasonFromId(raw);
  } catch {
    return seasonOf(new Date());
  }
}

function resolveRule(raw: string | null): DayRule {
  return raw === 'broadcast-calendar' ? 'broadcast-calendar' : 'clock';
}

/**
 * 季度参数解析：支持逗号分隔的多季（第五轮需求 5）。
 *
 * `?season=2026-10,2026-07` → 两季并集；认不出来的项**丢弃**（不回落成当季，
 * 否则 user 勾了两季、其中一季名字打错，会静默变成"只查了当季"，很难发现）。
 * 去重并保持传入顺序 —— 顺序有意义：周视图 / .ics 用的是第一个。
 */
function resolveSeasons(raw: string | null): { seasons: string[]; invalid: string[] } {
  if (!raw) return { seasons: [seasonOf(new Date()).id], invalid: [] };
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) return { seasons: [seasonOf(new Date()).id], invalid: [] };

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    try {
      const id = seasonFromId(part).id;
      if (!valid.includes(id)) valid.push(id);
    } catch {
      if (!invalid.includes(part)) invalid.push(part);
    }
  }
  return { seasons: valid.length > 0 ? valid : [seasonOf(new Date()).id], invalid };
}

/** 数据库里有哪些季度（历史季度保留的可见化，见 D9）。 */
function dbAvailableSeasons(): string[] {
  return availableSeasons(db);
}

// ---------------------------------------------------------------------------
// 接口实现
// ---------------------------------------------------------------------------

/**
 * 全季总览：数量统计 + 分布 + 番剧列表。
 * 这一块直接对应「我一开始就想要的那张表」：数量、类型、开播时间。
 */
function handleOverview(url: URL, reply: Reply): void {
  const requested = resolveSeasons(url.searchParams.get('season'));
  const sort = resolveSeasonSort(url.searchParams.get('sort'));
  const seasons = requested.seasons;
  const primary = seasonFromId(seasons[0]);
  const subjects = listSeasonSubjects(db, seasons, sort);

  const countBy = <T extends string | number>(values: T[]): Array<{ key: T; count: number }> => {
    const counter = new Map<T, number>();
    for (const value of values) counter.set(value, (counter.get(value) ?? 0) + 1);
    return [...counter.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  };

  const genreCounts = new Map<string, number>();
  for (const subject of subjects) {
    for (const genre of subject.genres) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
  }

  const platformCounts = new Map<string, number>();
  for (const subject of subjects) {
    for (const name of new Set(subject.platforms.map((platform) => platform.name))) {
      platformCounts.set(name, (platformCounts.get(name) ?? 0) + 1);
    }
  }

  reply(200, {
    season: { id: primary.id, label: primary.label, year: primary.year, month: primary.month },
    /** 本次实际查询的季度（多选时为并集，第一个是"主季"） */
    seasons,
    /** 参数里认不出来的季度，原样回给界面提示，不静默吞掉 */
    invalidSeasons: requested.invalid,
    /** 列表排序口径，界面据此高亮当前选项 */
    sort,
    availableSeasons: dbAvailableSeasons(),
    /** 每个季度各有多少部/多少集，以及最后一次更新时刻（界面标注用） */
    seasonSummaries: seasonSummaries(db),
    totals: {
      all: subjects.length,
      tracking: subjects.filter((s) => s.myCategory === 'tracking').length,
      backlog: subjects.filter((s) => s.myCategory === 'backlog').length,
      finished: subjects.filter((s) => s.myCategory === 'finished').length,
      upcoming: subjects.filter((s) => s.status === 'upcoming').length,
      airing: subjects.filter((s) => s.status === 'airing').length,
      withoutChineseTitle: subjects.filter((s) => !s.titleCn).length,
      /** 其中有多少是临时机翻补上的（用户要能一眼看出「哪些名是临时的」） */
      machineTranslatedTitle: subjects.filter((s) => s.titleCnSource === 'machine').length,
    },
    byWeekday: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      count: subjects.filter((s) => s.broadcastWeekdayJst === weekday).length,
    })),
    byGenre: [...genreCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    byPlatform: [...platformCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    byMediaType: countBy(subjects.map((s) => s.mediaType)),
    subjects,
  });
}

/** 周视图：7 天全部返回（含空天），前端直接铺格子。 */
function handleWeek(url: URL, reply: Reply): void {
  const season = resolveSeason(url.searchParams.get('season'));
  const rule = resolveRule(url.searchParams.get('rule'));
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

  const reference = new Date(Date.now() + offset * 7 * 86_400_000);
  const week = jstWeekRange(reference);
  const padded = padWindow(week.startUtc, week.endUtc);

  const rows = listSchedule(db, padded.startUtc, padded.endUtc, { category: 'tracking' });
  const bucketByDate = new Map(groupByDayJst(rows, rule).map((bucket) => [bucket.dateJst, bucket]));
  const todayJst = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

  const days = datesOfJstWeek(week.startDateJst).map((dateJst) => {
    const bucket = bucketByDate.get(dateJst);
    const weekdayJst = new Date(`${dateJst}T00:00:00.000Z`).getUTCDay();
    return {
      dateJst,
      weekdayJst,
      weekdayLabel: WEEKDAY_CN[weekdayJst] ?? '',
      isToday: dateJst === todayJst,
      items: (bucket?.items ?? []).map((item) => ({
        ...item,
        countdown: item.airAtUtc ? countdown(item.airAtUtc) : null,
      })),
    };
  });

  reply(200, {
    season: { id: season.id, label: season.label },
    rule,
    offset,
    week: {
      startDateJst: week.startDateJst,
      endDateJst: week.endDateJst,
      startUtc: week.startUtc,
      endUtc: week.endUtc,
    },
    days,
    /** 最近要更新的若干集（不限本周），用于侧栏倒计时 */
    upcoming: listUpcoming(db, new Date().toISOString(), 12).map((item) => ({
      ...item,
      countdown: item.airAtUtc ? countdown(item.airAtUtc) : null,
    })),
  });
}

function handleMy(reply: Reply): void {
  const groups: Record<string, unknown> = {};
  for (const category of TRACK_CATEGORIES) {
    groups[category] = listMyAnime(db, category).map((item) => ({
      ...item,
      categoryLabel: TRACK_CATEGORY_LABELS[category],
      remaining: item.totalEps && item.totalEps > 0 ? Math.max(0, item.totalEps - item.watchedEps) : null,
    }));
  }
  reply(200, { groups, stats: stats(db) });
}

async function handleSearch(url: URL, reply: Reply): Promise<void> {
  const keyword = (url.searchParams.get('q') ?? '').trim();
  if (!keyword) {
    reply(200, { keyword, local: [], remote: [] });
    return;
  }

  const local = searchLocalSubjects(db, keyword, 20);

  let remote: unknown[] = [];
  if (url.searchParams.get('remote') !== '0' && anilistProvider.search) {
    try {
      const results = await anilistProvider.search(keyword, { limit: 12 });
      const localTitles = new Set(local.map((item) => item.titleOriginal ?? ''));
      remote = results
        .filter((item) => !localTitles.has(item.titleOriginal ?? ''))
        .map((item) => ({
          anilistId: item.anilistId ?? null,
          titleOriginal: item.titleOriginal ?? null,
          titleEn: item.titleEn ?? null,
          mediaType: item.mediaType,
          totalEps: item.totalEps ?? null,
          status: item.status,
          coverUrl: item.coverUrl ?? null,
          raw: item,
        }));
    } catch (error) {
      reply(200, {
        keyword,
        local,
        remote: [],
        remoteError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  reply(200, { keyword, local, remote });
}

/** 抓取当季。会真的打源站，前端要显示「同步中」。 */
async function handleSync(url: URL, reply: Reply): Promise<void> {
  const season = resolveSeason(url.searchParams.get('season'));
  // 同步会写库，先备份一次用户数据
  try {
    backupDatabase(db, { dbPath, label: 'pre-sync' });
    pruneBackups();
  } catch {
    // 备份失败不阻断同步
  }
  const result = await syncSeason(db, season, { trigger: 'web', scope: 'season' });
  reply(200, {
    season: { id: season.id, label: season.label },
    written: result.written,
    episodeCount: result.episodeCount,
    mergedAway: result.outcome.mergedAway,
    singleSourceCount: result.outcome.singleSourceCount,
    archive: result.archive,
    /** 身份判定审计（票 A） */
    identity: result.identity,
    /** 被自动归档移动的番的番名 —— 用户要靠这个知道「我的番去哪了」 */
    moved: result.archive.moved,
    reports: result.outcome.reports,
    /** 本次检测到的延期/改档，界面用它弹提示并点亮「变更」徽标 */
    changes: result.changes.map((change) => ({
      subjectKey: change.subjectKey,
      title: change.title,
      epNumber: change.epNumber,
      kind: change.kind,
      kindLabel: changeKindLabel(change.kind),
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      message: change.message,
    })),
  });
}

// ---------------------------------------------------------------------------
// 长时间任务（一键更新 / 补中文名）：后台跑 + 轮询进度 + 停止
// ---------------------------------------------------------------------------
//
// 为什么要它：`POST /api/update` 原本是**同步**的 —— 抓 15 季 + 翻几百条要几分钟，
// 前端只能干等（用户看到的就是「已等待 358 秒」）。现在：
//   POST /api/update?async=1    立刻返回 202 + 任务快照
//   GET  /api/job               轮询：阶段、当前季度、各季结果、机翻 done/total
//   POST /api/job/cancel        请求停止（当前这一季/这一条做完就收尾，已落库的保留）
// 同一时刻只允许一个任务（抓取会写库，两个并行只会互相打架）。
// 同步路径保留：`scripts/verify-api.ts` 与命令行仍按"一次请求拿全部结果"来验。

export type JobStage = 'fetch' | 'translate' | 'done' | 'error' | 'cancelled';

export type JobSnapshot = {
  kind: 'update' | 'translate';
  running: boolean;
  stage: JobStage;
  message: string;
  /** 正在处理的季度（形如 "2020-01"），没有则为 null */
  currentSeason: string | null;
  /** 已出结果的季度（界面直接铺一行：✓ 2021-04 写入 189（新增 132）） */
  seasons: Array<{ season: string; status: string; written: number; added: number }>;
  /** 机翻进度（done/total；没进机翻阶段时 total 为 0） */
  translate: { done: number; total: number };
  startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  result?: unknown;
  error?: string;
};

export type JobContext = {
  shouldCancel: () => boolean;
  onProgress: (message: string) => void;
  onTranslateProgress: (done: number, total: number) => void;
  onSeasonDone: (entry: { season: string; status: string; written: number; added: number }) => void;
};

let activeJob: { snapshot: JobSnapshot; cancelled: boolean; requestCancel: () => void; done: Promise<void> } | null =
  null;

/** 从进度文案里认出「正在抓取 2020-01」这种，好在界面上显示当前季度。 */
function seasonFromMessage(message: string): string | undefined {
  return /(\d{4}-(?:01|04|07|10))/.exec(message)?.[1];
}

/**
 * 起一个后台任务并立刻回 202。
 *
 * 注意 `done` 一律 resolve（不 reject）：任务失败通过 `snapshot.error` 表达，
 * 否则一个未捕获的 rejection 会把服务进程带走。
 */
function beginJob(kind: JobSnapshot['kind'], reply: Reply, run: (ctx: JobContext) => Promise<unknown>): void {
  if (activeJob?.snapshot.running) {
    reply(409, { error: '已经有一个任务在跑，等它结束或先点「停止」', job: activeJob.snapshot });
    return;
  }

  const snapshot: JobSnapshot = {
    kind,
    running: true,
    stage: kind === 'update' ? 'fetch' : 'translate',
    message: kind === 'update' ? '准备开始…' : '准备开始机翻…',
    currentSeason: null,
    seasons: [],
    translate: { done: 0, total: 0 },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancelRequested: false,
  };

  const job: { snapshot: JobSnapshot; cancelled: boolean; requestCancel: () => void; done: Promise<void> } = {
    snapshot,
    cancelled: false,
    requestCancel: () => {
      job.cancelled = true;
      snapshot.cancelRequested = true;
      snapshot.message = '正在停止（当前这一步做完就收尾）…';
    },
    done: Promise.resolve(),
  };
  activeJob = job;

  const ctx: JobContext = {
    shouldCancel: () => job.cancelled,
    onProgress: (message) => {
      snapshot.message = message;
      const season = seasonFromMessage(message);
      if (season) snapshot.currentSeason = season;
      if (message.includes('机翻')) snapshot.stage = 'translate';
    },
    onTranslateProgress: (done, total) => {
      snapshot.stage = 'translate';
      snapshot.translate = { done, total };
    },
    onSeasonDone: (entry) => {
      const list = snapshot.seasons;
      const index = list.findIndex((item) => item.season === entry.season);
      if (index >= 0) list[index] = entry;
      else list.push(entry);
    },
  };

  job.done = (async () => {
    try {
      const result = await run(ctx);
      snapshot.result = result;
      snapshot.stage = job.cancelled ? 'cancelled' : 'done';
      snapshot.message = job.cancelled ? '已停止（已抓到并落库的部分都保留）' : '完成';
    } catch (error) {
      snapshot.stage = 'error';
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.message = `失败：${snapshot.error}`;
    } finally {
      snapshot.running = false;
      snapshot.finishedAt = new Date().toISOString();
      snapshot.currentSeason = null;
    }
  })();

  reply(202, { job: snapshot });
}

/**
 * 一键更新数据（用户诉求 2）。
 *
 * 语义是**全流程**，不是「只抓当季」：
 *   当季抓取 → 历史季度增量回填 → 官方名替换临时机翻 → 缺中文名的做临时机翻 → 汇总报告
 *
 * 参数（都可省略）：
 *   season=2026-10   指定季度，默认当季。**显式挑了 seasons 时，主季 = 你挑的第一个**
 *   seasons=2026-10,2024-10
 *                    自己挑要抓哪些季度：按给定顺序、**跳过中间季度**、
 *                    可以是**库里没有的**老季度。给了它就以它为准，`backfill` 被忽略
 *                    （不是静默忽略：报告里的 scope.backfillIgnored 会说，界面也显示）
 *   backfill=3       回填最近几个季度（含当季，最小 1 —— 0 等同于只抓当季）
 *   incremental=1    增量：跳过「上次真抓过」的季度（不传 = 你勾的季度全都抓）
 *   translate=0      关掉机翻（跑批量翻译很慢）
 *   limit=N          机翻条数上限
 *   force=1          连「上次真抓过」的季度也重抓（与 incremental 同时给时以它为准）
 */
async function handleUpdate(url: URL, reply: Reply): Promise<void> {
  // 异步模式：立刻返回 202，前端轮询 GET /api/job 看进度，POST /api/job/cancel 停止。
  // 抓 15 季 + 翻几百条要几分钟，同步请求让前端只能干等（"已等待 358 秒"就是这么来的）。
  if (url.searchParams.get('async') === '1') {
    beginJob('update', reply, (ctx) =>
      runUpdateForUrl(url, {
        shouldCancel: ctx.shouldCancel,
        onProgress: ctx.onProgress,
        onTranslateProgress: ctx.onTranslateProgress,
        onSeasonDone: ctx.onSeasonDone,
      }),
    );
    return;
  }

  const result = await runUpdateForUrl(url);
  reply(200, formatUpdateResponse(result, resolveSeason(url.searchParams.get('season'))));
}

/** 把 `runFullUpdate` 的返回整理成接口响应（同步 / 异步两条路共用）。 */
function formatUpdateResponse(result: FullUpdateResult, season: SeasonInfo): Record<string, unknown> {
  return {
    season: { id: season.id, label: season.label },
    scope: result.scope,
    summary: result.summary,
    // 身份判定审计（票 A）：界面上能看出"这次拦住了几条本来会变成新重复的行"
    identity: result.identity,
    runId: result.runId,
    cancelled: result.cancelled,
    current: {
      written: result.current.written,
      added: result.current.added,
      schedules: result.current.schedules,
      episodeCount: result.current.episodeCount,
      reports: result.current.reports,
      moved: result.moved,
      changes: result.current.changes.map((change) => ({
        subjectKey: change.subjectKey,
        title: change.title,
        epNumber: change.epNumber,
        kind: change.kind,
        kindLabel: changeKindLabel(change.kind),
        message: change.message,
      })),
    },
    archive: result.archive,
    seasonsRepaired: result.seasonsRepaired,
    healed: result.healed,
    translated: {
      count: result.translated.translated.length,
      skipped: result.translated.skipped,
      candidates: result.translated.candidates,
      titles: result.translated.translated.map((item) => ({
        key: item.key,
        titleOriginal: item.titleOriginal,
        titleCn: item.titleCn,
        engine: item.engine,
      })),
      failed: result.translated.failed,
    },
    backup: result.backup,
  };
}

/** 从 URL 解析「更新数据」的全部参数并跑一遍（同步 / 异步共用）。 */
async function runUpdateForUrl(
  url: URL,
  hooks: {
    shouldCancel?: () => boolean;
    onProgress?: (message: string) => void;
    onTranslateProgress?: (done: number, total: number) => void;
    onSeasonDone?: (entry: { season: string; status: string; written: number; added: number }) => void;
  } = {},
): Promise<FullUpdateResult> {
  const season = resolveSeason(url.searchParams.get('season'));
  // ⚠ 逗号分隔而不是多个同名参数：URLSearchParams.get() 只取第一个，多写几个会静默丢参数
  const seasons = (url.searchParams.get('seasons') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const backfillParam = Number(url.searchParams.get('backfill') ?? DEFAULT_BACKFILL);
  const translate = url.searchParams.get('translate') !== '0';
  const limit = Number(url.searchParams.get('limit') ?? 0);
  const force = url.searchParams.get('force') === '1';
  // 只有显式给了才传 —— 不传时由 runFullUpdate 按范围决定默认值（显式=全抓、回填=增量）
  const incremental = url.searchParams.has('incremental') ? url.searchParams.get('incremental') !== '0' : undefined;

  return runFullUpdate(db, {
    season,
    // ⚠ 有 seasons 时**不要**再传 backfill：传了就变成"两个都给了"，
    //   报告里的 scope.backfillIgnored 会一直为真（明明是服务端自己塞的默认值）。
    ...(seasons.length > 0
      ? { seasons }
      : { backfill: Number.isFinite(backfillParam) ? backfillParam : DEFAULT_BACKFILL }),
    force,
    ...(incremental === undefined ? {} : { incremental }),
    translate,
    translateLimit: Number.isFinite(limit) ? Math.max(0, limit) : 0,
    heal: url.searchParams.get('heal') === '1',
    trigger: 'web',
    ...hooks,
  });
}

/** 只做「补全中文名（机翻）」，不动其它数据。 */
async function handleTranslate(url: URL, reply: Reply): Promise<void> {
  const seasonParam = url.searchParams.get('season');
  const season = seasonParam === 'all' ? null : seasonParam ? resolveSeason(seasonParam).id : null;
  const limit = Number(url.searchParams.get('limit') ?? 0);

  const runTranslate = async (hooks: { shouldCancel?: () => boolean; onTranslateProgress?: (done: number, total: number) => void } = {}) => {
    const result = await translateMissingTitles(db, {
      season,
      limit: Number.isFinite(limit) ? Math.max(0, limit) : 0,
      concurrency: DEFAULT_TRANSLATE_CONCURRENCY,
      ...(hooks.shouldCancel ? { shouldStop: hooks.shouldCancel } : {}),
      onProgress: (done, total) => hooks.onTranslateProgress?.(done, total),
    });

    const remaining = season
      ? listSeasonSubjects(db, season).filter((item) => !item.titleCn).length
      : Number(
          (db.prepare("SELECT COUNT(*) AS n FROM subject WHERE title_cn IS NULL OR title_cn = ''").get() as
            | { n?: number }
            | undefined)?.n ?? 0,
        );

    return {
      season: season ?? 'all',
      translatedCount: result.translated.length,
      skipped: result.skipped,
      candidates: result.candidates,
      translated: result.translated,
      failed: result.failed,
      remaining,
    };
  };

  if (url.searchParams.get('async') === '1') {
    beginJob('translate', reply, (ctx) =>
      runTranslate({ shouldCancel: ctx.shouldCancel, onTranslateProgress: ctx.onTranslateProgress }),
    );
    return;
  }

  reply(200, await runTranslate());
}

/**
 * 「更多 → 停止服务 / 重启服务」的服务端实现。
 *
 * 为什么做成接口而不是继续用桌面 .cmd（`taskkill /F` 硬杀）：
 *   1. 硬杀不会 checkpoint WAL；虽然 SQLite 崩溃安全，但每次都要去桌面找快捷方式太绕；
 *   2. 网页里停 / 重启才能在「改了 src/ 忘了重启」时一条路走通（这次踩过的坑）。
 *
 * 安全：只接受 `POST` + `application/json` + `{"confirm":true}`。
 * 跨站请求发不了 application/json（要预检），而本服务不回 CORS 头，别的网页关不掉它。
 */
async function readServiceAction(
  req: IncomingMessage,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    return { ok: false, status: 400, error: '需要 application/json 请求体（防止其它网页误触）' };
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  if (body.confirm !== true) return { ok: false, status: 400, error: '缺少 confirm: true' };
  if (activeJob?.snapshot.running) {
    return { ok: false, status: 409, error: '还有任务在跑：先点顶栏「停止」把它收尾，再停服务' };
  }
  return { ok: true };
}

/**
 * 优雅退出：先 checkpoint 再关库。
 *
 * `server.close()` 会等现有连接结束；万一 keep-alive 迟迟不断，最多等 2 秒强退
 * （数据已经 checkpoint 过，强退也不会丢）。
 */
function closeAndExit(after?: () => void): void {
  const finish = () => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* checkpoint 失败不影响退出 */
    }
    try {
      db.close();
    } catch {
      /* 已经关过就算了 */
    }
    after?.();
    process.exit(0);
  };
  const force = setTimeout(finish, 2000);
  force.unref?.();
  server.close(() => {
    clearTimeout(force);
    finish();
  });
}

/** 先把 200 的响应发出去，再关 —— 否则页面只会看到连接被重置。 */
function scheduleShutdown(): void {
  setTimeout(() => closeAndExit(() => console.log('服务已停止（网页触发）。')), 120);
}

function scheduleRestart(): void {
  setTimeout(() => {
    closeAndExit(() => {
      try {
        const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
        // 把这些日志写进文件：重启出来的进程没有控制台，起不来时不然没人知道为什么。
        // 放在库文件旁边（data/restart.log），与 launcher.log 分开，* .log 已被 gitignore。
        let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
        try {
          const fd = openSync(path.join(path.dirname(dbPath), 'restart.log'), 'a');
          stdio = ['ignore', fd, fd];
        } catch {
          /* 日志写不了就静默启动，不因为日志拖垮重启 */
        }
        const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'server', 'server.ts')], {
          cwd: projectRoot,
          env: process.env,
          detached: true,
          stdio,
          windowsHide: true,
        });
        child.unref();
        console.log('服务已重启（新进程已拉起）。');
      } catch (error) {
        console.error('重启失败：', error);
      }
    });
  }, 120);
}

/**
 * 组装「我的数据」的导出内容（追番列表 + 进度 + 手动修正 + 变更记录）。
 *
 * 用户把追番列表当资产，所以必须能一键拿走 —— 而且导出的东西要能看懂，
 * 所以顺带带上番剧名这类人类可读信息（见 docs/决策记录.md D10）。
 */
function buildExportPayload(): Record<string, unknown> {
  const myAnimeRows = db
    .prepare(
      `SELECT m.*, s.title_cn, s.title_original, s.season, s.status
       FROM my_anime m LEFT JOIN subject s ON s.key = m.subject_key
       ORDER BY m.category, m.priority`,
    )
    .all() as unknown as Array<Record<string, unknown>>;

  const overrides = db.prepare('SELECT * FROM schedule_override ORDER BY subject_key, ep_number').all() as unknown as Array<
    Record<string, unknown>
  >;

  const changes = listChanges(db, 1000, false);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 2,
    dbPath,
    note: '这是「属于你的数据」的导出：追番列表与进度、手动修正、变更历史。抓来的番剧数据可随时重新抓取，因此不在此列。',
    counts: {
      myAnime: myAnimeRows.length,
      overrides: overrides.length,
      changes: changes.length,
    },
    myAnime: myAnimeRows.map((row) => ({
      subjectKey: row.subject_key,
      title: row.title_cn ?? row.title_original,
      titleOriginal: row.title_original,
      season: row.season,
      status: row.status,
      category: row.category,
      watchedEps: row.watched_eps,
      notifyEnabled: row.notify_enabled === 1,
      plannedWeekdayJst: row.planned_weekday_jst,
      plannedEpsPerDay: row.planned_eps_per_day,
      priority: row.priority,
      note: row.note,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
    })),
    overrides: overrides.map((row) => ({
      subjectKey: row.subject_key,
      epNumber: row.ep_number,
      airAtUtc: row.air_at_utc,
      pubAtUtc: row.pub_at_utc,
      reason: row.reason,
      updatedAt: row.updated_at,
    })),
    changes: changes.map((change) => ({
      subjectKey: change.subjectKey,
      title: change.title,
      epNumber: change.epNumber,
      field: change.field,
      kind: change.kind,
      oldValue: change.oldValue,
      newValue: change.newValue,
      detectedAt: change.detectedAt,
    })),
  };
}

/** 导出 .ics：这是「手机上也能看」成本最低的方案。 */
function handleIcs(res: ServerResponse, url: URL): void {
  const season = resolveSeason(url.searchParams.get('season'));
  const rule = resolveRule(url.searchParams.get('rule'));

  // 覆盖「过去 7 天 ~ 未来 120 天」，足够一个季度用
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 120 * 86_400_000).toISOString();
  const items = listSchedule(db, from, to, { category: 'tracking' });

  // 按放送日历导出时，把次日凌晨（24:xx / 25:xx）的集回退一天，
  // 这样导入手机日历后看到的日子与日本排期表一致。
  // 注意同时保留 originalAirAtUtc：描述文本里的放送时刻必须是真实时刻。
  const adjusted =
    rule === 'broadcast-calendar'
      ? items.map((item) => {
          const time = item.broadcastTimeJst;
          if (!time || !item.airAtUtc) return item;
          const overflow = Number(time.slice(0, 2)) >= 24;
          return overflow
            ? {
                ...item,
                originalAirAtUtc: item.airAtUtc,
                airAtUtc: new Date(Date.parse(item.airAtUtc) - 86_400_000).toISOString(),
              }
            : item;
        })
      : items;

  const ics = buildIcs(adjusted, { calendarName: `新番追番日历 ${season.label}` });
  res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${icsFileName(season.id)}"`,
    'cache-control': 'no-store',
  });
  res.end(ics);
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, relative);

  // 防目录穿越：解析后的路径必须仍在 web/ 之内
  if (!target.startsWith(path.resolve(WEB_DIR))) {
    sendText(res, 403, '禁止访问');
    return;
  }

  try {
    const content = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendText(res, 404, `找不到 ${pathname}`);
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = url.pathname;
    const reply: Reply = (status, payload) => sendJson(res, status, payload);

    try {
      if (!pathname.startsWith('/api/')) {
        await serveStatic(res, pathname);
        return;
      }

      if (pathname === '/api/health') {
        reply(200, { ok: true, stats: stats(db), now: new Date().toISOString() });
        return;
      }

      if (pathname === '/api/runs' && req.method === 'GET') {
        // 运行记录（票 A）：跨运行留痕。?limit=N，默认 10。
        const limitParam = Number(url.searchParams.get('limit') ?? 10);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, Math.floor(limitParam))) : 10;
        reply(200, { runs: listSyncRuns(db, limit) });
        return;
      }

      if (pathname === '/api/overview' && req.method === 'GET') {
        handleOverview(url, reply);
        return;
      }

      if (pathname === '/api/week' && req.method === 'GET') {
        handleWeek(url, reply);
        return;
      }

      if (pathname === '/api/my' && req.method === 'GET') {
        handleMy(reply);
        return;
      }

      // 加入追番 / 补番库
      if (pathname === '/api/my' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const subjectKey = String(body.subjectKey ?? '');
        if (!subjectKey) {
          reply(400, { error: '缺少 subjectKey' });
          return;
        }
        const requested = String(body.category ?? 'tracking') as TrackCategory;
        addMyAnime(db, subjectKey, {
          category: TRACK_CATEGORIES.includes(requested) ? requested : 'tracking',
          watchedEps: Number(body.watchedEps ?? 0) || 0,
        });
        reply(200, { ok: true });
        return;
      }

      const myMatch = /^\/api\/my\/(.+)$/.exec(pathname);
      if (myMatch?.[1]) {
        const key = decodeURIComponent(myMatch[1]);

        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          if (typeof body.category === 'string' && TRACK_CATEGORIES.includes(body.category as TrackCategory)) {
            setCategory(db, key, body.category as TrackCategory);
          }
          if (typeof body.watchedEps === 'number' && Number.isFinite(body.watchedEps)) {
            setWatchedEps(db, key, body.watchedEps);
          }
          if (
            body.plannedWeekdayJst !== undefined ||
            body.plannedEpsPerDay !== undefined ||
            typeof body.priority === 'number'
          ) {
            setBacklogPlan(db, key, {
              plannedWeekdayJst:
                body.plannedWeekdayJst === null || typeof body.plannedWeekdayJst === 'number'
                  ? (body.plannedWeekdayJst as number | null)
                  : undefined,
              plannedEpsPerDay:
                body.plannedEpsPerDay === null || typeof body.plannedEpsPerDay === 'number'
                  ? (body.plannedEpsPerDay as number | null)
                  : undefined,
              ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
            });
          }
          reply(200, { ok: true });
          return;
        }

        if (req.method === 'DELETE') {
          reply(200, { ok: true, removed: removeMyAnime(db, key) });
          return;
        }
      }

      // 手动修正某一集的时间（优先级最高，永不被自动同步覆盖）
      if (pathname === '/api/override' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const subjectKey = String(body.subjectKey ?? '');
        const epNumber = Number(body.epNumber);
        if (!subjectKey || !Number.isFinite(epNumber)) {
          reply(400, { error: '需要 subjectKey 与 epNumber' });
          return;
        }
        setOverride(db, subjectKey, epNumber, {
          airAtUtc: typeof body.airAtUtc === 'string' ? body.airAtUtc : null,
          pubAtUtc: typeof body.pubAtUtc === 'string' ? body.pubAtUtc : null,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
        reply(200, { ok: true });
        return;
      }

      const subjectMatch = /^\/api\/subject\/(.+)$/.exec(pathname);
      if (subjectMatch?.[1] && req.method === 'GET') {
        const detail = getSubjectDetail(db, decodeURIComponent(subjectMatch[1]));
        if (!detail) {
          reply(404, { error: '找不到这部番' });
          return;
        }
        reply(200, { subject: detail });
        return;
      }

      if (pathname === '/api/search' && req.method === 'GET') {
        await handleSearch(url, reply);
        return;
      }

      // 把远程搜索结果落库，返回内部 key 供「加入列表」使用
      if (pathname === '/api/search/import' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = RawSeasonAnimeSchema.safeParse(body.raw);
        if (!parsed.success) {
          reply(400, { error: 'raw 不是合法的原始条目（来源结构可能已变）' });
          return;
        }

        const merged = mergeSubjects([[parsed.data]]);
        const subject = merged.subjects[0];
        if (!subject) {
          reply(400, { error: '融合结果为空' });
          return;
        }

        // 库里已有同一部番（例如季度同步已经落过）就复用它，避免产生重复记录。
        // ⚠ 走统一的身份判定（票 A）：只按外部 ID 查会漏掉"老行没有 ID"这个主形态
        //   （实测 384 行没有任何外部 ID），退到归一化标题才能命中。
        const decision = resolveSubjectIdentity(db, subject);
        if (decision.match !== 'none') {
          const reused = getSubjectDetail(db, decision.suggestedKey);
          reply(200, {
            subjectKey: decision.suggestedKey,
            reused: true,
            title: reused?.titleCn ?? reused?.titleOriginal ?? decision.suggestedKey,
            matchedBy: decision.match,
            // 复用分支也要给出季度：界面靠它告诉用户这部番归在哪一季
            // （否则从搜索加入一部库里已有的番时，界面上不会提示去哪里找它）
            season: getSubjectSeason(db, decision.suggestedKey),
          });
          return;
        }

        // 季度要尽量回填：以前一律写 null，导致从搜索加入的番在全季总览里永远看不到
        // （总览按 WHERE season = ? 过滤），只能在「我的追番」里找到 —— 用户会以为"加进去的番没了"。
        // 顺序：数据源给的季度 > 调用方指定的季度（前端处于某季时带上）> 由放送时刻推导。
        const requested = url.searchParams.get('season');
        const fallbackSeason = requested && requested !== 'all' ? resolveSeason(requested).id : null;
        const seasonForImport = subject.season ?? fallbackSeason;
        upsertSubjects(db, [subject], seasonForImport);
        reply(200, {
          subjectKey: subject.key,
          reused: false,
          title: subject.titleCn ?? subject.titleOriginal,
          season: getSubjectSeason(db, subject.key),
        });
        return;
      }

      if (pathname === '/api/sync' && req.method === 'POST') {
        await handleSync(url, reply);
        return;
      }

      // 一键更新数据：当季 + 历史回填 + 机翻 + 汇总报告
      if (pathname === '/api/update' && req.method === 'POST') {
        await handleUpdate(url, reply);
        return;
      }

      // 只补中文名（机翻），不动其它数据
      if (pathname === '/api/translate' && req.method === 'POST') {
        await handleTranslate(url, reply);
        return;
      }

      // 停止 / 重启本机服务（网页「更多」里的两个动作）
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        const verdict = await readServiceAction(req);
        if (!verdict.ok) {
          reply(verdict.status, { error: verdict.error });
          return;
        }
        reply(200, { ok: true, message: '服务已停止' });
        scheduleShutdown();
        return;
      }
      if (pathname === '/api/restart' && req.method === 'POST') {
        const verdict = await readServiceAction(req);
        if (!verdict.ok) {
          reply(verdict.status, { error: verdict.error });
          return;
        }
        reply(200, { ok: true, message: '正在重启服务' });
        scheduleRestart();
        return;
      }

      // 长任务进度（一键更新 / 补中文名）：前端轮询它画进度条
      if (pathname === '/api/job' && req.method === 'GET') {
        reply(200, { job: activeJob?.snapshot ?? null });
        return;
      }

      // 请求停止当前长任务（当前这一步做完就收尾，已落库的保留）
      if (pathname === '/api/job/cancel' && req.method === 'POST') {
        if (!activeJob || !activeJob.snapshot.running) {
          reply(200, { ok: false, job: activeJob?.snapshot ?? null, note: '当前没有在跑的任务' });
          return;
        }
        activeJob.requestCancel();
        reply(200, { ok: true, job: activeJob.snapshot });
        return;
      }

      // 导出「我的数据」（追番列表 / 进度 / 手动修正 / 变更历史）
      if (pathname === '/api/export' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="anime-tracker-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(buildExportPayload(), null, 2));
        return;
      }

      if (pathname === '/api/changes' && req.method === 'GET') {
        const onlyUnacknowledged = url.searchParams.get('all') !== '1';
        const changes = listChanges(db, 200, onlyUnacknowledged).map((change) => ({
          ...change,
          kindLabel: changeKindLabel(change.kind),
          message: describeChangeItem(change),
        }));
        reply(200, { changes, pending: stats(db).pendingChanges });
        return;
      }

      if (pathname === '/api/changes/ack' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
          : undefined;
        reply(200, { ok: true, acknowledged: acknowledgeChanges(db, ids) });
        return;
      }

      if (pathname === '/api/ics' && req.method === 'GET') {
        handleIcs(res, url);
        return;
      }

      reply(404, { error: `未知接口：${pathname}` });
    } catch (error) {
      console.error(`[api] ${req.method} ${pathname} 失败：`, error);
      reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

/**
 * 监听端口。被占用时自动重试一小会儿 —— 「重启服务」的旧进程刚退出时，
 * 端口可能还没完全释放；直接 EADDRINUSE 会让重启看起来"点了没反应"。
 * 用户自己双击快捷方式两次也能被这条兜住（不会第二个进程默默崩掉）。
 */
let listenAttempts = 0;
function startListening(): void {
  server.listen(PORT, HOST, () => {
    console.log(`新番追番日历已启动：http://${HOST}:${PORT}`);
    console.log(`数据库：${dbPath}`);
    console.log('按 Ctrl+C 停止。');
  });
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && listenAttempts < 20) {
    listenAttempts += 1;
    console.log(`端口 ${PORT} 还被占着，300ms 后重试（${listenAttempts}/20）…`);
    setTimeout(startListening, 300);
    return;
  }
  console.error('服务启动失败：', error);
  process.exit(1);
});

startListening();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    // 与网页「停止服务」走同一条退出路径：checkpoint WAL → 关库 → 退出
    closeAndExit();
  });
}
