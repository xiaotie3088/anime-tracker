/**
 * SQLite 数据访问层。
 *
 * 刻意使用 Node 24 内置的 `node:sqlite`，不引入 better-sqlite3：
 *   - 没有原生模块编译问题（Windows 上装 node-gyp 是常见的坑）
 *   - 零依赖，`node scripts/verify.ts` 可以在没装任何包的情况下跑起来
 * 代价：node:sqlite 目前仍是实验特性，启动时会打印一条 ExperimentalWarning，可忽略。
 *
 * 本文件对外只暴露「领域对象」（camelCase），SQL 的 snake_case 行结构留在内部，
 * 这样 UI 层不需要认识数据库列名。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { shouldArchiveToBacklog } from '../core/backlog.ts';
import { normalizeTitle } from '../core/merge.ts';
import { decideMachineTranslation } from '../core/mt.ts';
import { seasonOf, shiftSeason } from '../core/time.ts';
import type { AiringStatus, Episode, Platform, Subject, TitleCnSource, TrackCategory } from '../core/types.ts';
import { DATA_DIR } from '../providers/snapshot.ts';

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export const DEFAULT_DB_PATH = path.join(DATA_DIR, 'anime.db');
/** 备份目录：用户数据（追番列表 / 进度 / 补番库）不可重建，所以要有兜底。 */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/**
 * 库结构版本。
 *
 *   2 -> 3：新增 `sync_run`（每次同步的运行记录，见 schema.sql 与票 A）。
 *           `migrate()` 里 `db.exec(SCHEMA_SQL)` 本身是幂等的 `IF NOT EXISTS`，
 *           所以新表不需要额外迁移语句 —— 提版本号是为了让"库是新的还是旧的"可查。
 */
export const SCHEMA_VERSION = 3;

/** node:sqlite 只接受 null / number / string / bigint / Uint8Array，布尔和 undefined 必须转换。 */
type BindValue = null | number | string | bigint | Uint8Array;

function bind(value: unknown): BindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function bindAll(values: readonly unknown[]): BindValue[] {
  return values.map(bind);
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 打开与建表
// ---------------------------------------------------------------------------

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  if (dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL 不可用时退回默认日志模式，不影响功能
    }
  }
  return db;
}

/** 幂等建表。所有语句都是 IF NOT EXISTS，可以每次启动都跑。 */
export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  // 轻量迁移：给已存在的库补上后来新增的列（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
  ensureColumn(db, 'change_log', 'kind', 'TEXT');
  // 临时机翻译名（见 docs/决策记录.md D8）。历史数据这两列为 NULL，语义上等于 official。
  ensureColumn(db, 'subject', 'title_cn_source', 'TEXT');
  ensureColumn(db, 'subject', 'title_cn_source_at', 'TEXT');
  // 运行记录（票 A）：新表由 schema.sql 建，但**已存在的库**建表时还没有这一列，
  // 而 `CREATE TABLE IF NOT EXISTS` 不会给老表补列 —— 所以这里显式补。
  ensureColumn(db, 'sync_run', 'parent_run_id', 'INTEGER');
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  setMeta(db, 'migrated_at', nowIso());
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

// ---------------------------------------------------------------------------
// subject / episode 写入
// ---------------------------------------------------------------------------

const SUBJECT_COLUMNS = [
  'key',
  'bgm_id',
  'anilist_id',
  'mal_id',
  'bili_season_id',
  'title_cn',
  'title_cn_source',
  'title_cn_source_at',
  'title_original',
  'title_en',
  'aliases',
  'cover_url',
  'synopsis',
  'media_type',
  'total_eps',
  'duration_min',
  'studios',
  'genres',
  'status',
  'season',
  'first_air_at_utc',
  'broadcast_weekday_jst',
  'broadcast_time_jst',
  'platforms',
  'sources',
  'field_sources',
  'updated_at',
] as const;

/**
 * 这几列在「新值缺失」时必须保留库里的旧值，不能让 UPSERT 清空。
 *
 * 为什么需要：机翻名是**兜底占位**，它不在任何数据源里。
 * 下次同步当季时，融合结果是「这部番没有官方中文名」= title_cn 为空，
 * 如果按普通 UPSERT 的 `title_cn = excluded.title_cn` 写下去，
 * 刚翻好的中文名会被立刻清掉 —— 那就成了「每次进入项目记录都会消失」的又一个实例。
 *
 * 语义：
 *   - 官方名到了（excluded.title_cn 非空）-> 覆盖机翻名，并把出处改回 'official'
 *   - 官方名还没到（excluded.title_cn 为空）-> 原样保留机翻名与出处
 */
const PRESERVE_WHEN_EMPTY = [
  'title_cn',
  'title_cn_source',
  'title_cn_source_at',
  // 外部 ID 也要保住（票 A 实测踩到过）：一次「只有 yuc 成功」的同步里，
  // 融合结果**没有任何外部 ID**，如果按 `bgm_id = excluded.bgm_id` 写下去，
  // 库里已经识别出来的 `bgm_id` 就被清成了 NULL ——
  // 而身份判定正是靠它认人，清掉之后下一次又会退化成按标题匹配。
  // 语义：这一列这次没给值就保留旧值；给了值（说明数据源这次认出了它）就覆盖。
  'bgm_id',
  'anilist_id',
  'mal_id',
  // bili_season_id 不在列清单里（见 SUBJECT_COLUMNS），所以这里也不用写
] as const;

/** 由列清单生成 UPSERT，避免手写 27 个占位符时数错。 */
function buildUpsert(
  table: string,
  columns: readonly string[],
  keys: readonly string[],
  preserveWhenEmpty: readonly string[] = [],
): string {
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((c) => !keys.includes(c))
    .map((c) =>
      preserveWhenEmpty.includes(c)
        ? // COALESCE 的第一个参数是「列更新后本该有的值」，为空则退回旧值
          `${c} = COALESCE(excluded.${c}, ${table}.${c})`
        : `${c} = excluded.${c}`,
    )
    .join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
          ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${updates}`;
}

const UPSERT_SUBJECT_SQL = buildUpsert('subject', SUBJECT_COLUMNS, ['key'], PRESERVE_WHEN_EMPTY);

function subjectValues(subject: Subject, season: string | null, updatedAt: string): unknown[] {
  // ⚠ 出处必须跟着「这次到底有没有给出官方中文名」走，不能照抄 subject.titleCnSource。
  //
  // SubjectSchema 的 titleCnSource 默认值是 'official'，而融合结果里 titleCn 为空时
  // 这个默认值依然在。如果直接写它，普普通通的一次同步就会把机翻名的出处
  // 从 'machine' 改成 'official' —— 实测踩到过：34 条机翻名全部变成 official，
  // 界面上再也提示不出「临时机翻」，官方名替换逻辑也随之失效。
  //
  // 所以：这次给出了官方中文名 -> 'official'；没给出 -> 写 NULL，
  // 让 PRESERVE_WHEN_EMPTY 的 COALESCE 保住库里原有的出处。
  const titleCn = (subject.titleCn ?? '').trim();
  const titleCnSource: TitleCnSource | null = titleCn === '' ? null : 'official';
  return [
    subject.key,
    subject.bgmId ?? null,
    subject.anilistId ?? null,
    subject.malId ?? null,
    subject.biliSeasonId ?? null,
    titleCn === '' ? null : titleCn,
    titleCnSource,
    // 机翻时刻只由 applyMachineTitle 维护；普通同步写入时留空，靠 COALESCE 保住旧值
    null,
    subject.titleOriginal ?? null,
    subject.titleEn ?? null,
    JSON.stringify(subject.aliases ?? []),
    subject.coverUrl ?? null,
    subject.synopsis ?? null,
    subject.mediaType,
    subject.totalEps ?? null,
    subject.durationMin ?? null,
    JSON.stringify(subject.studios ?? []),
    JSON.stringify(subject.genres ?? []),
    subject.status,
    season,
    subject.firstAirAtUtc ?? null,
    subject.broadcastWeekdayJst ?? null,
    subject.broadcastTimeJst ?? null,
    JSON.stringify(subject.platforms ?? []),
    JSON.stringify(subject.sources ?? []),
    JSON.stringify(subject.fieldSources ?? {}),
    updatedAt,
  ];
}

const EPISODE_COLUMNS = [
  'subject_key',
  'ep_number',
  'title',
  'title_cn',
  'air_at_utc',
  'pub_at_utc',
  'broadcast_weekday_jst',
  'duration_min',
  'air_source',
  'pub_source',
  'conflicting',
] as const;

const UPSERT_EPISODE_SQL = buildUpsert('episode', EPISODE_COLUMNS, ['subject_key', 'ep_number']);

function episodeValues(subjectKey: string, ep: Episode, durationMin: number | null): unknown[] {
  return [
    subjectKey,
    ep.epNumber,
    ep.title ?? null,
    ep.titleCn ?? null,
    ep.airAtUtc ?? null,
    ep.pubAtUtc ?? null,
    ep.broadcastWeekdayJst ?? null,
    ep.durationMin ?? durationMin,
    ep.airSource ?? null,
    ep.pubSource ?? null,
    ep.conflicting ? 1 : 0,
  ];
}

/**
 * 决定这次写入该把条目算进哪个季度。
 *
 * 为什么需要这个函数 —— 实测踩到的**真回归**：
 * 回填 2026-07 时，AniList 的"上一季"查询会返回一批**当前仍在播**的番
 * （跨季连续放送的番本来就同时出现在两个季度的清单里）。
 * 无条件 `season = excluded.season` 的结果是：这批番把当季条目的 season 改写成了旧季度 ——
 * 实测 63 部本该属于 2026-10 的番被写成了 2026-07，当季总览从 123 部掉到 56 部。
 *
 * 判据是**条目自己的首播/分集时刻**，不是"谁最后写入"，也不是"落在哪个加宽窗口"：
 * 加宽窗口会重叠（实测 2026-07 加宽后能覆盖到 10-07），拿它判会继续误判。
 * 真正的季度归属只有一处可靠来源：这一集是什么时候播的。
 *
 * 规则（按顺序判定）：
 *   1. 推不出季度（没有首播也没有分集时刻：补番库的老番、只有标题的脏数据）
 *      -> 不动已有归属
 *   2. 推出的季度就是本次写入的 -> 认领
 *      （跨季连续放送的番会在每一季都被认领到最新的那一季）
 *   3. 否则**以推出的季度为准**，纠正已有归属。归属只由「集数最小的那一集的时刻」决定，
 *      与写入顺序无关 —— 这一点很关键，实测踩到过：先写当季、后回填旧季，
 *      交叠的条目就会被判给旧季，当季总览从 123 部掉到 56 部。
 */
export function resolveSeasonForWrite(
  db: DatabaseSync,
  key: string,
  season: string | null,
  firstAirAtUtc: string | null | undefined,
  episodes: readonly { epNumber: number; airAtUtc?: string | null | undefined }[] = [],
): string | null {
  if (!season) return season;

  const derived = deriveSeasonFromAirTimes(firstAirAtUtc, episodes);

  const row = db.prepare('SELECT season FROM subject WHERE key = ?').get(key) as
    | { season: string | null }
    | undefined;
  const existing = row?.season ?? null;

  // 1) 推不出季度 -> 保守：只填不抢
  if (!derived) return existing ?? season;

  // 2) 就是本季
  if (derived === season) return season;

  // 3) 它属于别的季度 -> 纠正（哪怕库里已有归属）
  return derived;
}

/**
 * 从时刻推出季度。
 *
 * 判据优先级（这是刻意的，每一层都有实测理由）：
 *   1. **集数最小那一集的放送时刻**（不是"数组里的第一个"，这里会按集数自己排序）。
 *      它是这个日历真正用来排序的那个时刻，而且跨季连续放送的番在它上面永远一致 ——
 *      不像 `firstAirAtUtc` 会因为数据源不同而在两次同步之间时有时无（那会让归属来回抖动）。
 *      必须是"第 1 集"而不是"最早的一集"：重播/回顾特别篇可能排在第 1 集之前，
 *      不能让它把整部番拉走。
 *   2. 没有任何分集时刻才退回 `firstAirAtUtc`（源站给出的首播时刻）。
 *
 * 为什么不做"取两者最小" —— 实测：有些番在**上一季末尾就有先行配信**
 * （10-03 首播的番，第 1 集时刻是 09-25 22:16）。取最小会把它判成 7 月番，
 * 而当季总览看的正是这个归属。
 *
 * ⚠ 比较时刻必须先 `Date.parse` 转成毫秒，**不能直接比字符串**：
 * `'2026-10-03…' < '2026-09-25…'` 在字典序下为 true（'1' < '9'），
 * 日期字符串的字典序只在格式完全一致时才等于时间顺序。
 */
function deriveSeasonFromAirTimes(
  firstAirAtUtc: string | null | undefined,
  episodes: readonly { epNumber: number; airAtUtc?: string | null | undefined }[],
): string | null {
  const seasonOfMs = (ms: number): string | null => {
    try {
      return seasonOf(new Date(ms)).id;
    } catch {
      return null;
    }
  };

  // 1) 按集数升序找第一个有有效时刻的分集
  const ordered = [...episodes].sort((a, b) => a.epNumber - b.epNumber);
  for (const episode of ordered) {
    if (!episode.airAtUtc) continue;
    const ms = Date.parse(episode.airAtUtc);
    if (!Number.isFinite(ms)) continue;
    const derived = seasonOfMs(ms);
    if (derived) return derived;
  }

  // 2) 退回首播时刻
  if (firstAirAtUtc) {
    const ms = Date.parse(firstAirAtUtc);
    if (Number.isFinite(ms)) return seasonOfMs(ms);
  }
  return null;
}

/**
 * 纠正整个库里「季度归属与实际放送时刻不符」的条目。
 *
 * 为什么必须有这一步 —— `resolveSeasonForWrite` 只能让**当前正在写的那批**归属正确，
 * 而归属的正误取决于写入顺序：先写当季、后回填旧季，交叠的条目就会被判给旧季。
 * 实测就是如此：210 部 7 月清单最后写入，于是把一批 10 月新番也拉进了 7 月，
 * 当季总览从 123 部掉到 56 部。
 *
 * 所以每次同步/更新结束后再统一纠一遍：**以条目自己的最早时刻为唯一依据**，
 * 与写入顺序无关。没有时刻可判定的条目（补番库老番）保持不动。
 *
 * @param scopeSeason 只纠正这个季度及其前后的条目；不传则全库纠正
 * @returns 被纠正的条数
 */
export function repairSeasonAssignments(db: DatabaseSync, scopeSeason?: string | null): number {
  const rows = db
    .prepare(
      `SELECT s.key,
              s.season,
              s.first_air_at_utc,
              (SELECT e.air_at_utc FROM episode e
                WHERE e.subject_key = s.key AND e.air_at_utc IS NOT NULL
                ORDER BY e.ep_number LIMIT 1) AS first_ep
       FROM subject s
       WHERE s.season IS NOT NULL AND s.season <> ''`,
    )
    .all() as unknown as Array<{
    key: string;
    season: string;
    first_air_at_utc: string | null;
    first_ep: string | null;
  }>;

  // 纠错范围：目标季度 ± 1 季，避免为了一部番去扫全库
  const scope = new Set<string>();
  if (scopeSeason) {
    scope.add(scopeSeason);
    scope.add(shiftSeason(scopeSeason, -1));
    scope.add(shiftSeason(scopeSeason, 1));
  }

  const update = db.prepare('UPDATE subject SET season = ?, updated_at = ? WHERE key = ?');
  let repaired = 0;

  for (const row of rows) {
    if (scope.size > 0 && !scope.has(row.season)) continue;
    // 判据与写入时完全一致：优先「集数最小的那一集」的时刻（SQL 已按 ep_number 取第一条）
    const derived = deriveSeasonFromAirTimes(row.first_air_at_utc, [
      { epNumber: 1, airAtUtc: row.first_ep },
    ]);
    if (!derived || derived === row.season) continue;
    update.run(derived, nowIso(), row.key);
    repaired += 1;
  }

  return repaired;
}

/** 写入一部番及其分集（同一事务）。 */
export function upsertSubject(db: DatabaseSync, subject: Subject, season: string | null = null): void {
  const updatedAt = nowIso();
  const effectiveSeason = resolveSeasonForWrite(
    db,
    subject.key,
    season,
    subject.firstAirAtUtc,
    subject.episodes,
  );
  db.exec('BEGIN');
  try {
    db.prepare(UPSERT_SUBJECT_SQL).run(...bindAll(subjectValues(subject, effectiveSeason, updatedAt)));

    const epStmt = db.prepare(UPSERT_EPISODE_SQL);
    for (const ep of subject.episodes) {
      epStmt.run(...bindAll(episodeValues(subject.key, ep, subject.durationMin ?? null)));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 批量写入，返回写入条数。 */
export function upsertSubjects(db: DatabaseSync, subjects: readonly Subject[], season: string | null = null): number {
  for (const subject of subjects) upsertSubject(db, subject, season);
  return subjects.length;
}

// ---------------------------------------------------------------------------
// 我的追番 / 补番库
// ---------------------------------------------------------------------------

export function addMyAnime(
  db: DatabaseSync,
  subjectKey: string,
  options: { category?: TrackCategory; watchedEps?: number; priority?: number; note?: string } = {},
): void {
  const { category = 'tracking', watchedEps = 0, priority = 100, note } = options;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO my_anime (subject_key, category, watched_eps, priority, note, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_key) DO UPDATE SET
       category = excluded.category,
       priority = excluded.priority,
       note = COALESCE(excluded.note, my_anime.note),
       updated_at = excluded.updated_at`,
  ).run(...bindAll([subjectKey, category, watchedEps, priority, note ?? null, ts, ts]));
}

export function removeMyAnime(db: DatabaseSync, subjectKey: string): number {
  const result = db.prepare('DELETE FROM my_anime WHERE subject_key = ?').run(subjectKey);
  return Number(result.changes);
}

export function setCategory(db: DatabaseSync, subjectKey: string, category: TrackCategory): void {
  db.prepare('UPDATE my_anime SET category = ?, updated_at = ? WHERE subject_key = ?').run(
    category,
    nowIso(),
    subjectKey,
  );
}

export function setWatchedEps(db: DatabaseSync, subjectKey: string, watchedEps: number): void {
  db.prepare('UPDATE my_anime SET watched_eps = ?, updated_at = ? WHERE subject_key = ?').run(
    watchedEps,
    nowIso(),
    subjectKey,
  );
}

/** 补番库专用：设定「每周几看 / 每天看几集」的计划（都可为 null = 纯待看清单）。 */
export function setBacklogPlan(
  db: DatabaseSync,
  subjectKey: string,
  plan: { plannedWeekdayJst?: number | null; plannedEpsPerDay?: number | null; priority?: number },
): void {
  db.prepare(
    `UPDATE my_anime
     SET planned_weekday_jst = ?, planned_eps_per_day = ?, priority = COALESCE(?, priority), updated_at = ?
     WHERE subject_key = ?`,
  ).run(
    ...bindAll([
      plan.plannedWeekdayJst ?? null,
      plan.plannedEpsPerDay ?? null,
      plan.priority ?? null,
      nowIso(),
      subjectKey,
    ]),
  );
}

export type MyAnimeItem = {
  subjectKey: string;
  titleCn: string | null;
  titleCnSource: TitleCnSource;
  titleOriginal: string | null;
  coverUrl: string | null;
  mediaType: string;
  totalEps: number | null;
  durationMin: number | null;
  status: AiringStatus;
  season: string | null;
  category: TrackCategory;
  watchedEps: number;
  notifyEnabled: boolean;
  plannedWeekdayJst: number | null;
  plannedEpsPerDay: number | null;
  priority: number;
  note: string | null;
};

type MyAnimeRow = {
  subject_key: string;
  title_cn: string | null;
  title_cn_source: string | null;
  title_original: string | null;
  cover_url: string | null;
  media_type: string;
  total_eps: number | null;
  duration_min: number | null;
  status: string;
  season: string | null;
  category: string;
  watched_eps: number;
  notify_enabled: number;
  planned_weekday_jst: number | null;
  planned_eps_per_day: number | null;
  priority: number;
  note: string | null;
};

const MY_ANIME_SELECT = `
  SELECT m.subject_key, s.title_cn, s.title_cn_source, s.title_original, s.cover_url, s.media_type,
         s.total_eps, s.duration_min, s.status, s.season,
         m.category, m.watched_eps, m.notify_enabled,
         m.planned_weekday_jst, m.planned_eps_per_day, m.priority, m.note
  FROM my_anime m
  JOIN subject s ON s.key = m.subject_key
`;

function toMyAnimeItem(row: MyAnimeRow): MyAnimeItem {
  return {
    subjectKey: row.subject_key,
    titleCn: row.title_cn,
    titleCnSource: toTitleCnSource(row.title_cn_source),
    titleOriginal: row.title_original,
    coverUrl: row.cover_url,
    mediaType: row.media_type,
    totalEps: row.total_eps,
    durationMin: row.duration_min,
    status: row.status as AiringStatus,
    season: row.season,
    category: row.category as TrackCategory,
    watchedEps: row.watched_eps,
    notifyEnabled: row.notify_enabled === 1,
    plannedWeekdayJst: row.planned_weekday_jst,
    plannedEpsPerDay: row.planned_eps_per_day,
    priority: row.priority,
    note: row.note,
  };
}

export function listMyAnime(db: DatabaseSync, category?: TrackCategory): MyAnimeItem[] {
  const sql = category
    ? `${MY_ANIME_SELECT} WHERE m.category = ? ORDER BY m.priority, s.title_cn`
    : `${MY_ANIME_SELECT} ORDER BY m.priority, s.title_cn`;
  const rows = (category ? db.prepare(sql).all(category) : db.prepare(sql).all()) as unknown as MyAnimeRow[];
  return rows.map(toMyAnimeItem);
}

export function getMyAnime(db: DatabaseSync, subjectKey: string): MyAnimeItem | undefined {
  const row = db.prepare(`${MY_ANIME_SELECT} WHERE m.subject_key = ?`).get(subjectKey) as unknown as
    | MyAnimeRow
    | undefined;
  return row ? toMyAnimeItem(row) : undefined;
}

// ---------------------------------------------------------------------------
// subject 查找
// ---------------------------------------------------------------------------

export type SubjectRef = {
  key: string;
  titleCn: string | null;
  /** 中文名是官方的还是临时机翻的 */
  titleCnSource: TitleCnSource;
  titleOriginal: string | null;
  totalEps: number | null;
  durationMin: number | null;
  status: AiringStatus;
  season: string | null;
};

type SubjectRefRow = {
  key: string;
  title_cn: string | null;
  title_cn_source: string | null;
  title_original: string | null;
  total_eps: number | null;
  duration_min: number | null;
  status: string;
  season: string | null;
};

/** 库里 NULL 一律视为 official（引入机翻之前的数据都是官方名）。 */
function toTitleCnSource(raw: string | null | undefined): TitleCnSource {
  return raw === 'machine' ? 'machine' : 'official';
}

function toSubjectRef(row: SubjectRefRow): SubjectRef {
  return {
    key: row.key,
    titleCn: row.title_cn,
    titleCnSource: toTitleCnSource(row.title_cn_source),
    titleOriginal: row.title_original,
    totalEps: row.total_eps,
    durationMin: row.duration_min,
    status: row.status as AiringStatus,
    season: row.season,
  };
}

const SUBJECT_REF_SELECT =
  'SELECT key, title_cn, title_cn_source, title_original, total_eps, duration_min, status, season FROM subject';

/**
 * 按外部 ID 找库里已有的条目。
 *
 * 为什么需要：`add`（搜索添加）拿到的是单一数据源的记录，而季度同步落库的条目
 * 往往是多源融合后的「富记录」（有中文名、有分集时刻）。
 * 不查重就会出现同一部番两份记录 —— 一份有中文名、一份没有。
 */
export function findSubjectByExternalId(
  db: DatabaseSync,
  ids: { bgmId?: number | undefined; anilistId?: number | undefined; malId?: number | undefined },
): SubjectRef | undefined {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (ids.bgmId) {
    conditions.push('bgm_id = ?');
    params.push(ids.bgmId);
  }
  if (ids.anilistId) {
    conditions.push('anilist_id = ?');
    params.push(ids.anilistId);
  }
  if (ids.malId) {
    conditions.push('mal_id = ?');
    params.push(ids.malId);
  }
  if (conditions.length === 0) return undefined;

  const row = db
    .prepare(`${SUBJECT_REF_SELECT} WHERE ${conditions.join(' OR ')} LIMIT 1`)
    .get(...bindAll(params)) as unknown as SubjectRefRow | undefined;
  return row ? toSubjectRef(row) : undefined;
}

/**
 * 在本地库里按标题搜索（中文名 / 原名 / 别名都能命中）。
 *
 * 别名存在的意义就在这里：B站译名、Bangumi 译名、日文原名三套写法，
 * 用户随手打哪一个都应该搜得到。
 */
export function searchLocalSubjects(db: DatabaseSync, keyword: string, limit = 20): SubjectRef[] {
  const like = `%${keyword.trim()}%`;
  const rows = db
    .prepare(
      `${SUBJECT_REF_SELECT}
       WHERE title_cn LIKE ? OR title_original LIKE ? OR aliases LIKE ?
       ORDER BY (season IS NULL) ASC, season DESC, title_cn
       LIMIT ?`,
    )
    .all(...bindAll([like, like, like, limit])) as unknown as SubjectRefRow[];
  return rows.map(toSubjectRef);
}

// ---------------------------------------------------------------------------
// 写库前的「找已有番」身份判定（票 A：.scratch/duplicate-subjects/issues/01-票A）
// ---------------------------------------------------------------------------

/** 身份判定用的整行投影（比 SUBJECT_REF_SELECT 多出外部 ID 与来源，吸收旧行要用）。 */
const SUBJECT_ID_SELECT =
  'SELECT s.key, s.bgm_id, s.anilist_id, s.mal_id, s.bili_season_id, s.title_cn, s.title_original, s.title_en, s.aliases, s.sources, s.season, s.title_cn_source, s.total_eps, s.duration_min, s.status FROM subject AS s';

/**
 * 季度是否兼容：两侧都拿到季度、且互不相同时**否决**匹配。
 *
 * 为什么必须有这道否决 —— 实测有 49 组**跨季度**同名条目：
 * 同名但季度不同的两部番（重制版、续作、同名新作）是**两部不同的番**，不能并成一条。
 * 季度缺失（补番库老番、只有标题的脏数据）一律视为"未知"，不参与否决 ——
 * 否则"新数据有季度、老行没有"就会漏配，而那正是重复产生的主形态。
 */
function seasonCompatible(rowSeason: string | null, subjectSeason: string | null | undefined): boolean {
  const a = (rowSeason ?? '').trim();
  const b = (subjectSeason ?? '').trim();
  if (a === '' || b === '') return true;
  return a === b;
}

/**
 * 在库里找「同一部番」的行，顺序不可颠倒：
 *   1. 外部 ID（bgm / anilist / mal）
 *   2. 归一化标题（`normalizeTitle()` 同口径）
 *   3. 都没有 -> 新建
 *
 * 第 2 步是**必须的**：现状是"新数据有 ID、老行没 ID"（实测 384 行没有任何外部 ID），
 * 只按 ID 查必然漏，而漏一次就多一条重复。
 *
 * 标题怎么比 —— 分两轮，先严后宽，且**只有第一轮没命中才放宽**：
 *   1. 归一化后**相等**（`normalizeTitle()` 已剥掉 `第N季` / `Season N` / `Ⅱ` / `PartN`）
 *   2. 归一化后一方包含另一方（库里的「夏日重现第二季」vs 新数据的「夏日重现」）
 *      —— 因为 `normalizeTitle()` 剥不掉 `第2クール` / `Part.2` / `2nd&3rd STAGE`。
 *
 * 放宽就有误配风险，所以三道防线：短标题（归一化后 < 4 字符）不参与包含匹配；
 * 季度不同的直接否决（实测 49 组跨季度同名，是**两部不同的番**）；
 * 多行命中时按 `sources` 条数取胜，且**是否真的吸收**另有更严格的闸门
 * （见 `absorbSubjectRow`）。
 */
function findSubjectsByTitle(db: DatabaseSync, subject: Subject): TitleMatchRow[] {
  const exact = new Set<string>();
  const loose = new Set<string>();
  for (const text of [subject.titleCn, subject.titleOriginal, subject.titleEn, ...(subject.aliases ?? [])]) {
    const value = (text ?? '').trim();
    if (value === '') continue;
    const normalized = normalizeTitle(value);
    // 归一化后不到 2 个字符的（"犬"、"9"）太容易误配，两轮都不参与
    if (normalized.length < 2) continue;
    exact.add(normalized);
    if (normalized.length >= 4) loose.add(normalized);
  }
  if (exact.size === 0) return [];

  // 先用 LIKE 把候选收窄（归一化是 JS 侧的事，SQL 做不了）。
  // LIKE 在 SQLite 里对 ASCII 是不区分大小写的，而这里两边都已经是 normalizeTitle 的结果，
  // 所以中文/日文路径不受影响。
  const select = SUBJECT_ID_SELECT;
  const probes = [...exact];
  const filters: string[] = [];
  const params: unknown[] = [];
  const columns = ['s.title_cn', 's.title_original', 's.title_en', 's.aliases'];
  for (const probe of probes) {
    for (const column of columns) filters.push(`${column} LIKE ?`);
    params.push(`%${probe}%`, `%${probe}%`, `%${probe}%`, `%${probe}%`);
  }
  const candidates = db.prepare(`${select} WHERE ${filters.join(' OR ')}`).all(...bindAll(params)) as unknown as
    TitleMatchRow[];

  const byKey = new Map<string, TitleMatchRow>();
  for (const row of candidates) byKey.set(row.key, row);

  const rowKeysOf = (row: TitleMatchRow): string[] => {
    let aliases: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.aliases ?? '[]');
      if (Array.isArray(parsed)) aliases = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      aliases = [];
    }
    const normalized = [row.title_cn, row.title_original, row.title_en, ...aliases]
      .map((text) => normalizeTitle((text ?? '').trim()))
      .filter((text) => text.length >= 2);
    return [...new Set([...normalized, ...aliases])];
  };

  // 轮 1：归一化后相等
  const exactHits: TitleMatchRow[] = [];
  const looseHits: TitleMatchRow[] = [];
  for (const row of byKey.values()) {
    if (!seasonCompatible(row.season, subject.season)) continue;

    const rowKeys = rowKeysOf(row);
    if (rowKeys.some((key) => exact.has(key))) {
      exactHits.push(row);
      continue;
    }
    if (rowKeys.some((key) => [...loose].some((probe) => key.includes(probe) || probe.includes(key)))) {
      looseHits.push(row);
    }
  }

  const pool = exactHits.length > 0 ? exactHits : looseHits;
  // 信息更全的（`sources` 条数多）排在前面 —— 那条才是"正主"，
  // 只有 yuc 的脏条目排在后面等着被吸收。
  pool.sort((a, b) => sourceCount(b) - sourceCount(a));
  return pool;
}

function sourceCount(row: { sources: string | null }): number {
  return parseJsonArray<string>(row.sources).length;
}

type TitleMatchRow = SubjectRefRow & {
  bgm_id: number | null;
  anilist_id: number | null;
  mal_id: number | null;
  bili_season_id: number | null;
  title_en: string | null;
  aliases: string | null;
  sources: string | null;
};

export type IdentityMatch = 'id' | 'title';
export type IdentityStatus = 'new' | 'reused' | 'absorbed';

/**
 * 写库前的身份判定结果。见 `resolveSubjectIdentity()`。
 *
 * ⚠ 这是**建议值**：调用方必须把 `subject.key` 改成 `suggestedKey` 再去写库与比对变更，
 * 否则 `detectChanges()` 会拿新 key 去比旧 key 的行，把整部番误判成"新增分集"。
 */
export type IdentityResolution = {
  /** 这次应该写进哪一行 */
  suggestedKey: string;
  /** 原 key 与 suggestedKey 不同（= 主键漂移被拦住） */
  remapped: boolean;
  match: IdentityMatch | 'none';
  status: IdentityStatus;
  /** 命中依据（日志用） */
  reason: 'bgm' | 'anilist' | 'mal' | 'title' | 'new';
  /** 命中行带着另一个外部 ID：只报告，不改写库行为 */
  idConflicts: string[];
  /**
   * **另外**要吸收掉的同名脏行（无外部 ID 的那些）。
   *
   * 为什么单独列出来 —— 实测踩到过的漏配：新数据按 `bgm_id` 命中了库里那条**带 ID**的行，
   * 于是归一化标题那一层根本不会跑；而同一部番的 `title:<归一化名>` 脏行**还躺在库里**，
   * 每一次同步都命中带 ID 的那条、永远碰不到它 —— 两条行就永久并存了。
   * 所以按 ID 命中之后**还要再按标题扫一遍**，把这些脏行挑出来吸收。
   */
  absorbKeys: string[];
};

/**
 * 判定「这次要写的这部番，该写进库里哪一行」，以及有哪些脏行该被吸收。
 *
 * 这是票 A 的核心：跨源聚类（`mergeSubjects()`）只在**本次抓取的内存里**做，
 * 从不回查数据库；写库又是裸 UPSERT，主键 `subject.key` 会随"这次哪个源成功"漂移
 * （`bgm:<id>` ↔ `title:<归一化名>`），旧行永不删除 —— 于是同一部番两行并存。
 * 实测 98 组重复全部是「一条有外部 ID + 一条只有 yuc 的 `title:` 条目」。
 *
 * 判定顺序（不可颠倒）：外部 ID → 归一化标题 → 都没有才新建。
 *
 * ⚠ 调用时机：必须在 `detectChanges()` **之前**。
 *
 * ⚠ 本函数**只做判定，不写库**。真正吸收要靠 `applyIdentityAbsorption()`
 *   **在保留行写入之后**调用 —— 被 repoint 的 `my_anime` 有外键指向保留行，
 *   保留行还不存在时 repoint 会 FOREIGN KEY constraint failed（实测踩到过）。
 */
export function resolveSubjectIdentity(db: DatabaseSync, subject: Subject): IdentityResolution {
  // 1) 外部 ID
  let byId: TitleMatchRow | undefined;
  let idReason: IdentityResolution['reason'] = 'new';
  if (subject.bgmId) {
    byId = lookupSubjectByColumn(db, 'bgm_id', subject.bgmId);
    if (byId) idReason = 'bgm';
  }
  if (!byId && subject.anilistId) {
    byId = lookupSubjectByColumn(db, 'anilist_id', subject.anilistId);
    if (byId) idReason = 'anilist';
  }
  if (!byId && subject.malId) {
    byId = lookupSubjectByColumn(db, 'mal_id', subject.malId);
    if (byId) idReason = 'mal';
  }

  // 2) 归一化标题（按 ID 命中之后**仍然要查**：见 absorbKeys 的说明）
  const byTitle: TitleMatchRow[] = findSubjectsByTitle(db, subject);

  // 3) 选择"写进哪一行"，并挑出要吸收的脏行
  const primary = byId ?? byTitle[0];
  if (!primary) {
    return {
      suggestedKey: subject.key,
      remapped: false,
      match: 'none',
      status: 'new',
      reason: 'new',
      idConflicts: [],
      absorbKeys: [],
    };
  }

  // 保留哪一行：**带外部 ID 的那一行**更稳定。
  // 命中行是"只有标题、没有 ID"的脏行，而本次数据带着 ID 时，就写本次这个 key
  //（前提是它还没被别的行占用）。理由：`title:<归一化名>` 是会漂移的形态，
  // 让带 ID 的记录活下来才是长期稳定的。
  let primaryRow = primary;
  const byIdHasId = byId !== undefined && hasExternalId(byId);
  if (!byIdHasId && hasExternalId(subject) && !subjectKeyExists(db, subject.key)) {
    const wasTitleOnly = primaryRow.key !== subject.key;
    if (wasTitleOnly) {
      console.warn(
        `[identity] 主键漂移被拦住：写进 ${subject.key}，准备吸收 ${primaryRow.key}` +
          `（依据 ${byId ? idReason : 'title'}，命中行是「${primaryRow.title_cn ?? primaryRow.title_original ?? primaryRow.key}」）`,
      );
    }
    primaryRow = {
      ...primaryRow,
      key: subject.key,
      bgm_id: subject.bgmId ?? primaryRow.bgm_id,
      anilist_id: subject.anilistId ?? primaryRow.anilist_id,
      mal_id: subject.malId ?? primaryRow.mal_id,
    };
  }

  const reason: IdentityResolution['reason'] = byId ? idReason : 'title';
  const absorbKeys = [...new Set([primary.key, ...byTitle.map((row) => row.key)])].filter(
    (key) => key !== primaryRow.key,
  );
  if (absorbKeys.length > 0) {
    console.warn(`[identity] ${subject.key} 命中 ${primaryRow.key}，另有同日同名脏行待吸收：${absorbKeys.join('、')}`);
  }

  return {
    suggestedKey: primaryRow.key,
    remapped: primaryRow.key !== subject.key,
    match: byId ? 'id' : 'title',
    status: 'reused',
    reason,
    idConflicts: collectIdConflicts(primaryRow, reason, subject),
    absorbKeys,
  };
}

/**
 * 吸收一条脏行：按顺序在**同一个事务**里
 *   1. 把 `my_anime` / `schedule_override` / `change_log` 里指向它的引用 repoint 到保留行；
 *   2. `DELETE FROM subject` 删掉它（`episode` 靠 `ON DELETE CASCADE` 一起走）。
 *
 * ⚠ **必须在保留行写进库之后调用** —— `my_anime` 有外键指向 `subject(key)`，
 *   保留行还不存在时 repoint 会 `FOREIGN KEY constraint failed`（实测踩到过）。
 *
 * 两道闸门（只保护"不丢东西"，不阻止合并本身）：
 *   a. 不是一条**有内容的有 ID 记录**（"两条都带 ID 的重复"属于票 B 的清理）；无 ID 的随便吸收；
 *   b. `my_anime` 不能两边都有 —— 用户追的是哪一条、进度怎么并，是**人工判断**。
 *
 * ⚠ 闸门没过或抛错时**不删、也不改任何引用**：一次写库不该因为一条脏行就动用户数据。
 *   整段独立 try/catch + 独立事务，抛错也只返回原因（绝不冒泡打断同步）。
 */
export function applyIdentityAbsorption(
  db: DatabaseSync,
  target: string,
  keepKey: string,
): { absorbed: boolean; reason?: string } {
  const row = db
    .prepare(`${SUBJECT_ID_SELECT} WHERE s.key = ?`)
    .get(...bindAll([target])) as unknown as TitleMatchRow | undefined;
  if (!row) return { absorbed: false, reason: '该行已不存在' };
  if (target === keepKey) return { absorbed: false, reason: '保留行与目标行相同' };

  // 闸门 a：**有内容的有 ID 记录**不删。
  // 无 ID 的行（实测 98 组重复全是这种）照吸收；"有 ID 但一条分集都没有"的也行
  //（那种行没有信息量，删掉不丢东西，而留着就是永久并存的第二行）。
  const episodes = db
    .prepare('SELECT ep_number, air_at_utc FROM episode WHERE subject_key = ?')
    .all(...bindAll([target])) as unknown as Array<{ ep_number: number; air_at_utc: string | null }>;
  if ((row.bgm_id || row.anilist_id || row.mal_id) && episodes.length > 0) {
    const reason = '它是带外部 ID 且有分集的记录（两条都带 ID 的重复属于票 B 的清理）';
    console.warn(`[identity] ${target} ${reason}，不吸收`);
    return { absorbed: false, reason };
  }

  // 闸门 b：用户数据不能两边都有
  const keepTracked = db.prepare('SELECT 1 AS x FROM my_anime WHERE subject_key = ?').get(...bindAll([keepKey]));
  const targetTracked = db.prepare('SELECT 1 AS x FROM my_anime WHERE subject_key = ?').get(...bindAll([target]));
  if (keepTracked && targetTracked) {
    const reason = '两条都挂在「我的追番」上（用户追的是哪条、进度怎么并需要人工判断）';
    console.warn(`[identity] ${target} 与 ${keepKey} ${reason}，留给票 B 的 dry-run 报告`);
    return { absorbed: false, reason };
  }

  try {
    db.exec('BEGIN');
    repointSubjectReferences(db, target, keepKey);
    db.prepare('DELETE FROM subject WHERE key = ?').run(...bindAll([target]));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已经在事务外（例如 BEGIN 自己就失败了）—— 不必再 rollback
    }
    const reason = `吸收失败：${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[identity] ${target} ${reason}（已回滚，旧行与引用都保持原样）`);
    return { absorbed: false, reason };
  }
  console.warn(`[identity] 已吸收 ${target}（分集与引用已并入 ${keepKey}）`);
  return { absorbed: true };
}

/** 只关心四个 ID 列，所以 Subject 与库里读出来的行都能传进来。 */
function hasExternalId(value: {
  bgmId?: number | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  biliSeasonId?: number | undefined;
  bgm_id?: number | null;
  anilist_id?: number | null;
  mal_id?: number | null;
  bili_season_id?: number | null;
}): boolean {
  return Boolean(
    value.bgmId ??
      value.anilistId ??
      value.malId ??
      value.biliSeasonId ??
      value.bgm_id ??
      value.anilist_id ??
      value.mal_id ??
      value.bili_season_id,
  );
}

function subjectKeyExists(db: DatabaseSync, key: string): boolean {
  return db.prepare('SELECT 1 AS x FROM subject WHERE key = ?').get(...bindAll([key])) !== undefined;
}

function lookupSubjectByColumn(db: DatabaseSync, column: string, value: number): TitleMatchRow | undefined {
  const row = db
    .prepare(`${SUBJECT_ID_SELECT} WHERE s.${column} = ? LIMIT 1`)
    .get(...bindAll([value])) as unknown as TitleMatchRow | undefined;
  return row;
}

/**
 * 命中行若带着**另一个**外部 ID，只报告、不覆盖（见 resolveSubjectIdentity 的 idConflicts）。
 *
 * 为什么只报告：库里那行可能是**真的另一部番**（同名不同作品），把本次的 ID 覆盖上去
 * 等于把 B 番的 ID 写到 A 番身上。写库时 UPSERT 只会把新 ID 写进**保留行**，
 * 这里报告的是"数据源之间对不上"的信号，交给人工判断。
 */
function collectIdConflicts(
  row: { bgm_id: number | null; anilist_id: number | null; mal_id: number | null },
  reason: IdentityResolution['reason'],
  subject: Subject,
): string[] {
  // 命中依据就是那个 ID 时，它当然相等，不用报；只报**其他**两个字段上的不一致
  const conflicts: string[] = [];
  const check = (label: string, field: string, inRow: number | null | undefined, incoming: number | undefined): void => {
    if (reason === field) return;
    if (inRow && incoming && inRow !== incoming) conflicts.push(`${label}: 库里 ${inRow} vs 本次 ${incoming}`);
  };
  check('bgm_id', 'bgm', row.bgm_id, subject.bgmId);
  check('anilist_id', 'anilist', row.anilist_id, subject.anilistId);
  check('mal_id', 'mal', row.mal_id, subject.malId);
  for (const conflict of conflicts) console.warn(`[identity] 外部 ID 不一致，以本次写入值为准：${conflict}`);
  return conflicts;
}

/**
 * 吸收旧行：按顺序在**同一个事务**里
 *   1. 把 `my_anime` / `schedule_override` / `change_log` 里指向旧 key 的引用 repoint 到新 key；
 *   2. `DELETE FROM subject` 删掉旧行（`episode` 靠 `ON DELETE CASCADE` 一起走）。
 *
 * ⚠ 只有三道闸门全过才删（否则只报告，留给票 B 的 dry-run 报告）：
 *   a. 旧行**没有任何外部 ID** —— 有 ID 的重复属于清理，不属于写路径；
 *   b. 旧行没有"本次没带出来、且有时刻"的分集 —— 删除会 CASCADE 掉分集，不能丢真数据；
 *   c. `my_anime` 不能两边都有 —— 用户追的是哪一条、进度怎么并，是**人工判断**，不自动取舍。
 *
 * ⚠ 失败时**不删、也不改任何引用**：一次写库不该因为一条脏行就动用户数据。
 */
/**
 * 把指向旧 key 的引用改指新 key。
 *
 * 为什么不能只 `DELETE` 了事：`my_anime.subject_key` 是**主键**且 `ON DELETE CASCADE`
 * （schema.sql），删 `subject` 行会连带删掉用户真实在用的追番与进度。
 *
 * ⚠ 必须在目标行已经写进库之后调用：`my_anime` 有外键指向 `subject(key)`，
 *   目标行不存在时这里会 `FOREIGN KEY constraint failed`（实测踩到过）。
 */
function repointSubjectReferences(db: DatabaseSync, fromKey: string, toKey: string): void {
  // 目标已有同集号的手动修正时，保留目标那条、丢掉重复（OR IGNORE + 随后的 DELETE）
  db.prepare(
    `INSERT OR IGNORE INTO schedule_override (subject_key, ep_number, air_at_utc, pub_at_utc, reason, updated_at)
     SELECT ?, ep_number, air_at_utc, pub_at_utc, reason, updated_at FROM schedule_override WHERE subject_key = ?`,
  ).run(...bindAll([toKey, fromKey]));
  db.prepare('DELETE FROM schedule_override WHERE subject_key = ?').run(...bindAll([fromKey]));
  // change_log 是历史账，没有外键，直接改指保留行即可
  db.prepare('UPDATE change_log SET subject_key = ? WHERE subject_key = ?').run(...bindAll([toKey, fromKey]));
  // ⚠ my_anime 放在最后、且用 OR IGNORE：两边都有时保留目标那条
  //（闸门 c 已经拦下"两边都有"的情况，这里是二次保险，不能让它抛错中断吸收）
  db.prepare(
    `INSERT OR IGNORE INTO my_anime
       (subject_key, category, watched_eps, notify_enabled, planned_weekday_jst, planned_eps_per_day, priority, note, added_at, updated_at)
     SELECT ?, category, watched_eps, notify_enabled, planned_weekday_jst, planned_eps_per_day, priority, note, added_at, updated_at
       FROM my_anime WHERE subject_key = ?`,
  ).run(...bindAll([toKey, fromKey]));
}

export type ArchivedSubject = {
  key: string;
  /** 番剧名（给用户看的），取中文名优先 */
  title: string;
};

export type ArchiveResult = {
  /** 自动移入补番库的（播完了但没看完） */
  toBacklog: string[];
  /** 自动标记为已看完的 */
  toFinished: string[];
  /**
   * 被移动的番的「名字 + key」明细。
   *
   * 为什么要单独给一份：这个自动行为会让用户在「追番中」里**看不到**某部番，
   * 观感就是「我的记录消失了」（见 docs/交接说明-第二轮.md P0-5）。
   * 行为本身是 D6/T8 明确要的、不能删，所以必须让它**可见** —— UI 要能说出
   * 「哪几部被移进了补番库」，只给一串内部 key 是没用的。
   */
  moved: Array<ArchivedSubject & { to: 'backlog' | 'finished' }>;
};

/**
 * 季度切换时的自动归档 —— 就是你说的那个场景的自动化：
 * 「番剧还没看完但到下一个季度了」，不需要手动搬运。
 *
 * 判定意图（两条都只在 category = 'tracking' 时生效）：
 *   - 已播完 + 看完了            -> finished
 *   - 已播完 + 看了但没看完      -> backlog（补番库）
 * 一集都没看的**不动**：那是「想看」，凭这个自动搬进补番库会很烦人。
 *
 * 规则实现只有一份：core/backlog.ts 的 shouldArchiveToBacklog。
 */
export function autoArchiveFinished(db: DatabaseSync): ArchiveResult {
  const rows = db
    .prepare(
      `SELECT m.subject_key, m.watched_eps, m.category, s.status, s.total_eps,
              s.title_cn, s.title_original
       FROM my_anime m JOIN subject s ON s.key = m.subject_key
       WHERE m.category = 'tracking'`,
    )
    .all() as unknown as Array<{
    subject_key: string;
    watched_eps: number;
    category: string;
    status: string;
    total_eps: number | null;
    title_cn: string | null;
    title_original: string | null;
  }>;

  const result: ArchiveResult = { toBacklog: [], toFinished: [], moved: [] };

  for (const row of rows) {
    const totalEps = row.total_eps ?? 0;
    const status = row.status as AiringStatus;
    const title = row.title_cn ?? row.title_original ?? row.subject_key;

    if (status === 'finished' && totalEps > 0 && row.watched_eps >= totalEps) {
      setCategory(db, row.subject_key, 'finished');
      result.toFinished.push(row.subject_key);
      result.moved.push({ key: row.subject_key, title, to: 'finished' });
      continue;
    }

    const shouldMove = shouldArchiveToBacklog({
      status,
      totalEps: row.total_eps ?? undefined,
      watchedEps: row.watched_eps,
      category: row.category as TrackCategory,
    });
    if (shouldMove) {
      setCategory(db, row.subject_key, 'backlog');
      result.toBacklog.push(row.subject_key);
      result.moved.push({ key: row.subject_key, title, to: 'backlog' });
    }
  }

  return result;
}

/** 空的归档结果，用于「没抓到数据」这类提前返回的分支。 */
export function emptyArchiveResult(): ArchiveResult {
  return { toBacklog: [], toFinished: [], moved: [] };
}

// ---------------------------------------------------------------------------
// 临时机翻译名（用户诉求：「没中文名的先机翻，官方名到了再换掉」）
// 规则本体在 core/mt.ts，这里只负责读写。
// ---------------------------------------------------------------------------

export type TranslationCandidate = {
  key: string;
  titleCn: string | null;
  titleCnSource: TitleCnSource;
  titleOriginal: string | null;
  titleEn: string | null;
  season: string | null;
  status: AiringStatus;
  /** 为什么跳过（只有在 translate=false 时才有值） */
  skipReason?: string;
};

type TranslationRow = {
  key: string;
  title_cn: string | null;
  title_cn_source: string | null;
  title_original: string | null;
  title_en: string | null;
  season: string | null;
  status: string;
};

/**
 * 找出「值得机翻」的条目，并顺手给出该不该翻的判定。
 *
 * `season` 支持**多季**（与本文件里 `listSeasonSubjects` 同一套口径）：
 *   传单个季度 id 或季度数组时只在这些季度里找；传 `null`/不传才是全库。
 *   ⚠ 「更新范围可控」那条需求要求"用户勾了哪几季就翻哪几季"——**不要**为了省事传 null，
 *     那会翻掉用户没选的季度：慢，而且免费接口额度有限。
 * 默认只返回需要翻的，`includeSkipped` 用于让调用方展示「为什么这些没翻」。
 */
export function listTranslationCandidates(
  db: DatabaseSync,
  options: {
    season?: string | readonly string[] | null;
    limit?: number;
    includeSkipped?: boolean;
  } = {},
): TranslationCandidate[] {
  const { season = null, limit = 0, includeSkipped = false } = options;
  const seasons = (season == null ? [] : Array.isArray(season) ? [...season] : [season as string]).filter(
    (id): id is string => typeof id === 'string' && id.trim() !== '',
  );
  const placeholders = seasons.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT key, title_cn, title_cn_source, title_original, title_en, season, status
       FROM subject
       WHERE (title_cn IS NULL OR title_cn = '')
       ${seasons.length ? `AND season IN (${placeholders})` : ''}
       ORDER BY season IS NULL, season DESC, title_original`,
    )
    .all(...seasons) as unknown as TranslationRow[];

  const out: TranslationCandidate[] = [];
  for (const row of rows) {
    const decision = decideMachineTranslation({
      titleCn: row.title_cn,
      titleCnSource: toTitleCnSource(row.title_cn_source),
      titleOriginal: row.title_original,
      titleEn: row.title_en,
    });
    if (!decision.translate) {
      if (includeSkipped) {
        out.push({
          key: row.key,
          titleCn: row.title_cn,
          titleCnSource: toTitleCnSource(row.title_cn_source),
          titleOriginal: row.title_original,
          titleEn: row.title_en,
          season: row.season,
          status: row.status as AiringStatus,
          skipReason: decision.reason,
        });
      }
      continue;
    }
    out.push({
      key: row.key,
      titleCn: row.title_cn,
      titleCnSource: toTitleCnSource(row.title_cn_source),
      titleOriginal: row.title_original,
      titleEn: row.title_en,
      season: row.season,
      status: row.status as AiringStatus,
    });
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

/** 这部番当前的中文名是不是「临时机翻」的。 */
export function isMachineTranslatedTitle(db: DatabaseSync, key: string): boolean {
  const row = db.prepare('SELECT title_cn_source FROM subject WHERE key = ?').get(key) as
    | { title_cn_source: string | null }
    | undefined;
  return row?.title_cn_source === 'machine';
}

/**
 * 写入临时机翻名。
 *
 * 三条必须遵守的规则（对应 docs/决策记录.md D8）：
 *   1. 只写 title_cn / title_cn_source / title_cn_source_at 三列，**不碰 fieldSources**
 *      —— 那个字段是给官方源的字段级出处，机翻名不能把自己伪装成官方来源。
 *   2. 原名（以及英文名）并入 aliases，保证**搜索仍能用原名命中**。
 *   3. 已经有官方中文名的**直接拒绝**，绝不覆盖 —— 官方名永远优先。
 */
export function applyMachineTitle(db: DatabaseSync, key: string, machineTitle: string): boolean {
  const title = machineTitle.trim();
  if (title === '') return false;

  const existing = db
    .prepare('SELECT title_cn, title_original, title_en, aliases FROM subject WHERE key = ?')
    .get(key) as
    | {
        title_cn: string | null;
        title_original: string | null;
        title_en: string | null;
        aliases: string;
      }
    | undefined;
  if (!existing) return false;

  // 已经有中文名就拒绝写入 —— 不管是官方的还是上一次机翻的。
  // 官方名优先是硬规则；机翻名也不重写，是因为「重翻同一部番」只会浪费
  // 免费接口的额度，而译文质量并不会更好（见 docs/决策记录.md D8）。
  if ((existing.title_cn ?? '').trim() !== '') return false;

  // 原名与英文名并入别名，否则机翻名一写进来，用原名就搜不到了
  const aliases = parseJsonArray<string>(existing.aliases);
  const seen = new Set(aliases.map((a) => a.trim()));
  for (const extra of [existing.title_original, existing.title_en]) {
    const value = (extra ?? '').trim();
    if (value !== '' && !seen.has(value)) {
      aliases.push(value);
      seen.add(value);
    }
  }

  db.prepare(
    `UPDATE subject
     SET title_cn = ?, title_cn_source = 'machine', title_cn_source_at = ?, aliases = ?, updated_at = ?
     WHERE key = ?`,
  ).run(...bindAll([title, nowIso(), JSON.stringify(aliases), nowIso(), key]));
  return true;
}

/**
 * 撤掉机翻名。
 *
 * 用途：官方译名已经能拿到了，但这次融合没写进来（例如它来自某个我们没接的源），
 * 此时宁可留着日文原名，也不要留一个错的中文名当门面 —— 但那属于用户手动决定的范畴，
 * 所以这个函数只在「一键更新」的清理阶段被显式调用。
 */
export function clearMachineTitle(db: DatabaseSync, key: string): boolean {
  const row = db.prepare('SELECT title_cn_source FROM subject WHERE key = ?').get(key) as
    | { title_cn_source: string | null }
    | undefined;
  if (row?.title_cn_source !== 'machine') return false;
  db.prepare(
    `UPDATE subject SET title_cn = NULL, title_cn_source = NULL, title_cn_source_at = NULL, updated_at = ?
     WHERE key = ?`,
  ).run(nowIso(), key);
  return true;
}

/** 统计机翻名数量（用于交付报告与自检）。 */
export function countMachineTitles(db: DatabaseSync, season?: string | null): number {
  const sql = `SELECT COUNT(*) AS n FROM subject WHERE title_cn_source = 'machine'${season ? ' AND season = ?' : ''}`;
  const row = (season ? db.prepare(sql).get(season) : db.prepare(sql).get()) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 季度（历史季度保留 / 回填的判断依据）
// ---------------------------------------------------------------------------

/** 库里已经有哪些季度（从新到旧）。 */
export function availableSeasons(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT DISTINCT season FROM subject WHERE season IS NOT NULL AND season <> '' ORDER BY season DESC")
    .all() as unknown as Array<{ season: string }>;
  return rows.map((row) => row.season);
}

export type SeasonSummary = {
  season: string;
  subjects: number;
  episodes: number;
  /** 该季度最后一次写入时刻（ISO UTC），用于判断数据有多旧 */
  updatedAt: string | null;
};

/** 每个季度各有多少部番、多少集 —— 界面标注「库里有哪些季度」用。 */
export function seasonSummaries(db: DatabaseSync): SeasonSummary[] {
  const rows = db
    .prepare(
      `SELECT s.season,
              COUNT(DISTINCT s.key) AS subjects,
              (SELECT COUNT(*) FROM episode e JOIN subject s2 ON s2.key = e.subject_key WHERE s2.season = s.season) AS episodes,
              MAX(s.updated_at) AS updated_at
       FROM subject s
       WHERE s.season IS NOT NULL AND s.season <> ''
       GROUP BY s.season
       ORDER BY s.season DESC`,
    )
    .all() as unknown as Array<{ season: string; subjects: number; episodes: number; updated_at: string | null }>;
  return rows.map((row) => ({
    season: row.season,
    subjects: Number(row.subjects),
    episodes: Number(row.episodes),
    updatedAt: row.updated_at,
  }));
}

/** 某个季度是否已经有数据（增量回填时用来跳过）。 */
export function seasonSubjectCount(db: DatabaseSync, season: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM subject WHERE season = ?').get(season) as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/** 单条番剧的季度归属（导入后回读，让调用方知道它被归到了哪一季）。 */
export function getSubjectSeason(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT season FROM subject WHERE key = ?').get(key) as
    | { season: string | null }
    | undefined;
  return row?.season ?? null;
}

// ---------------------------------------------------------------------------
// 备份（用户数据不可重建，所以要有兜底）
// ---------------------------------------------------------------------------

export type BackupResult = {
  path: string;
  bytes: number;
  /** 为了备份一致性做了 WAL checkpoint */
  checkpointed: boolean;
};

/**
 * 备份数据库。
 *
 * ⚠ 这里有个**实测踩到的真实陷阱**（见 docs/交接说明-第二轮.md 的 WAL 提醒）：
 * 项目用 WAL 日志模式，`anime.db` 单独拷出来可能是**不完整的** ——
 * 实测「只拷 anime.db」时 `subject` 有 126 行但 `my_anime` **是 0 行**，
 * 也就是说追番列表整条丢了。所以顺序必须是：
 *
 *   1. `PRAGMA wal_checkpoint(TRUNCATE)` —— 把 WAL 里的内容合并进主文件
 *   2. 再拷 `anime.db`
 *   3. 顺便把 `-wal` / `-shm` 也拷过去（checkpoint 失败时的第二道保险）
 */
export function backupDatabase(
  db: DatabaseSync,
  options: { dbPath?: string; backupDir?: string; label?: string; now?: Date } = {},
): BackupResult | null {
  const { dbPath = DEFAULT_DB_PATH, backupDir = BACKUP_DIR, label = '', now = new Date() } = options;
  if (dbPath === ':memory:') return null;
  if (!existsSync(dbPath)) return null;

  let checkpointed = false;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpointed = true;
  } catch {
    // 非 WAL 模式或被占用时 checkpoint 会失败 —— 不影响主流程，靠下面连 -wal 一起拷兜住
  }

  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const suffix = label ? `-${label}` : '';
  const target = path.join(backupDir, `anime-${stamp}${suffix}.db`);

  copyFileSync(dbPath, target);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${ext}`)) copyFileSync(`${dbPath}${ext}`, `${target}${ext}`);
  }

  return { path: target, bytes: statSync(target).size, checkpointed };
}

/**
 * 清理旧备份，只保留最近 keep 份。
 *
 * 保留策略是显式的（D10）：备份不能无限增长，但也不能只留一份 ——
 * 用户数据是「越用越值钱」的东西，一份被误删就没了。
 */
export function pruneBackups(backupDir: string = BACKUP_DIR, keep = 20): number {
  if (keep < 1) return 0;
  let files: string[];
  try {
    files = readdirSync(backupDir).filter((name) => name.startsWith('anime-') && name.endsWith('.db'));
  } catch {
    return 0;
  }
  // 文件名里的时间戳是 ISO，所以字典序 = 时间序（新的在后）
  files.sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  let removed = 0;
  for (const name of doomed) {
    for (const candidate of [name, `${name}-wal`, `${name}-shm`]) {
      const full = path.join(backupDir, candidate);
      if (!existsSync(full)) continue;
      try {
        unlinkSync(full);
        if (candidate === name) removed += 1;
      } catch {
        // 被占用就留着，下次再删
      }
    }
  }
  return removed;
}

/** 列出备份（新的在前）。 */
export function listBackups(backupDir: string = BACKUP_DIR): Array<{ name: string; bytes: number; at: string }> {
  try {
    return readdirSync(backupDir)
      .filter((name) => name.startsWith('anime-') && name.endsWith('.db'))
      .sort()
      .reverse()
      .map((name) => {
        const full = path.join(backupDir, name);
        const stat = statSync(full);
        return { name, bytes: stat.size, at: stat.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 日历查询
// ---------------------------------------------------------------------------

export type ScheduleItem = {
  subjectKey: string;
  epNumber: number;
  /** 日本放送精确时刻（已应用手动修正） */
  airAtUtc: string | null;
  /** 国内平台可看时刻（已应用手动修正） */
  pubAtUtc: string | null;
  airSource: string | null;
  pubSource: string | null;
  /** 数据源之间存在分歧 */
  conflicting: boolean;
  broadcastWeekdayJst: number | null;
  /** 字面放送时间，如 "24:30"；日历分组要用它判断深夜番归属 */
  broadcastTimeJst: string | null;
  durationMin: number | null;
  titleCn: string | null;
  titleOriginal: string | null;
  coverUrl: string | null;
  totalEps: number | null;
  watchedEps: number;
  category: TrackCategory;
  /** 该集时刻被手动修正过 */
  isOverridden: boolean;
};

type ScheduleRow = {
  subject_key: string;
  ep_number: number;
  air_at_utc: string | null;
  pub_at_utc: string | null;
  air_source: string | null;
  pub_source: string | null;
  conflicting: number;
  broadcast_weekday_jst: number | null;
  broadcast_time_jst: string | null;
  duration_min: number | null;
  title_cn: string | null;
  title_original: string | null;
  cover_url: string | null;
  total_eps: number | null;
  watched_eps: number;
  category: string;
  is_overridden: number;
};

function toScheduleItem(row: ScheduleRow): ScheduleItem {
  return {
    subjectKey: row.subject_key,
    epNumber: row.ep_number,
    airAtUtc: row.air_at_utc,
    pubAtUtc: row.pub_at_utc,
    airSource: row.air_source,
    pubSource: row.pub_source,
    conflicting: row.conflicting === 1,
    broadcastWeekdayJst: row.broadcast_weekday_jst,
    broadcastTimeJst: row.broadcast_time_jst,
    durationMin: row.duration_min,
    titleCn: row.title_cn,
    titleOriginal: row.title_original,
    coverUrl: row.cover_url,
    totalEps: row.total_eps,
    watchedEps: row.watched_eps,
    category: row.category as TrackCategory,
    isOverridden: row.is_overridden === 1,
  };
}

/**
 * 时间区间内「我追的番」的更新安排。
 *
 * COALESCE 的顺序就是优先级：**手动修正 > 抓取到的时刻**。
 *
 * 注意：这里按真实时刻过滤，不负责深夜番的归属。
 * 调用方应先 core/calendar.ts 的 padWindow() 加宽区间，
 * 再用 groupByDayJst() 决定每一集落在哪一天。
 */
const SCHEDULE_SELECT = `
  SELECT e.subject_key,
         e.ep_number,
         COALESCE(o.air_at_utc, e.air_at_utc) AS air_at_utc,
         COALESCE(o.pub_at_utc, e.pub_at_utc) AS pub_at_utc,
         e.air_source, e.pub_source, e.conflicting,
         e.broadcast_weekday_jst, s.broadcast_time_jst, e.duration_min,
         s.title_cn, s.title_original, s.cover_url, s.total_eps,
         m.watched_eps, m.category,
         CASE WHEN o.subject_key IS NULL THEN 0 ELSE 1 END AS is_overridden
  FROM episode e
  JOIN my_anime m ON m.subject_key = e.subject_key
  JOIN subject s ON s.key = e.subject_key
  LEFT JOIN schedule_override o ON o.subject_key = e.subject_key AND o.ep_number = e.ep_number
  WHERE COALESCE(o.air_at_utc, e.air_at_utc) IS NOT NULL
`;

/** 取指定 UTC 区间内的更新安排（建议配合 padWindow 使用，见上面的说明）。 */
export function listSchedule(
  db: DatabaseSync,
  startUtc: string,
  endUtc: string,
  options: { category?: TrackCategory; onlyNotify?: boolean } = {},
): ScheduleItem[] {
  let sql = `${SCHEDULE_SELECT} AND COALESCE(o.air_at_utc, e.air_at_utc) >= ? AND COALESCE(o.air_at_utc, e.air_at_utc) < ?`;
  const params: unknown[] = [startUtc, endUtc];
  if (options.category) {
    sql += ' AND m.category = ?';
    params.push(options.category);
  }
  if (options.onlyNotify) sql += ' AND m.notify_enabled = 1';
  sql += ' ORDER BY COALESCE(o.air_at_utc, e.air_at_utc)';

  const rows = db.prepare(sql).all(...bindAll(params)) as unknown as ScheduleRow[];
  return rows.map(toScheduleItem);
}

/** 从某时刻起的下一批更新（用于倒计时列表）。 */
export function listUpcoming(db: DatabaseSync, fromUtc: string, limit = 20): ScheduleItem[] {
  const sql = `${SCHEDULE_SELECT} AND COALESCE(o.air_at_utc, e.air_at_utc) >= ? AND COALESCE(o.air_at_utc, e.air_at_utc) < ?
    AND m.category = 'tracking'
    ORDER BY COALESCE(o.air_at_utc, e.air_at_utc) LIMIT ?`;
  const rows = db
    .prepare(sql)
    .all(...bindAll([fromUtc, '9999-12-31T00:00:00.000Z', limit])) as unknown as ScheduleRow[];
  return rows.map(toScheduleItem);
}

// ---------------------------------------------------------------------------
// 手动修正 与 变更日志
// ---------------------------------------------------------------------------

export function setOverride(
  db: DatabaseSync,
  subjectKey: string,
  epNumber: number,
  patch: { airAtUtc?: string | null; pubAtUtc?: string | null; reason?: string },
): void {
  db.prepare(
    `INSERT INTO schedule_override (subject_key, ep_number, air_at_utc, pub_at_utc, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_key, ep_number) DO UPDATE SET
       air_at_utc = excluded.air_at_utc,
       pub_at_utc = excluded.pub_at_utc,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(
    ...bindAll([subjectKey, epNumber, patch.airAtUtc ?? null, patch.pubAtUtc ?? null, patch.reason ?? null, nowIso()]),
  );
}

export type ChangeLogItem = {
  id: number;
  subjectKey: string;
  /** 番剧名（用 JOIN 取，方便直接展示） */
  title: string | null;
  epNumber: number | null;
  field: string;
  kind: string | null;
  oldValue: string | null;
  newValue: string | null;
  detectedAt: string;
  acknowledged: boolean;
};

export function logChange(
  db: DatabaseSync,
  entry: {
    subjectKey: string;
    epNumber?: number | null;
    field: string;
    kind?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO change_log (subject_key, ep_number, field, kind, old_value, new_value, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...bindAll([
      entry.subjectKey,
      entry.epNumber ?? null,
      entry.field,
      entry.kind ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      nowIso(),
    ]),
  );
}

/** 批量写入变更记录。 */
export function logChanges(
  db: DatabaseSync,
  entries: readonly {
    subjectKey: string;
    epNumber?: number | null;
    field: string;
    kind?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
  }[],
): number {
  for (const entry of entries) logChange(db, entry);
  return entries.length;
}

export function listChanges(db: DatabaseSync, limit = 50, onlyUnacknowledged = true): ChangeLogItem[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.subject_key, s.title_cn, s.title_original, c.ep_number, c.field, c.kind,
              c.old_value, c.new_value, c.detected_at, c.acknowledged
       FROM change_log c
       LEFT JOIN subject s ON s.key = c.subject_key
       ${onlyUnacknowledged ? 'WHERE c.acknowledged = 0' : ''}
       ORDER BY c.detected_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
    id: number;
    subject_key: string;
    title_cn: string | null;
    title_original: string | null;
    ep_number: number | null;
    field: string;
    kind: string | null;
    old_value: string | null;
    new_value: string | null;
    detected_at: string;
    acknowledged: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    subjectKey: row.subject_key,
    title: row.title_cn ?? row.title_original,
    epNumber: row.ep_number,
    field: row.field,
    kind: row.kind,
    oldValue: row.old_value,
    newValue: row.new_value,
    detectedAt: row.detected_at,
    acknowledged: row.acknowledged === 1,
  }));
}

/** 确认（已读）变更记录。不传 id 表示全部确认。 */
export function acknowledgeChanges(db: DatabaseSync, ids?: readonly number[]): number {
  if (!ids || ids.length === 0) {
    const result = db.prepare('UPDATE change_log SET acknowledged = 1 WHERE acknowledged = 0').run();
    return Number(result.changes);
  }
  const stmt = db.prepare('UPDATE change_log SET acknowledged = 1 WHERE id = ?');
  let count = 0;
  for (const id of ids) count += Number(stmt.run(id).changes);
  return count;
}

// ---------------------------------------------------------------------------
// 统计（给 CLI 与总览页用）
// ---------------------------------------------------------------------------

/** 清空「我的追番 / 补番库」列表（保留抓来的番剧数据）。 */
export function clearMyAnime(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM my_anime').run();
  return Number(result.changes);
}

/** 清空变更记录。 */
export function clearChanges(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM change_log').run();
  return Number(result.changes);
}

/**
 * 清空所有抓取来的数据（番剧、分集、变更、原始记录）。
 * 追番列表也会被连带清掉（外键级联），因为条目没了列表就无从指向。
 */
export function clearFetchedData(db: DatabaseSync): { subjects: number } {
  const before = db.prepare('SELECT COUNT(*) AS n FROM subject').get() as { n?: number } | undefined;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM episode');
    db.exec('DELETE FROM change_log');
    db.exec('DELETE FROM source_record');
    db.exec('DELETE FROM my_anime');
    db.exec('DELETE FROM schedule_override');
    db.exec('DELETE FROM subject');
    // 运行记录是"账"，不是抓取数据 —— 但 reset 的语义就是"从头来过"，连带清掉才对
    db.exec('DELETE FROM sync_run');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { subjects: Number(before?.n ?? 0) };
}

// ---------------------------------------------------------------------------
// 每次同步的运行记录（票 A）
// ---------------------------------------------------------------------------

/**
 * 一次同步的运行记录（`sync_run` 一行）。
 *
 * 为什么要有它 —— `.scratch/duplicate-subjects/issues/01-票A` 的「根因」第 7 点：
 * 重复是"同一次更新的当季 pass + 回填 pass"造成的，还是"点了两次更新"造成的？
 * **无法判定**，因为跨运行完全没有留痕（`source_record` 表 0 行，代码里根本没人写它）。
 * 修好身份判定之后，"新增不再分叉"也要靠这张账来自证。
 */
export type SyncRunInput = {
  startedAt: string;
  trigger: 'cli' | 'web' | 'test' | null;
  scope: 'season' | 'archive-season' | null;
  seasons: readonly string[];
  providers: readonly unknown[];
  written: number;
  episodes: number;
  mergedAway: number;
  identityAbsorbed: number;
  identitySkipped: number;
  error: string | null;
  parentRunId?: number | null;
};

export type SyncRunRow = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  trigger: string | null;
  scope: string | null;
  seasons: string[];
  providers: Array<{ provider?: string; ok?: boolean; items?: number }>;
  written: number;
  episodes: number;
  mergedAway: number;
  identityAbsorbed: number;
  identitySkipped: number;
  error: string | null;
  parentRunId: number | null;
};

const SYNC_RUN_COLUMNS = [
  'started_at',
  'finished_at',
  'trigger',
  'scope',
  'seasons',
  'providers',
  'written',
  'episodes',
  'merged_away',
  'identity_absorbed',
  'identity_skipped',
  'error',
  'parent_run_id',
] as const;

/**
 * 写一条运行记录，返回它的 id。
 *
 * ⚠ **绝不能因为写账失败就中断同步**：这张表是凭证，不是数据。
 * 所以整段包在 try/catch 里，失败只打日志、返回 null。
 */
export function recordSyncRun(db: DatabaseSync, run: SyncRunInput): number | null {
  try {
    const finishedAt = nowIso();
    db.prepare(
      `INSERT INTO sync_run (${SYNC_RUN_COLUMNS.join(', ')})
       VALUES (${SYNC_RUN_COLUMNS.map(() => '?').join(', ')})`,
    ).run(
      ...bindAll([
        run.startedAt,
        finishedAt,
        run.trigger,
        run.scope,
        JSON.stringify(run.seasons),
        JSON.stringify(run.providers),
        run.written,
        run.episodes,
        run.mergedAway,
        run.identityAbsorbed,
        run.identitySkipped,
        run.error,
        run.parentRunId ?? null,
      ]),
    );
    const row = db.prepare('SELECT last_insert_rowid() AS id').get() as { id?: number } | undefined;
    return typeof row?.id === 'number' ? row.id : null;
  } catch (error) {
    console.warn(`[sync_run] 运行记录写入失败（不影响同步）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 最近 N 次同步的运行记录（新的在前）。 */
export function listSyncRuns(db: DatabaseSync, limit = 20): SyncRunRow[] {
  const rows = db
    .prepare(
      `SELECT id, started_at, finished_at, trigger, scope, seasons, providers, written, episodes,
              merged_away, identity_absorbed, identity_skipped, error, parent_run_id
         FROM sync_run ORDER BY id DESC LIMIT ?`,
    )
    .all(...bindAll([limit])) as unknown as Array<{
    id: number;
    started_at: string;
    finished_at: string | null;
    trigger: string | null;
    scope: string | null;
    seasons: string | null;
    providers: string | null;
    written: number;
    episodes: number;
    merged_away: number;
    identity_absorbed: number;
    identity_skipped: number;
    error: string | null;
    parent_run_id: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    scope: row.scope,
    seasons: parseJsonArray<string>(row.seasons),
    providers: parseJsonArray<{ provider?: string; ok?: boolean; items?: number }>(row.providers).filter(
      (item) => typeof item === 'object' && item !== null,
    ),
    written: row.written,
    episodes: row.episodes,
    mergedAway: row.merged_away,
    identityAbsorbed: row.identity_absorbed,
    identitySkipped: row.identity_skipped,
    error: row.error,
    parentRunId: row.parent_run_id,
  }));
}

/** 把运行记录打成一行中文，给 CLI 用。 */
export function describeSyncRun(run: SyncRunRow): string {
  const when = run.startedAt.replace('T', ' ').slice(0, 16);
  const where = run.scope === 'archive-season' ? '回填' : '当季';
  const failed = run.providers.filter((provider) => provider.ok === false).map((provider) => provider.provider ?? '?');
  const parts = [
    `${when}Z`,
    `#${run.id}`,
    `${run.trigger ?? '?'}/${where}`,
    run.seasons.join(',') || '—',
    `写入 ${run.written} 部 / ${run.episodes} 集`,
    `去重合并 ${run.mergedAway}`,
    `身份吸收 ${run.identityAbsorbed}`,
  ];
  if (run.identitySkipped > 0) parts.push(`待清理 ${run.identitySkipped}`);
  if (failed.length > 0) parts.push(`失败源 ${failed.join('/')}`);
  if (run.error) parts.push(`错误：${run.error.slice(0, 80)}`);
  return parts.join('  |  ');
}

export type DbStats = {
  subjects: number;
  episodes: number;
  tracking: number;
  backlog: number;
  finished: number;
  dropped: number;
  pendingChanges: number;
};

export function stats(db: DatabaseSync): DbStats {
  const count = (sql: string): number => {
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };
  return {
    subjects: count('SELECT COUNT(*) AS n FROM subject'),
    episodes: count('SELECT COUNT(*) AS n FROM episode'),
    tracking: count("SELECT COUNT(*) AS n FROM my_anime WHERE category = 'tracking'"),
    backlog: count("SELECT COUNT(*) AS n FROM my_anime WHERE category = 'backlog'"),
    finished: count("SELECT COUNT(*) AS n FROM my_anime WHERE category = 'finished'"),
    dropped: count("SELECT COUNT(*) AS n FROM my_anime WHERE category = 'dropped'"),
    pendingChanges: count('SELECT COUNT(*) AS n FROM change_log WHERE acknowledged = 0'),
  };
}

// ---------------------------------------------------------------------------
// 界面用的查询（季度总览 / 详情卡）
// ---------------------------------------------------------------------------

export type SeasonSubjectItem = {
  key: string;
  titleCn: string | null;
  /** 中文名是官方的还是临时机翻的（UI 要据此标「临时机翻」） */
  titleCnSource: TitleCnSource;
  titleOriginal: string | null;
  titleEn: string | null;
  coverUrl: string | null;
  mediaType: string;
  totalEps: number | null;
  durationMin: number | null;
  status: AiringStatus;
  broadcastWeekdayJst: number | null;
  broadcastTimeJst: string | null;
  firstAirAtUtc: string | null;
  platforms: Platform[];
  genres: string[];
  /** 库里已知的分集数 */
  episodeCount: number;
  /** 下一集放送时刻（ISO UTC），没有则为 null */
  nextAirAtUtc: string | null;
  myCategory: TrackCategory | null;
  myWatchedEps: number;
};

type SeasonSubjectRow = {
  key: string;
  title_cn: string | null;
  title_cn_source: string | null;
  title_original: string | null;
  title_en: string | null;
  cover_url: string | null;
  media_type: string;
  total_eps: number | null;
  duration_min: number | null;
  status: string;
  broadcast_weekday_jst: number | null;
  broadcast_time_jst: string | null;
  first_air_at_utc: string | null;
  platforms: string;
  genres: string;
  category: string | null;
  watched_eps: number | null;
};

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 总览列表的排序口径。
 *
 * 默认 `firstAir`（首集放送时间，早→晚）：这才是"这一季按什么顺序开播"的自然读法。
 * 之前写死的 `broadcastWeekdayJst, broadcastTimeJst` 是"按周历排"——对周六/周日才播的番，
 * 按放送日历口径它们排在最前面，看起来就像"周日更新的排第一"，跟直觉不符。
 */
export type SeasonSortKey = 'firstAir' | 'firstAirDesc' | 'weekday' | 'titleCn' | 'totalEps';

/** 排序键 → SQL 片段。**白名单**：绝不把调用方传进来的字符串直接拼进 SQL。 */
const SEASON_SORT_SQL: Record<SeasonSortKey, string> = {
  firstAir: 's.first_air_at_utc IS NULL, s.first_air_at_utc, s.title_cn',
  firstAirDesc: 's.first_air_at_utc IS NULL, s.first_air_at_utc DESC, s.title_cn',
  weekday:
    's.broadcast_weekday_jst IS NULL, s.broadcast_weekday_jst, s.broadcast_time_jst IS NULL, s.broadcast_time_jst, s.title_cn',
  titleCn: 's.title_cn IS NULL, s.title_cn, s.first_air_at_utc',
  totalEps: 's.total_eps IS NULL, s.total_eps DESC, s.first_air_at_utc',
};

/** 校验外部传入的排序键（HTTP 参数 / CLI 参数），不认识就回落到默认。 */
export function resolveSeasonSort(raw: string | null | undefined): SeasonSortKey {
  return raw && raw in SEASON_SORT_SQL ? (raw as SeasonSortKey) : 'firstAir';
}

/**
 * 若干季度的全部番剧，附带分集数与「下一集什么时候」。
 * 界面上的全季总览、搜索列表都用它。
 *
 * `seasons` 支持传多季（第五轮需求 5：同时勾多个季度一起看）——
 * 此时返回的是**并集**，按 `sort` 排序。单季调用（老代码、verify 脚本）行为不变。
 */
export function listSeasonSubjects(
  db: DatabaseSync,
  season: string | readonly string[],
  sort: SeasonSortKey = 'firstAir',
): SeasonSubjectItem[] {
  const nowIso = nowIsoString();

  const seasons = (Array.isArray(season) ? season : [season]).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  if (seasons.length === 0) return [];

  const placeholders = seasons.map(() => '?').join(', ');
  const orderBy = SEASON_SORT_SQL[sort] ?? SEASON_SORT_SQL.firstAir;

  const subjects = db
    .prepare(
      `SELECT s.key, s.title_cn, s.title_cn_source, s.title_original, s.title_en, s.cover_url, s.media_type,
              s.total_eps, s.duration_min, s.status, s.broadcast_weekday_jst, s.broadcast_time_jst,
              s.first_air_at_utc, s.platforms, s.genres,
              m.category, m.watched_eps
       FROM subject s
       LEFT JOIN my_anime m ON m.subject_key = s.key
       WHERE s.season IN (${placeholders})
       ORDER BY ${orderBy}`,
    )
    .all(...seasons) as unknown as SeasonSubjectRow[];

  const aggregates = db
    .prepare(
      `SELECT e.subject_key,
              COUNT(*) AS n,
              MIN(CASE WHEN e.air_at_utc >= ? THEN e.air_at_utc END) AS next_air
       FROM episode e
       JOIN subject s ON s.key = e.subject_key
       WHERE s.season IN (${placeholders})
       GROUP BY e.subject_key`,
    )
    .all(nowIso, ...seasons) as unknown as Array<{ subject_key: string; n: number; next_air: string | null }>;

  const byKey = new Map(aggregates.map((row) => [row.subject_key, row]));

  return subjects.map((row) => {
    const agg = byKey.get(row.key);
    return {
      key: row.key,
      titleCn: row.title_cn,
      titleCnSource: toTitleCnSource(row.title_cn_source),
      titleOriginal: row.title_original,
      titleEn: row.title_en,
      coverUrl: row.cover_url,
      mediaType: row.media_type,
      totalEps: row.total_eps,
      durationMin: row.duration_min,
      status: row.status as AiringStatus,
      broadcastWeekdayJst: row.broadcast_weekday_jst,
      broadcastTimeJst: row.broadcast_time_jst,
      firstAirAtUtc: row.first_air_at_utc,
      platforms: parseJsonArray<Platform>(row.platforms),
      genres: parseJsonArray<string>(row.genres),
      episodeCount: agg?.n ?? 0,
      nextAirAtUtc: agg?.next_air ?? null,
      myCategory: (row.category as TrackCategory | null) ?? null,
      myWatchedEps: row.watched_eps ?? 0,
    };
  });
}

function nowIsoString(): string {
  return nowIso();
}

export type SubjectEpisode = {
  epNumber: number;
  title: string | null;
  titleCn: string | null;
  airAtUtc: string | null;
  pubAtUtc: string | null;
  airSource: string | null;
  pubSource: string | null;
  conflicting: boolean;
  isOverridden: boolean;
};

export type SubjectDetail = SeasonSubjectItem & {
  bgmId: number | null;
  anilistId: number | null;
  malId: number | null;
  synopsis: string | null;
  aliases: string[];
  studios: string[];
  sources: string[];
  fieldSources: Record<string, string>;
  /** 机翻生成时刻（titleCnSource === 'machine' 时才有意义） */
  titleCnSourceAt: string | null;
  siteUrl: string | null;
  episodes: SubjectEpisode[];
  my: MyAnimeItem | null;
};

/** 单部番的完整信息（详情卡用），分集时刻已应用手动修正。 */
export function getSubjectDetail(db: DatabaseSync, key: string): SubjectDetail | undefined {
  const row = db
    .prepare(
      `SELECT s.key, s.title_cn, s.title_cn_source, s.title_cn_source_at,
              s.title_original, s.title_en, s.cover_url, s.media_type,
              s.total_eps, s.duration_min, s.status, s.broadcast_weekday_jst, s.broadcast_time_jst,
              s.first_air_at_utc, s.platforms, s.genres, s.synopsis, s.aliases, s.studios,
              s.sources, s.field_sources, s.bgm_id, s.anilist_id, s.mal_id,
              s.season, s.season AS season_col,
              m.category, m.watched_eps
       FROM subject s
       LEFT JOIN my_anime m ON m.subject_key = s.key
       WHERE s.key = ?`,
    )
    .get(key) as unknown as
    | (SeasonSubjectRow & {
        title_cn_source_at: string | null;
        synopsis: string | null;
        aliases: string;
        studios: string;
        sources: string;
        field_sources: string;
        bgm_id: number | null;
        anilist_id: number | null;
        mal_id: number | null;
        season: string | null;
      })
    | undefined;

  if (!row) return undefined;

  const episodeRows = db
    .prepare(
      `SELECT e.ep_number, e.title, e.title_cn,
              COALESCE(o.air_at_utc, e.air_at_utc) AS air_at_utc,
              COALESCE(o.pub_at_utc, e.pub_at_utc) AS pub_at_utc,
              e.air_source, e.pub_source, e.conflicting,
              CASE WHEN o.subject_key IS NULL THEN 0 ELSE 1 END AS is_overridden
       FROM episode e
       LEFT JOIN schedule_override o
         ON o.subject_key = e.subject_key AND o.ep_number = e.ep_number
       WHERE e.subject_key = ?
       ORDER BY e.ep_number`,
    )
    .all(key) as unknown as Array<{
    ep_number: number;
    title: string | null;
    title_cn: string | null;
    air_at_utc: string | null;
    pub_at_utc: string | null;
    air_source: string | null;
    pub_source: string | null;
    conflicting: number;
    is_overridden: number;
  }>;

  const nowIso = nowIsoString();
  const my = getMyAnime(db, key);

  return {
    key: row.key,
    titleCn: row.title_cn,
    titleCnSource: toTitleCnSource(row.title_cn_source),
    titleCnSourceAt: row.title_cn_source_at,
    titleOriginal: row.title_original,
    titleEn: row.title_en,
    coverUrl: row.cover_url,
    mediaType: row.media_type,
    totalEps: row.total_eps,
    durationMin: row.duration_min,
    status: row.status as AiringStatus,
    broadcastWeekdayJst: row.broadcast_weekday_jst,
    broadcastTimeJst: row.broadcast_time_jst,
    firstAirAtUtc: row.first_air_at_utc,
    platforms: parseJsonArray<Platform>(row.platforms),
    genres: parseJsonArray<string>(row.genres),
    episodeCount: episodeRows.length,
    nextAirAtUtc: episodeRows.find((ep) => ep.air_at_utc !== null && ep.air_at_utc >= nowIso)?.air_at_utc ?? null,
    myCategory: (row.category as TrackCategory | null) ?? null,
    myWatchedEps: row.watched_eps ?? 0,
    bgmId: row.bgm_id,
    anilistId: row.anilist_id,
    malId: row.mal_id,
    synopsis: row.synopsis,
    aliases: parseJsonArray<string>(row.aliases),
    studios: parseJsonArray<string>(row.studios),
    sources: parseJsonArray<string>(row.sources),
    fieldSources: (() => {
      try {
        return JSON.parse(row.field_sources || '{}') as Record<string, string>;
      } catch {
        return {};
      }
    })(),
    siteUrl: row.bgm_id
      ? `https://bgm.tv/subject/${row.bgm_id}`
      : row.anilist_id
        ? `https://anilist.co/anime/${row.anilist_id}`
        : null,
    episodes: episodeRows.map((ep) => ({
      epNumber: ep.ep_number,
      title: ep.title,
      titleCn: ep.title_cn,
      airAtUtc: ep.air_at_utc,
      pubAtUtc: ep.pub_at_utc,
      airSource: ep.air_source,
      pubSource: ep.pub_source,
      conflicting: ep.conflicting === 1,
      isOverridden: ep.is_overridden === 1,
    })),
    my: my ?? null,
  };
}
