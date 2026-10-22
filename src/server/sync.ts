/**
 * 同步链路：抓取 → 融合 → 落库 → 自动归档。
 *
 * 抽成独立模块是因为 CLI 与 Web 界面都要用它，
 * 而且这是唯一会「写数据库」的链路，集中在一处便于维护。
 *
 * 三个层次：
 *   fetchSeason  只抓不写（预览用）
 *   syncSeason   抓一个季度并落库（含延期检测与自动归档）
 *   syncArchive  按季度循环回填历史季度（用户诉求：「过季之后还留着之前的番」）
 *   runFullUpdate 真正意义上的「一键更新数据」：当季 + 历史回填 + 机翻 + 汇总报告
 */

import type { DatabaseSync } from 'node:sqlite';

import { MAX_TRANSLATE_LENGTH, decideMachineTranslation } from '../core/mt.ts';
import { mergeSubjects } from '../core/merge.ts';
import { seasonFromId, seasonIsPast, seasonOf, shiftSeason } from '../core/time.ts';
import type { SeasonInfo } from '../core/time.ts';
import type { RawSeasonAnime, SourceId, Subject, TitleCnSource } from '../core/types.ts';
import { anilistProvider } from '../providers/anilist.ts';
import { bangumiDataProvider } from '../providers/bangumi-data.ts';
import { translateTitles } from '../providers/mt.ts';
import { DEFAULT_TRANSLATE_CONCURRENCY, DEFAULT_TRANSLATE_INTERVAL_MS } from '../providers/mt.ts';
import { yucProvider } from '../providers/yuc.ts';
import type { Provider } from '../providers/provider.ts';
import { detectChanges, detectTotalEpsChange, type DetectedChange } from './changes.ts';
import {
  applyIdentityAbsorption,
  applyMachineTitle,
  autoArchiveFinished,
  backupDatabase,
  emptyArchiveResult,
  getSeasonFetchState,
  listTranslationCandidates,
  logChanges,
  pruneBackups,
  recordSeasonFetch,
  recordSyncRun,
  repairSeasonAssignments,
  resolveSubjectIdentity,
  upsertSubjects,
  type ArchiveResult,
  type SeasonFetchState,
  type TranslationCandidate,
} from './db.ts';

/**
 * 已实现的抓取源。
 *
 * 顺序即「谁先跑」，不影响字段优先级（那在 core/merge.ts 里按字段单独定义）。
 * 两个 HTTP 源（bangumi-data、yuc）在前，AniList 的 GraphQL 在后，
 * 这样即使 AniList 限速或超时，也能先拿到中文名与放送时刻。
 */
export const PROVIDERS: readonly Provider[] = [bangumiDataProvider, yucProvider, anilistProvider];

export type ProviderReport = {
  provider: SourceId;
  ok: boolean;
  items: number;
  elapsedMs: number;
  error?: string;
};

export type FetchOutcome = {
  season: SeasonInfo;
  subjects: Subject[];
  reports: ProviderReport[];
  /** 只被单一数据源覆盖的条目数（这些条目通常没有中文名） */
  singleSourceCount: number;
  /** 融合过程合并掉的重复条目数 */
  mergedAway: number;
  /** 这次有没有抓逐集放送时刻（过去季度为 false，见下面的说明） */
  schedules: boolean;
};

/**
 * 抓一个季度（只抓不写）。
 *
 * `schedules`（默认：当季 / 未来季度 true，**过去季度 false**）：
 * 过去季度的番早就播完了，逐集放送时刻没有使用场景 —— 「还有 3 小时更新」对它们是负数，
 * 周视图只关心当季与追番中，而代价是几十倍的 JSON 与几千行 `episode`。
 *
 * ⚠ 刻意**不**把「首播时刻」也算进这个开关：`firstAirAtUtc` 与
 * `broadcastWeekdayJst/TimeJst` 各只有一条，却是季度归属（`deriveSeasonFromAirTimes`）、
 * 总览排序、详情卡「周三 24:30」的唯一依据 —— 省掉它会把整部番的归属弄丢。
 */
export async function fetchSeason(
  season: SeasonInfo,
  options: { schedules?: boolean } = {},
): Promise<FetchOutcome> {
  const schedules = options.schedules ?? !seasonIsPast(season.id);

  // 三个源**并发**抓（第八轮性能优化）：以前是 for/await 串行，
  // 一季要 bangumi-data(0.1s) + yuc(0.5~31s) + AniList(2.7~3.6s) 相加；
  // 实测串行时一季约 5 秒、最慢 37 秒，而真正的下限只是 AniList 的那 3 秒。
  // 并发是安全的：限速是按域名做的（http.ts 的 lastHitByHost / postJson），
  // 三个源分属三个域名，不会互相把对方打快。
  const settled = await Promise.allSettled(
    PROVIDERS.map(async (provider) => {
      const startedAt = Date.now();
      const items = await provider.fetchSeason(season, { schedules });
      return { items, elapsedMs: Date.now() - startedAt };
    }),
  );

  const reports: ProviderReport[] = [];
  const rawGroups: RawSeasonAnime[][] = [];
  for (const [index, outcome] of settled.entries()) {
    const provider = PROVIDERS[index] as Provider;
    if (outcome.status === 'fulfilled') {
      rawGroups.push(outcome.value.items);
      reports.push({
        provider: provider.id,
        ok: true,
        items: outcome.value.items.length,
        elapsedMs: outcome.value.elapsedMs,
      });
    } else {
      reports.push({
        provider: provider.id,
        ok: false,
        items: 0,
        elapsedMs: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }

  const merged = mergeSubjects(rawGroups);
  return {
    season,
    subjects: merged.subjects,
    reports,
    singleSourceCount: merged.singleSourceKeys.length,
    mergedAway: merged.mergedAway,
    schedules,
  };
}

export type SyncResult = {
  outcome: FetchOutcome;
  /** UPSERT 的部数（= 抓到的条数，不等于新增） */
  written: number;
  /** 其中库里原本没有的部数 —— 用户真正关心的「这次多了几部」 */
  added: number;
  episodeCount: number;
  /** 这次有没有抓逐集放送时刻（过去季度为 false） */
  schedules: boolean;
  archive: ArchiveResult;
  /** 本次同步检测到的变更（延期/改档/集数变化） */
  changes: DetectedChange[];
  /** 写库后被纠正季度归属的条目数 */
  seasonRepaired: number;
  /** 身份判定审计（票 A）：主键漂移被拦住之后发生了什么 */
  identity: IdentityAudit;
  /** 本次同步的运行记录 id（sync_run，NULL 表示写账失败 —— 不影响同步本身） */
  runId: number | null;
};

/**
 * 身份判定审计（票 A）。
 *
 * 为什么要把这些**结构化**返回而不是只打日志：`.scratch/duplicate-subjects/issues/01-票A`
 * 的验收要求能回答"这一次更新里，有没有产生新的分叉、有没有哪条脏行因为闸门没过而留下"。
 * 日志是给人看的，这份是给 `runFullUpdate` 的 summary 与 UI 用的。
 */
export type IdentityAudit = {
  /** 原 key -> 命中 key，把主键漂移拦住并**吸收**掉的（这些就是本来会变成新重复的） */
  absorbed: Array<{ from: string; to: string; reason: string; title: string }>;
  /** 本该吸收却因闸门没通过而**留下**的（留给票 B 的 dry-run 报告） */
  skipped: Array<{ key: string; target: string; reason: string }>;
  /** 命中行带着另一个外部 ID：只补空位不当覆盖 */
  conflicts: Array<{ key: string; detail: string }>;
};

function emptyIdentityAudit(): IdentityAudit {
  return { absorbed: [], skipped: [], conflicts: [] };
}

function describeSubject(subject: Subject): string {
  return subject.titleCn ?? subject.titleOriginal ?? subject.titleEn ?? subject.key;
}

/**
 * 抓取当季并落库。任何单一数据源失败都不会中断整体。
 *
 * 关键顺序：**先判定身份 → 再比对变更 → 最后写入**。
 *   1. 身份（`resolveSubjectIdentity`，票 A）：把会漂移的主键纠回库里已有的那一行，
 *      并把该吸收的无 ID 脏行吸收掉；
 *   2. 变更：写完之后旧值就不存在了，所以必须在写之前比；
 *   3. 写入。
 * ⚠ 1 必须在 2 之前：否则 `detectChanges()` 会拿**新 key** 去比**旧 key** 的行，
 *   库里的分集一条都对不上，整部番会被误判成"新增分集"。
 */
export async function syncSeason(
  db: DatabaseSync,
  season: SeasonInfo,
  context: {
    trigger?: 'cli' | 'web' | 'test';
    scope?: 'season' | 'archive-season';
    parentRunId?: number | null;
    /** 强制指定要不要抓逐集放送时刻；默认按「这一季是不是已经过去」判（见 fetchSeason） */
    schedules?: boolean;
  } = {},
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  let outcome: FetchOutcome;
  try {
    outcome = await fetchSeason(season, context.schedules === undefined ? {} : { schedules: context.schedules });
  } catch (error) {
    // 抓取整体失败（三个源全炸）也要留痕：否则"某天数据不对"时又是无据可查
    const runId = recordSyncRun(db, {
      startedAt,
      trigger: context.trigger ?? null,
      scope: context.scope ?? 'season',
      seasons: [season.id],
      providers: [],
      written: 0,
      episodes: 0,
      mergedAway: 0,
      identityAbsorbed: 0,
      identitySkipped: 0,
      error: error instanceof Error ? error.message : String(error),
      parentRunId: context.parentRunId ?? null,
    });
    // 状态记成 failed：判定逻辑对 failed 的态度是「下次重试」，体检里也能看到原因
    recordSeasonFetch(db, {
      season: season.id,
      status: 'failed',
      written: 0,
      episodes: 0,
      added: 0,
      schedules: context.schedules !== false,
      providers: [],
    });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runId });
  }

  if (outcome.subjects.length === 0) {
    const runId = recordSyncRun(db, {
      startedAt,
      trigger: context.trigger ?? null,
      scope: context.scope ?? 'season',
      seasons: [season.id],
      providers: outcome.reports,
      written: 0,
      episodes: 0,
      mergedAway: outcome.mergedAway,
      identityAbsorbed: 0,
      identitySkipped: 0,
      error: null,
      parentRunId: context.parentRunId ?? null,
    });
    // 「源站这一季什么都没给」也是真抓过了 —— 记 empty，下次回填就不会反复打源站
    recordSeasonFetch(db, {
      season: season.id,
      status: 'empty',
      written: 0,
      episodes: 0,
      added: 0,
      schedules: outcome.schedules,
      providers: outcome.reports,
    });
    return {
      outcome,
      written: 0,
      added: 0,
      episodeCount: 0,
      schedules: outcome.schedules,
      archive: emptyArchiveResult(),
      changes: [],
      seasonRepaired: 0,
      identity: emptyIdentityAudit(),
      runId,
    };
  }

  // 1) 身份判定：决定这一批每一条该写进哪一行。
  //    ⚠ 必须在 detectChanges 之前 —— 见上面的说明。
  const identity = emptyIdentityAudit();
  const resolved: Subject[] = [];
  const decisions: Array<{ decision: ReturnType<typeof resolveSubjectIdentity>; subject: Subject }> = [];
  for (const subject of outcome.subjects) {
    const decision = resolveSubjectIdentity(db, subject);
    const entry: Subject = decision.remapped ? { ...subject, key: decision.suggestedKey } : subject;
    for (const detail of decision.idConflicts) {
      identity.conflicts.push({ key: decision.suggestedKey, detail });
    }
    resolved.push(entry);
    decisions.push({ decision, subject: entry });
  }

  // 2) 写入之前先把变更比出来（用的必须是 resolve 之后的 key）
  //
  //    ⚠ 过去季度整体不抓逐集时刻（`outcome.schedules === false`），这时**不做分集级比对**：
  //    "这次没有分集"不等于"分集消失了"。少了这道闸门，一次古早季度回填会刷出
  //    几千条假的 `episode-removed`（正是 changes.ts 头注释里那类假报警）。
  //    集数变化（totalEps）仍然比 —— 它来自 AniList 的 `episodes` 字段，跟排期无关。
  const detected: DetectedChange[] = [];
  for (const subject of resolved) {
    if (outcome.schedules) detected.push(...detectChanges(db, subject));
    const totalEpsChange = detectTotalEpsChange(db, subject);
    if (totalEpsChange) detected.push(totalEpsChange);
  }

  // 3) 落库
  const { written, added } = upsertSubjects(db, resolved, season.id);

  // 3.5) 吸收脏行（票 A）：**必须放在落库之后** —— 被 repoint 的 my_anime 有外键指向保留行，
  //      保留行还不存在时 repoint 会 FOREIGN KEY constraint failed（实测踩到过）。
  //
  //      ⚠ 即使这次是**按 bgm_id 命中**库里那条带 ID 的行，也照样要吸收：
  //      实测就是这个缺口漏掉了真正的重复 —— 按 ID 命中之后归一化标题那层根本不会跑，
  //      而同一部番的 `title:<归一化名>` 脏行还躺在库里，永远碰不到它。
  for (const { decision, subject } of decisions) {
    for (const dirtyKey of decision.absorbKeys) {
      const result = applyIdentityAbsorption(db, dirtyKey, decision.suggestedKey);
      if (result.absorbed) {
        identity.absorbed.push({
          from: dirtyKey,
          to: decision.suggestedKey,
          reason: decision.reason,
          title: describeSubject(subject),
        });
      } else {
        // 闸门没过：**不删也不动引用**，只报告，留给票 B 的 dry-run 报告
        identity.skipped.push({
          key: dirtyKey,
          target: decision.suggestedKey,
          reason: result.reason ?? '未说明',
        });
      }
    }
  }

  // 4) 变更写进日志（放在落库之后，避免日志里引用到还不存在的条目）
  if (detected.length > 0) {
    logChanges(
      db,
      detected.map((change) => ({
        subjectKey: change.subjectKey,
        epNumber: change.epNumber,
        field: change.field,
        kind: change.kind,
        oldValue: change.oldValue,
        newValue: change.newValue,
      })),
    );
  }

  const archive = autoArchiveFinished(db);

  // 写入顺序会决定交叠条目的归属（先写当季、后回填旧季就会被判给旧季），
  // 所以写完之后按「条目自己的放送时刻」统一纠一遍（见 db.ts 的说明）。
  const seasonRepaired = repairSeasonAssignments(db, season.id);

  const episodeCount = resolved.reduce((sum, subject) => sum + subject.episodes.length, 0);
  const runId = recordSyncRun(db, {
    startedAt,
    trigger: context.trigger ?? null,
    scope: context.scope ?? 'season',
    seasons: [season.id],
    providers: outcome.reports,
    written,
    episodes: episodeCount,
    mergedAway: outcome.mergedAway,
    identityAbsorbed: identity.absorbed.length,
    identitySkipped: identity.skipped.length,
    error: null,
    parentRunId: context.parentRunId ?? null,
  });
  recordSeasonFetch(db, {
    season: season.id,
    status: 'fetched',
    written,
    episodes: episodeCount,
    added,
    schedules: outcome.schedules,
    providers: outcome.reports,
  });

  return {
    outcome,
    written,
    added,
    episodeCount,
    schedules: outcome.schedules,
    archive,
    changes: detected,
    seasonRepaired,
    identity,
    runId,
  };
}

// ---------------------------------------------------------------------------
// 历史季度回填（用户诉求 4：「过季之后还会不会保留之前的番剧信息」）
// ---------------------------------------------------------------------------

export type ArchiveSyncResult = {
  /** 每个季度的结果，按调用顺序 */
  seasons: Array<{
    season: string;
    status: 'fetched' | 'skipped' | 'empty' | 'failed';
    /** UPSERT 部数（不等于新增） */
    written: number;
    /** 其中库里原本没有的部数 */
    added: number;
    episodeCount: number;
    /** 这次有没有抓逐集放送时刻（过去季度为 false） */
    schedules: boolean;
    /** 跳过时给出为什么跳过（上次真抓是什么时候、写了多少） */
    note?: string;
    reports: ProviderReport[];
    error?: string;
  }>;
  totalWritten: number;
  totalAdded: number;
  totalEpisodes: number;
};

/**
 * 「回填几个季度（含当季）」的默认档位。
 *
 * ⚠ 只留**这一个**来源：以前 `server.ts` 写 3、`sync.ts` 写 4，同一个参数在两处默认值不同，
 *   用户从界面和从 CLI 触发会得到不同的范围。
 */
export const DEFAULT_BACKFILL = 3;

/**
 * 算出这次要**按顺序尝试**哪些季度（纯函数：不碰数据库、不发请求）。
 *
 * 两条路径（`seasons` 优先，与 `backfill` 同时给时以 `seasons` 为准 —— 见 runFullUpdate 的 scope）：
 *   1. `seasons`：用户自己挑的季度列表，**按给定顺序**用，跳过 `shiftSeason` 推导。
 *      「更新范围可控」这条需求就是冲它来的：可以只挑 2026-10 与 2024-10，
 *      并且允许挑**库里根本没有**的季度（老季度）——这一层不做任何"库里有没有"的判断。
 *   2. `from/to/backfill`：从 `to` 往回数 `backfill` 个季度（含 `to`），再一路推到 `to`。
 *
 * ⚠ `backfill` 必须夹到 >= 1：它是"含当季在内往回数几季"，0 会算出 fromSeason = to 的**下一季**，
 *   原来的循环于是会一路往后推"未来季度"（靠 64 次守卫上限才没炸）。
 * ⚠ `from` 写反了（早于/晚于 `to`）自动换过来 —— 这是原来注释里就想做的事，实际没做到。
 */
export function resolveArchiveSeasons(
  options: {
    seasons?: readonly string[];
    fromSeason?: string;
    toSeason?: string;
    backfill?: number;
  } = {},
): string[] {
  // 1) 显式列表：按给定顺序（去重保序，丢掉空白项）。
  //    ⚠ **显式给了就用它**，哪怕是空数组也返回空 —— 不能因为"空了"就掉回 backfill 推导：
  //      那会在"主季已经单独抓过、回填阶段没有别的季度"时，突然去抓一串没被要求的季度。
  if (options.seasons !== undefined) {
    const explicit: string[] = [];
    for (const raw of options.seasons) {
      const id = String(raw ?? '').trim();
      if (id && !explicit.includes(id)) explicit.push(id);
    }
    return explicit;
  }

  // 2) 区间 / 档位
  const toSeason = options.toSeason ?? seasonOf(new Date()).id;
  const rawBackfill = Math.trunc(Number(options.backfill ?? DEFAULT_BACKFILL));
  const backfill = Number.isFinite(rawBackfill) ? Math.max(1, rawBackfill) : DEFAULT_BACKFILL;
  let start = options.fromSeason ?? shiftSeason(toSeason, -(backfill - 1));
  let end = toSeason;
  if (start > end) [start, end] = [end, start]; // 季度 id 是 'YYYY-NN'，字典序 == 时间序

  const seasons: string[] = [];
  let cursor = start;
  for (let guard = 0; guard < 64; guard += 1) {
    seasons.push(cursor);
    if (cursor === end) break;
    cursor = shiftSeason(cursor, 1);
  }
  return seasons.length > 0 ? seasons : [end];
}

/**
 * 这一季这次要不要真的抓（纯函数，判定规则单独拎出来就是为了能在离线测试里断言）。
 *
 * ⚠ 判据是**抓取记录**（`season_state`），**不是**「库里这一季有几条」。
 * 这是第八轮修掉的那个 bug：
 *   抓 2024-04 时，bangumi-data 的窗口是「季首前 20 天 ~ 季末后 20 天」，而季度归属
 *   按条目自己的放送时刻判定 —— 于是 3 月开播的几条被判进 2024-01、7 月上旬的几条
 *   被判进 2024-07。旧判据「已有 ≥1 部就跳过」就把这两个季度永久判成"抓过了"，
 *   用户看到的是「2024-01 只有 10 部，怎么更新都不增加」。
 *   现在只要 `season_state` 里没有这一季 = 从没真抓过 = 一定去抓。
 */
export function seasonFetchDecision(
  input: {
    /** true = 增量（上次真抓过的跳过）；false = 无条件抓 */
    incremental: boolean;
    force?: boolean;
    /** 这一季上次真抓的结果；`undefined` = 从没真抓过 */
    state?: SeasonFetchState | undefined;
  },
): { skip: boolean; note?: string } {
  const { incremental, force = false, state } = input;
  // 1) force / 非增量 / 从没真抓过 —— 都要真去抓
  if (force || !incremental || !state) return { skip: false };
  // 2) 上次所有源都挂了：那是失败，不是"抓过了"，下次重试
  if (state.lastStatus === 'failed') return { skip: false };
  // 3) 上次真抓过 —— 跳过，并且说清楚"什么时候抓的、抓了多少、怎么重抓"
  const when = state.lastFetchedAt.slice(5, 16).replace('T', ' ');
  const what =
    state.lastStatus === 'empty'
      ? '源站当时没返回数据'
      : `写入 ${state.lastWritten} 部（其中新增 ${state.lastAdded}）`;
  return {
    skip: true,
    note: `上次真抓 ${when}Z，${what}；跳过（要重抓请取消「增量」或加 force）`,
  };
}

/**
 * 按季度回填历史数据。
 *
 * 三个刻意的设计（对应 docs/决策记录.md D9 / D13）：
 *   1. **增量可选**：`incremental` 为真时，**上次真抓过**的季度跳过；
 *      判据是 `season_state`，不是库里现有条目数（见 `seasonFetchDecision`）。
 *      显式挑的季度（`mode: 'explicit'`）默认**不增量** —— 你勾了就该抓。
 *   2. **容忍失败**：老季度的 yuc.wiki 页面多半 404、AniList 也可能查不到，
 *      单个季度失败不能中断整体（每个季度单独 try/catch）。
 *   3. **季度间留间隔**：连续打源站很容易被限速，`intervalMs` 默认 1 秒。
 *
 * 要抓哪些季度由 `resolveArchiveSeasons()` 决定：既支持 `from/to/backfill`，
 * 也支持 `seasons`（用户显式挑的季度列表，可以跳过中间季度、可以是库里没有的季度）。
 *
 * 过去季度会自动不抓逐集放送时刻（`syncSeason` → `fetchSeason` 里的 `seasonIsPast`）。
 */
export async function syncArchive(
  db: DatabaseSync,
  options: {
    /** 用户显式挑的季度列表（按给定顺序），与 from/to/backfill 二选一，优先它 */
    seasons?: readonly string[];
    /** 从哪一季开始（含），默认「当季往前 backfill 个季度」 */
    fromSeason?: string;
    /** 到哪一季结束（含），默认当季 */
    toSeason?: string;
    /** 只回填最近 N 个季度（含当季，N>=1；与 from/to 二选一，from 更明确） */
    backfill?: number;
    force?: boolean;
    /**
     * 增量：跳过「上次真抓过」的季度。
     * 不传时的默认值按 `mode` 走 —— `explicit`（用户勾的）默认全抓，`backfill` 默认增量。
     */
    incremental?: boolean;
    /** 'explicit' = 用户在界面/命令里点的季度；'backfill' = 隐式「当季 + 往回 N 季」 */
    mode?: 'explicit' | 'backfill';
    intervalMs?: number;
    onProgress?: (message: string) => void;
    /** 每季一有结果就回调（界面「更新中」靠它逐季长出来） */
    onSeasonDone?: (entry: ArchiveSyncResult['seasons'][number]) => void;
    /** 返回 true 就在**当前这一季抓完之后**停下，剩下的季度标成 skipped（「停止」按钮） */
    shouldCancel?: () => boolean;
    /** 谁触发的（写进 sync_run） */
    trigger?: 'cli' | 'web' | 'test';
    /** 挂到哪一次「一键更新」下（每季一行 sync_run，靠它串起来） */
    parentRunId?: number | null;
  } = {},
): Promise<ArchiveSyncResult> {
  const { force = false, intervalMs = 1_000, onProgress, shouldCancel, onSeasonDone } = options;
  // 显式挑的季度等于「你点了它」—— 不看增量，直接抓；隐式回填才默认增量。
  const mode = options.mode ?? 'backfill';
  const incremental = options.incremental ?? mode !== 'explicit';

  const seasons = resolveArchiveSeasons(options);

  const result: ArchiveSyncResult = { seasons: [], totalWritten: 0, totalAdded: 0, totalEpisodes: 0 };

  /** 记一季的结果，并顺手喂给界面（「更新中」的逐季进度靠它）。 */
  const pushSeason = (entry: ArchiveSyncResult['seasons'][number]): void => {
    result.seasons.push(entry);
    onSeasonDone?.(entry);
  };

  for (const [index, seasonId] of seasons.entries()) {
    if (shouldCancel?.()) {
      pushSeason({
        season: seasonId,
        status: 'skipped',
        written: 0,
        added: 0,
        episodeCount: 0,
        schedules: false,
        note: '已取消，这一季没抓',
        reports: [],
      });
      continue;
    }
    const state = getSeasonFetchState(db, seasonId);
    const decision = seasonFetchDecision({ incremental, force, state });
    if (decision.skip) {
      pushSeason({
        season: seasonId,
        status: 'skipped',
        written: 0,
        added: 0,
        episodeCount: 0,
        schedules: state?.lastSchedules ?? false,
        note: decision.note,
        reports: [],
      });
      continue;
    }

    if (index > 0 && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    onProgress?.(`正在抓取 ${seasonId}…`);

    try {
      const synced = await syncSeason(db, seasonFromId(seasonId), {
        ...(options.trigger ? { trigger: options.trigger } : {}),
        scope: 'archive-season',
        parentRunId: options.parentRunId ?? null,
      });
      const { written, added } = synced;
      result.totalWritten += written;
      result.totalAdded += added;
      result.totalEpisodes += synced.episodeCount;

      // 全部源都失败、且一条都没抓到 —— 这不算成功，要如实报告
      const anyOk = synced.outcome.reports.some((report) => report.ok);
      const status = written === 0 ? (anyOk ? 'empty' : 'failed') : 'fetched';
      pushSeason({
        season: seasonId,
        status,
        written,
        added,
        episodeCount: synced.episodeCount,
        schedules: synced.schedules,
        ...(status === 'empty' ? { note: '源站没有返回这个季度的数据（老季度常如此）' } : {}),
        ...(status === 'failed' ? { note: '所有数据源都失败了' } : {}),
        reports: synced.outcome.reports,
      });
    } catch (error) {
      pushSeason({
        season: seasonId,
        status: 'failed',
        written: 0,
        added: 0,
        episodeCount: 0,
        schedules: false,
        reports: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 临时机翻译名（用户诉求 3）
// ---------------------------------------------------------------------------

export type TranslatedTitle = {
  key: string;
  titleOriginal: string;
  titleCn: string;
  engine: string;
};

export type TranslateResult = {
  translated: TranslatedTitle[];
  /** 候选里因为「不需要翻」被跳过的数量 */
  skipped: number;
  failed: Array<{ key: string; titleOriginal: string; error: string }>;
  /**
   * 因为点了「停止」而**没翻**的条数。
   *
   * ⚠ 必须与 `failed` 分开：串行/并发池被掐断时，还没轮到的条目在结果数组里是 undefined。
   * 如果把它们算成失败，界面上会冒出几百条"机翻失败"，看着像坏了 —— 其实只是没翻。
   */
  stopped: number;
  /** 这次真正考虑过的候选总数 */
  candidates: number;
};

/**
 * 给缺中文名的条目做临时机翻并落库。
 *
 * 规则本体在 core/mt.ts（decideMachineTranslation），写入规则在 db.ts（applyMachineTitle），
 * 这里只负责「取候选 → 逐条翻 → 写回 → 汇报」。
 *
 * 刻意只处理**一个字都没有**的条目：已经有官方名的会被 applyMachineTitle 拒绝，
 * 已经有临时机翻名的则不该被覆盖 —— 重翻同一部番只会浪费免费额度。
 */
export async function translateMissingTitles(
  db: DatabaseSync,
  options: {
    /** 单个季度 / 多个季度 / null（全库）。多季时**只翻这几季**，见 listTranslationCandidates */
    season?: string | readonly string[] | null;
    limit?: number;
    /** 两条翻译请求之间的最小间隔（默认 250ms；旧版是"每条先睡 700ms"，慢 4 倍） */
    minIntervalMs?: number;
    /** 并发条数（默认 4，实测 0.32 s/条、3.1 请求/秒不触发风控） */
    concurrency?: number;
    /** 返回 true 就停止继续翻（已翻好的照常落库） */
    shouldStop?: () => boolean;
    onProgress?: (done: number, total: number, title: string) => void;
  } = {},
): Promise<TranslateResult> {
  const {
    season = null,
    limit = 0,
    minIntervalMs = DEFAULT_TRANSLATE_INTERVAL_MS,
    concurrency = DEFAULT_TRANSLATE_CONCURRENCY,
    shouldStop,
    onProgress,
  } = options;

  const candidates = listTranslationCandidates(db, {
    season,
    limit,
    includeSkipped: true,
  });

  const pending: TranslationCandidate[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.skipReason) {
      skipped += 1;
      continue;
    }
    const text = candidate.titleOriginal ?? candidate.titleEn ?? '';
    if (text.trim() === '' || text.length > MAX_TRANSLATE_LENGTH) {
      skipped += 1;
      continue;
    }
    pending.push(candidate);
  }

  const result: TranslateResult = { translated: [], skipped, failed: [], stopped: 0, candidates: candidates.length };
  if (pending.length === 0) return result;

  const titles = pending.map((candidate) => candidate.titleOriginal ?? candidate.titleEn ?? '');
  const outcomes = await translateTitles(titles, {
    minIntervalMs,
    concurrency,
    ...(shouldStop ? { shouldStop } : {}),
    onProgress: (done, total) => onProgress?.(done, total, titles[done - 1] ?? ''),
  });

  for (const [index, candidate] of pending.entries()) {
    const outcome = outcomes[index];
    const original = titles[index] ?? '';
    if (!outcome) {
      // 点了「停止」：这一条根本没发出去。既不是成功也不是失败，单独计数。
      result.stopped += 1;
      continue;
    }
    if (!outcome.ok || !outcome.text) {
      result.failed.push({ key: candidate.key, titleOriginal: original, error: outcome.error ?? '未知错误' });
      continue;
    }

    const applied = applyMachineTitle(db, candidate.key, outcome.text);
    if (!applied) {
      result.failed.push({
        key: candidate.key,
        titleOriginal: original,
        error: '已有官方中文名，拒绝用机翻覆盖',
      });
      continue;
    }
    result.translated.push({
      key: candidate.key,
      titleOriginal: original,
      titleCn: outcome.text,
      engine: outcome.engine ?? 'unknown',
    });
  }

  return result;
}

/**
 * 用「别处已经拿到的官方中文名」替换掉临时机翻名。
 *
 * 这是用户明确要的语义：**官方译名一到，一键更新就自动把它换掉**。
 *
 * 为什么需要单独一步：机翻名只写在 `title_cn` 上，不在任何数据源里。
 * 如果某部番的官方译名来自一个我们**没接**的源，或者它落在库里的**另一条记录**上
 * （假重复，实测确实存在：同一部番一条有官方中文名、一条没有），
 * 普通 UPSERT 就不会去覆盖机翻名。这一步按跨源 ID 锚点找官方名，把这类残留换掉。
 */
export function healMachineTitles(db: DatabaseSync): { replaced: number; kept: number } {
  const rows = db
    .prepare("SELECT key FROM subject WHERE title_cn_source = 'machine'")
    .all() as unknown as Array<{ key: string }>;

  let replaced = 0;
  let kept = 0;
  for (const row of rows) {
    const official = findOfficialTitleElsewhere(db, row.key);
    if (!official) {
      kept += 1;
      continue;
    }
    db.prepare(
      `UPDATE subject SET title_cn = ?, title_cn_source = 'official', title_cn_source_at = NULL, updated_at = ?
       WHERE key = ?`,
    ).run(official, new Date().toISOString(), row.key);
    replaced += 1;
  }
  return { replaced, kept };
}

/**
 * 找同一部番在库里别处是否已有官方中文名。
 *
 * 比对依据是跨源 ID 锚点（bgm/anilist/mal）—— 比标题可靠得多。
 * 这正是「假重复」场景的补救：同一部番有两条记录，一条有官方名、一条没有。
 */
function findOfficialTitleElsewhere(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare('SELECT bgm_id, anilist_id, mal_id FROM subject WHERE key = ?')
    .get(key) as { bgm_id: number | null; anilist_id: number | null; mal_id: number | null } | undefined;
  if (!row) return null;

  const conditions: string[] = [];
  const params: number[] = [];
  if (row.bgm_id) {
    conditions.push('bgm_id = ?');
    params.push(row.bgm_id);
  }
  if (row.anilist_id) {
    conditions.push('anilist_id = ?');
    params.push(row.anilist_id);
  }
  if (row.mal_id) {
    conditions.push('mal_id = ?');
    params.push(row.mal_id);
  }
  if (conditions.length === 0) return null;

  const found = db
    .prepare(
      `SELECT title_cn FROM subject
       WHERE (${conditions.join(' OR ')})
         AND key <> ?
         AND title_cn IS NOT NULL AND title_cn <> ''
         AND (title_cn_source IS NULL OR title_cn_source = 'official')
       LIMIT 1`,
    )
    .get(...params, key) as { title_cn: string | null } | undefined;

  return found?.title_cn ?? null;
}

// ---------------------------------------------------------------------------
// 一键更新数据（用户诉求 2）
// ---------------------------------------------------------------------------

export type FullUpdateResult = {
  season: string;
  /** 阶段一：当季 */
  current: {
    /** UPSERT 的部数（不等于新增） */
    written: number;
    /** 其中库里原本没有的部数 */
    added: number;
    episodeCount: number;
    /** 主季有没有抓逐集放送时刻 */
    schedules: boolean;
    reports: ProviderReport[];
    changes: DetectedChange[];
    archive: ArchiveResult;
  };
  /** 阶段二：历史季度回填 */
  archive: ArchiveSyncResult;
  /** 这次实际用了什么范围（用户要能看出"到底抓了哪几季、backfill 有没有被忽略"） */
  scope: UpdateScope;
  /** 阶段三：全库纠正季度归属 */
  seasonsRepaired: number;
  /** 阶段四：官方名替换掉临时机翻名 */
  healed: { replaced: number; kept: number };
  /** 阶段四：给仍然缺中文名的做机翻 */
  translated: TranslateResult;
  /** 自动备份结果（用户数据不可重建，同步前必须先备份） */
  backup: { path: string; bytes: number } | null;
  /**
   * 身份判定审计（票 A）：这次更新里主键漂移被拦住了几条（= 本来会变成新重复的）、
   * 有几条脏行因为闸门没过而留下、有几个外部 ID 冲突。
   */
  identity: IdentityAudit;
  /** 本次「一键更新」在 sync_run 里的 id（回填的每一季是它的子行） */
  runId: number | null;
  /** 用户点了「停止」：已抓到的季度照常落库，没抓的标 skipped */
  cancelled: boolean;
  /** 汇总成一句话，直接可以显示在界面上 */
  summary: {
    /** UPSERT 部数（= 抓到多少条）。以前只有它，于是「重抓一季」永远显示"写入 135 部" */
    written: number;
    /** 其中库里原本没有的部数 —— 这次到底多了几部 */
    added: number;
    episodes: number;
    officialReplaced: number;
    machineFilled: number;
    movedToBacklog: number;
    movedToFinished: number;
    changeCount: number;
    failedProviders: string[];
    translationFailures: number;
    /** 身份判定吸收掉的重复行数（0 = 这次没有新的分叉） */
    identityAbsorbed: number;
    /** 该吸收却没吸收、留给票 B 清理的条数 */
    identitySkipped: number;
  };
  /** 被自动归档移动的番（用户诉求 5：让这个行为可见） */
  moved: ArchiveResult['moved'];
};

/**
 * 这次「更新数据」用了什么范围。
 *
 * 为什么要显式回报：`seasons` 与 `backfill` 同时给的时候以 `seasons` 为准，
 * 但**不能静默忽略** —— 界面与 CLI 都要能说出"我按你挑的季度来，backfill 没生效"。
 */
export type UpdateScope = {
  /** 'seasons' = 用户显式挑了季度；'backfill' = 当季 + 往回 N 季 */
  mode: 'seasons' | 'backfill';
  /** 这次按顺序尝试的季度（含被增量跳过的那些） */
  seasons: string[];
  /** mode='backfill' 时生效的档位（含当季，>=1） */
  backfill: number;
  /** 同时给了 seasons 与 backfill：backfill 被忽略 */
  backfillIgnored: boolean;
  force: boolean;
  /** 增量开关（跳过上次真抓过的季度）—— 界面要能说清"哪些是跳过的、为什么" */
  incremental: boolean;
  /** 机翻覆盖的季度（= mode='seasons' 时用户挑的那几季） */
  translateSeasons: string[];
};

/**
 * 真正意义上的「一键更新数据」。
 *
 * 语义是**全流程**（用户诉求：「这个项目怎么更新数据，要不要加一键更新数据」）：
 *   1. 抓取当季并落库（syncSeason）
 *   2. 增量回填历史季度（syncArchive）
 *   3. 全库纠正季度归属（回填会让归属取决于写入顺序，所以要收口）
 *   4. 官方中文名到达时替换掉临时机翻名（healMachineTitles，默认关闭）
 *   5. 给仍然缺中文名的条目做临时机翻（translateMissingTitles）
 *   6. 汇总成一份报告（UI 一句话 + 明细）
 *
 * 每一步都单独 try/catch：翻译接口挂掉不该让「更新数据」整体失败 ——
 * 前两步（真正重要的抓取）必须已经落库。
 *
 * 「更新范围可控」（`.scratch/update-scope`）：给了 `seasons` 时按用户挑的季度抓
 * （可以跳过中间季度、可以是库里没有的老季度），机翻也只覆盖这几季。
 */
export async function runFullUpdate(
  db: DatabaseSync,
  options: {
    season?: SeasonInfo;
    /** 回填几个季度（含当季），默认 DEFAULT_BACKFILL */
    backfill?: number;
    /**
     * 用户显式挑的季度列表（按给定顺序）。给了它就以它为准、`backfill` 被忽略，
     * 并且**第一个季度就是主季**（与"多选季度看总览时主季 = 第一个选中的"同一套约定）。
     */
    seasons?: readonly string[];
    /** 连「上次真抓过」的季度也重抓（增量开关的另一半） */
    force?: boolean;
    /**
     * 增量：跳过「上次真抓过」的季度（判据是 `season_state`，不是库里现有条目数）。
     *
     * 不传时的默认值按范围走：**显式挑的季度默认不增量**（你勾了就该抓），
     * 隐式 `backfill` 默认增量。界面会给一个「只抓没抓过的」勾选框，
     * 勾上就以 `incremental: true` 传进来。
     */
    incremental?: boolean;
    /** 是否做机翻（跑批量翻译很慢，允许关掉） */
    translate?: boolean;
    translateLimit?: number;
    /** 机翻并发条数（默认 4；实测 0.32 s/条，见 docs/决策记录.md D14） */
    translateConcurrency?: number;
    /** 机翻进度（done/total），供「更新中」界面显示 */
    onTranslateProgress?: (done: number, total: number) => void;
    /** 每季一有结果就回调（界面「更新中」靠它逐季长出来） */
    onSeasonDone?: (entry: { season: string; status: string; written: number; added: number }) => void;
    /** 返回 true 就停止：当前这一季/这一条翻完之后收尾，已落库的数据照常保留 */
    shouldCancel?: () => boolean;
    /**
     * 是否用「库里别处的官方中文名」替换临时机翻名。
     * 默认关闭：官方译名真正到达时，syncSeason 的 UPSERT 已经自动替换了它。
     */
    heal?: boolean;
    /** 谁触发的：只用于写 sync_run 的运行记录 */
    trigger?: 'cli' | 'web' | 'test';
    onProgress?: (message: string) => void;
  } = {},
): Promise<FullUpdateResult> {
  const {
    season = seasonOf(new Date()),
    backfill = DEFAULT_BACKFILL,
    force = false,
    translate = true,
    translateLimit = 0,
    translateConcurrency = DEFAULT_TRANSLATE_CONCURRENCY,
    onTranslateProgress,
    onSeasonDone,
    shouldCancel,
    heal = false,
    trigger,
    onProgress,
  } = options;

  // 范围：用户挑了季度就以它为准（顺序也照他给的），否则"当季 + 往回 backfill 季"。
  const explicitSeasons = (options.seasons ?? []).map((id) => String(id ?? '').trim()).filter(Boolean);
  const planSeasons = resolveArchiveSeasons(
    explicitSeasons.length > 0 ? { seasons: explicitSeasons } : { toSeason: season.id, backfill },
  );
  const backfillIgnored = explicitSeasons.length > 0 && options.backfill !== undefined;
  // 主季：显式列表的第一个（与"多选季度看总览时主季 = 第一个选中的"同一套约定）；
  // 否则就是调用方给的当季。
  const mainSeason = explicitSeasons.length > 0 ? seasonFromId(planSeasons[0] as string) : season;
  // ⚠ 不能用 `x || DEFAULT`：backfill=0 是"只抓当季"（=最小档 1），`0 || 3` 会把它变成 3
  const requestedBackfill = Math.trunc(Number(backfill));
  const effectiveBackfill = Number.isFinite(requestedBackfill)
    ? Math.max(1, requestedBackfill)
    : DEFAULT_BACKFILL;
  const mode = explicitSeasons.length > 0 ? ('seasons' as const) : ('backfill' as const);
  // 显式在回填阶段默认不增量（勾了就该抓）；隐式回填默认增量
  const incremental = options.incremental ?? mode !== 'seasons';
  const scope: UpdateScope = {
    mode,
    seasons: planSeasons,
    backfill: effectiveBackfill,
    backfillIgnored,
    force,
    incremental,
    translateSeasons: planSeasons,
  };
  if (backfillIgnored) {
    onProgress?.(`已按你挑的 ${planSeasons.length} 个季度更新，backfill 参数被忽略`);
  }

  // 用户数据不可重建 —— 动手之前先备份
  const backup = backupDatabase(db, { label: 'pre-update' });
  pruneBackups();

  onProgress?.(`正在抓取 ${mainSeason.label}…`);
  const current = await syncSeason(db, mainSeason, { ...(trigger ? { trigger } : {}), scope: 'season' });
  onSeasonDone?.({
    season: mainSeason.id,
    status: current.written > 0 ? 'fetched' : current.outcome.reports.some((report) => report.ok) ? 'empty' : 'failed',
    written: current.written,
    added: current.added,
  });

  onProgress?.(
    scope.mode === 'seasons'
      ? `正在抓取你挑的 ${planSeasons.length} 个季度…`
      : '正在回填历史季度…',
  );
  // 主季上面已经单独抓过一次了，回填阶段把它排除掉：
  //   - 不排除的话报告里同一季会出现两次（「主季写入 59 部」+「2024-07 跳过」），看着自相矛盾；
  //   - `force` 时更糟：同一季会被抓两遍，白打一次源站。
  const archiveSeasons = planSeasons.filter((id) => id !== mainSeason.id);
  let archive: ArchiveSyncResult = { seasons: [], totalWritten: 0, totalAdded: 0, totalEpisodes: 0 };
  try {
    if (archiveSeasons.length > 0) {
      archive = await syncArchive(db, {
        // mode='seasons' 时按用户给的列表（跳过推导）；否则沿用"到当季、往回 backfill 季"。
        ...(scope.mode === 'seasons'
          ? { seasons: archiveSeasons }
          : { toSeason: season.id, backfill: effectiveBackfill }),
        force,
        incremental,
        // 显式挑的季度在判定上算 explicit（与隐式回填区分开，见 seasonFetchDecision）
        mode: scope.mode === 'seasons' ? 'explicit' : 'backfill',
        // ⚠ 这里**不再**留 1 秒间隔：真正的限速在 http.ts 的按域名 throttle 里
        //   （同一域名两次请求不足间隔才等），季度之间再睡 1 秒纯属白等 ——
        //   15 季就白等 15 秒。`intervalMs` 仍保留给需要更保守节奏的场景。
        intervalMs: 0,
        onProgress,
        ...(onSeasonDone ? { onSeasonDone } : {}),
        ...(shouldCancel ? { shouldCancel } : {}),
        ...(trigger ? { trigger } : {}),
        // 回填的每一季都挂到「这次一键更新」下 —— 否则又回到"无法判定重复来自哪次运行"
        parentRunId: current.runId,
      });
    }
  } catch (error) {
    archive = {
      seasons: [
        {
          season: mainSeason.id,
          status: 'failed',
          written: 0,
          added: 0,
          episodeCount: 0,
          schedules: false,
          reports: [],
          error: error instanceof Error ? error.message : String(error),
        },
      ],
      totalWritten: 0,
      totalAdded: 0,
      totalEpisodes: 0,
    };
  }

  let healed = { replaced: 0, kept: 0 };
  // 回填之后统一纠一遍季度归属：交叠条目的归属取决于写入顺序，不能留着不管。
  let seasonRepaired = 0;
  try {
    seasonRepaired = repairSeasonAssignments(db);
  } catch {
    seasonRepaired = 0;
  }  // 默认**不**做这步：它会用「库里另一条记录」的中文名去覆盖当前机翻名，
  // 而实测发现的假重复说明那个名字未必是同一部番的。官方译名真正到达时，
  // 上一步 syncSeason 的 UPSERT 已经自动完成替换，不需要这条兜底路径。
  if (heal) {
    try {
      healed = healMachineTitles(db);
    } catch {
      healed = { replaced: 0, kept: 0 };
    }
  }

  // 这次**真的抓到东西**的季度 —— 机翻只覆盖它们。
  //
  // 为什么不再用"用户勾的所有季度"：勾 15 季里有 12 季是增量跳过的，那些季度的条目
  // 早就翻过名了，再扫一遍候选池只是白等（实测 517 条候选里，一半来自根本没变化的季度）。
  // 全部被跳过时这里就是空数组 → 机翻阶段整体跳过，增量更新可以快到"几秒"。
  const fetchedSeasons = [
    ...new Set([
      ...(current.written > 0 ? [mainSeason.id] : []),
      ...archive.seasons.filter((item) => item.status === 'fetched').map((item) => item.season),
    ]),
  ];
  scope.translateSeasons = fetchedSeasons;

  let translated: TranslateResult = { translated: [], skipped: 0, failed: [], stopped: 0, candidates: 0 };
  if (translate && fetchedSeasons.length > 0 && !shouldCancel?.()) {
    onProgress?.(`正在为这次抓到的 ${fetchedSeasons.length} 个季度里缺中文名的番做临时机翻…`);
    try {
      translated = await translateMissingTitles(db, {
        // ⚠ 多季时传**数组**（只翻这次真抓到的几季）。不要图省事传 null 全库翻：
        //   那会翻掉用户没动过的季度，慢且耗免费接口的额度。
        season: fetchedSeasons,
        limit: translateLimit,
        concurrency: translateConcurrency,
        ...(shouldCancel ? { shouldStop: shouldCancel } : {}),
        onProgress: (done, total) => {
          onTranslateProgress?.(done, total);
          onProgress?.(`机翻中 ${done}/${total}`);
        },
      });
    } catch (error) {
      translated = {
        translated: [],
        skipped: 0,
        stopped: 0,
        failed: [{ key: '', titleOriginal: '', error: error instanceof Error ? error.message : String(error) }],
        candidates: 0,
      };
    }
  }

  const failedProviders = current.outcome.reports.filter((report) => !report.ok).map((report) => report.provider);
  const movedToBacklog = current.archive.toBacklog.length;
  const movedToFinished = current.archive.toFinished.length;
  // 身份审计只覆盖当季那一次（回填的每一季各自写了自己的 sync_run 行）
  const identity = current.identity;
  if (identity.absorbed.length > 0 || identity.skipped.length > 0 || identity.conflicts.length > 0) {
    onProgress?.(
      `身份判定：拦住主键漂移并吸收重复 ${identity.absorbed.length} 条，` +
        `留给清理 ${identity.skipped.length} 条，外部 ID 冲突 ${identity.conflicts.length} 条`,
    );
  }

  return {
    season: mainSeason.id,
    current: {
      written: current.written,
      added: current.added,
      episodeCount: current.episodeCount,
      schedules: current.schedules,
      reports: current.outcome.reports,
      changes: current.changes,
      archive: current.archive,
    },
    archive,
    scope,
    seasonsRepaired: seasonRepaired,
    healed,
    translated,
    backup: backup ? { path: backup.path, bytes: backup.bytes } : null,
    identity,
    runId: current.runId,
    cancelled: Boolean(shouldCancel?.()),
    summary: {
      written: current.written + archive.totalWritten,
      added: current.added + archive.totalAdded,
      episodes: current.episodeCount + archive.totalEpisodes,
      officialReplaced: healed.replaced,
      machineFilled: translated.translated.length,
      movedToBacklog,
      movedToFinished,
      changeCount: current.changes.length,
      failedProviders,
      translationFailures: translated.failed.length,
      identityAbsorbed: identity.absorbed.length,
      identitySkipped: identity.skipped.length,
    },
    moved: current.archive.moved,
  };
}
