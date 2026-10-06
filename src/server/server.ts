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
import { DATA_DIR } from '../providers/snapshot.ts';
import {
  acknowledgeChanges,
  addMyAnime,
  availableSeasons,
  backupDatabase,
  findSubjectByExternalId,
  getSubjectDetail,
  getSubjectSeason,
  listChanges,
  listMyAnime,
  listSchedule,
  listSeasonSubjects,
  listUpcoming,
  migrate,
  openDb,
  pruneBackups,
  removeMyAnime,
  resolveSeasonSort,
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

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const dbPath = path.join(DATA_DIR, 'anime.db');
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
  const result = await syncSeason(db, season);
  reply(200, {
    season: { id: season.id, label: season.label },
    written: result.written,
    episodeCount: result.episodeCount,
    mergedAway: result.outcome.mergedAway,
    singleSourceCount: result.outcome.singleSourceCount,
    archive: result.archive,
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
 *   translate=0      关掉机翻（跑批量翻译很慢）
 *   limit=N          机翻条数上限
 *   force=1          已有数据的季度也重抓
 */
async function handleUpdate(url: URL, reply: Reply): Promise<void> {
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

  const result = await runFullUpdate(db, {
    season,
    // ⚠ 有 seasons 时**不要**再传 backfill：传了就变成"两个都给了"，
    //   报告里的 scope.backfillIgnored 会一直为真（明明是服务端自己塞的默认值）。
    ...(seasons.length > 0
      ? { seasons }
      : { backfill: Number.isFinite(backfillParam) ? backfillParam : DEFAULT_BACKFILL }),
    force,
    translate,
    translateLimit: Number.isFinite(limit) ? Math.max(0, limit) : 0,
    heal: url.searchParams.get('heal') === '1',
  });

  reply(200, {
    season: { id: season.id, label: season.label },
    scope: result.scope,
    summary: result.summary,
    current: {
      written: result.current.written,
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
  });
}

/** 只做「补全中文名（机翻）」，不动其它数据。 */
async function handleTranslate(url: URL, reply: Reply): Promise<void> {
  const seasonParam = url.searchParams.get('season');
  const season = seasonParam === 'all' ? null : seasonParam ? resolveSeason(seasonParam).id : null;
  const limit = Number(url.searchParams.get('limit') ?? 0);

  const result = await translateMissingTitles(db, {
    season,
    limit: Number.isFinite(limit) ? Math.max(0, limit) : 0,
    minIntervalMs: 700,
  });

  reply(200, {
    season: season ?? 'all',
    translatedCount: result.translated.length,
    skipped: result.skipped,
    candidates: result.candidates,
    translated: result.translated,
    failed: result.failed,
    remaining: listSeasonSubjects(db, season ?? resolveSeason(null).id).filter((s) => !s.titleCn).length,
  });
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

        // 库里已有同一部番（例如季度同步已经落过）就复用它，避免产生重复记录
        const existing = findSubjectByExternalId(db, {
          bgmId: subject.bgmId,
          anilistId: subject.anilistId,
          malId: subject.malId,
        });
        if (existing) {
          reply(200, {
            subjectKey: existing.key,
            reused: true,
            title: existing.titleCn ?? existing.titleOriginal,
            // 复用分支也要给出季度：界面靠它告诉用户这部番归在哪一季
            // （否则从搜索加入一部库里已有的番时，界面上不会提示去哪里找它）
            season: getSubjectSeason(db, existing.key),
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

server.listen(PORT, HOST, () => {
  console.log(`新番追番日历已启动：http://${HOST}:${PORT}`);
  console.log(`数据库：${path.join(DATA_DIR, 'anime.db')}`);
  console.log('按 Ctrl+C 停止。');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
