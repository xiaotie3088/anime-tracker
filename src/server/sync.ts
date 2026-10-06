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
import { seasonFromId, seasonOf, shiftSeason } from '../core/time.ts';
import type { SeasonInfo } from '../core/time.ts';
import type { RawSeasonAnime, SourceId, Subject, TitleCnSource } from '../core/types.ts';
import { anilistProvider } from '../providers/anilist.ts';
import { bangumiDataProvider } from '../providers/bangumi-data.ts';
import { translateTitles } from '../providers/mt.ts';
import { yucProvider } from '../providers/yuc.ts';
import type { Provider } from '../providers/provider.ts';
import { detectChanges, detectTotalEpsChange, type DetectedChange } from './changes.ts';
import {
  applyMachineTitle,
  autoArchiveFinished,
  backupDatabase,
  emptyArchiveResult,
  listTranslationCandidates,
  logChanges,
  pruneBackups,
  repairSeasonAssignments,
  seasonSubjectCount,
  upsertSubjects,
  type ArchiveResult,
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
};

export async function fetchSeason(season: SeasonInfo): Promise<FetchOutcome> {
  const reports: ProviderReport[] = [];
  const rawGroups: RawSeasonAnime[][] = [];

  for (const provider of PROVIDERS) {
    const startedAt = Date.now();
    try {
      const items = await provider.fetchSeason(season);
      rawGroups.push(items);
      reports.push({ provider: provider.id, ok: true, items: items.length, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      reports.push({
        provider: provider.id,
        ok: false,
        items: 0,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
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
  };
}

export type SyncResult = {
  outcome: FetchOutcome;
  written: number;
  episodeCount: number;
  archive: ArchiveResult;
  /** 本次同步检测到的变更（延期/改档/集数变化） */
  changes: DetectedChange[];
  /** 写库后被纠正季度归属的条目数 */
  seasonRepaired: number;
};

/**
 * 抓取当季并落库。任何单一数据源失败都不会中断整体。
 *
 * 关键顺序：**先比对变更，再写入**。写完之后旧值就不存在了。
 */
export async function syncSeason(db: DatabaseSync, season: SeasonInfo): Promise<SyncResult> {
  const outcome = await fetchSeason(season);

  if (outcome.subjects.length === 0) {
    return {
      outcome,
      written: 0,
      episodeCount: 0,
      archive: emptyArchiveResult(),
      changes: [],
      seasonRepaired: 0,
    };
  }

  // 1) 写入之前先把变更比出来
  const detected: DetectedChange[] = [];
  for (const subject of outcome.subjects) {
    detected.push(...detectChanges(db, subject));
    const totalEpsChange = detectTotalEpsChange(db, subject);
    if (totalEpsChange) detected.push(totalEpsChange);
  }

  // 2) 落库
  const written = upsertSubjects(db, outcome.subjects, season.id);

  // 3) 变更写进日志（放在落库之后，避免日志里引用到还不存在的条目）
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

  return {
    outcome,
    written,
    episodeCount: outcome.subjects.reduce((sum, subject) => sum + subject.episodes.length, 0),
    archive,
    changes: detected,
    seasonRepaired,
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
    written: number;
    episodeCount: number;
    /** 跳过时给出为什么跳过（已有 N 部） */
    note?: string;
    reports: ProviderReport[];
    error?: string;
  }>;
  totalWritten: number;
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
 * 这个季度这次要不要真的抓（纯函数，判定规则单独拎出来就是为了能在离线测试里断言）。
 *
 * 增量语义：库里已经有数据就跳过，除非 `force` —— 「一键更新」每次都把几个季度重抓一遍
 * 既慢又容易触发源站限速。
 */
export function archiveSkipDecision(
  existing: number,
  options: { force?: boolean; minSubjects?: number } = {},
): { skip: boolean; note?: string } {
  const { force = false, minSubjects = 1 } = options;
  if (force || existing < minSubjects) return { skip: false };
  return { skip: true, note: `库里已有 ${existing} 部，跳过（需要重抓请加 force）` };
}

/**
 * 按季度回填历史数据。
 *
 * 三个刻意的设计（对应 docs/决策记录.md D9）：
 *   1. **增量**：已经有数据的季度默认跳过，除非 `force`。
 *      「一键更新」每次都把 4 个季度重抓一遍既慢又容易触发限速。
 *   2. **容忍失败**：老季度的 yuc.wiki 页面多半 404、AniList 也可能查不到，
 *      单个季度失败不能中断整体（每个季度单独 try/catch）。
 *   3. **季度间留间隔**：连续打源站很容易被限速，`intervalMs` 默认 1 秒。
 *
 * 要抓哪些季度由 `resolveArchiveSeasons()` 决定：既支持 `from/to/backfill`，
 * 也支持 `seasons`（用户显式挑的季度列表，可以跳过中间季度、可以是库里没有的季度）。
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
    /** 判定「这个季度已经有数据」的最小条目数 */
    minSubjects?: number;
    intervalMs?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<ArchiveSyncResult> {
  const { force = false, minSubjects = 1, intervalMs = 1_000, onProgress } = options;

  const seasons = resolveArchiveSeasons(options);

  const result: ArchiveSyncResult = { seasons: [], totalWritten: 0, totalEpisodes: 0 };

  for (const [index, seasonId] of seasons.entries()) {
    const existing = seasonSubjectCount(db, seasonId);
    const decision = archiveSkipDecision(existing, { force, minSubjects });
    if (decision.skip) {
      result.seasons.push({
        season: seasonId,
        status: 'skipped',
        written: 0,
        episodeCount: 0,
        note: decision.note,
        reports: [],
      });
      continue;
    }

    if (index > 0 && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    onProgress?.(`正在回填 ${seasonId}…`);

    try {
      const synced = await syncSeason(db, seasonFromId(seasonId));
      const written = synced.written;
      result.totalWritten += written;
      result.totalEpisodes += synced.episodeCount;

      // 全部源都失败、且一条都没抓到 —— 这不算成功，要如实报告
      const anyOk = synced.outcome.reports.some((report) => report.ok);
      const status = written === 0 ? (anyOk ? 'empty' : 'failed') : 'fetched';
      result.seasons.push({
        season: seasonId,
        status,
        written,
        episodeCount: synced.episodeCount,
        ...(status === 'empty' ? { note: '源站没有返回这个季度的数据（老季度常如此）' } : {}),
        ...(status === 'failed' ? { note: '所有数据源都失败了' } : {}),
        reports: synced.outcome.reports,
      });
    } catch (error) {
      result.seasons.push({
        season: seasonId,
        status: 'failed',
        written: 0,
        episodeCount: 0,
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
    minIntervalMs?: number;
    onProgress?: (done: number, total: number, title: string) => void;
  } = {},
): Promise<TranslateResult> {
  const { season = null, limit = 0, minIntervalMs = 700, onProgress } = options;

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

  const result: TranslateResult = { translated: [], skipped, failed: [], candidates: candidates.length };
  if (pending.length === 0) return result;

  const titles = pending.map((candidate) => candidate.titleOriginal ?? candidate.titleEn ?? '');
  const outcomes = await translateTitles(titles, {
    minIntervalMs,
    onProgress: (done, total) => onProgress?.(done, total, titles[done - 1] ?? ''),
  });

  for (const [index, candidate] of pending.entries()) {
    const outcome = outcomes[index];
    const original = titles[index] ?? '';
    if (!outcome?.ok || !outcome.text) {
      result.failed.push({ key: candidate.key, titleOriginal: original, error: outcome?.error ?? '未知错误' });
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
    written: number;
    episodeCount: number;
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
  /** 汇总成一句话，直接可以显示在界面上 */
  summary: {
    written: number;
    episodes: number;
    officialReplaced: number;
    machineFilled: number;
    movedToBacklog: number;
    movedToFinished: number;
    changeCount: number;
    failedProviders: string[];
    translationFailures: number;
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
    /** 连已有数据的季度也重抓 */
    force?: boolean;
    /** 是否做机翻（跑批量翻译很慢，允许关掉） */
    translate?: boolean;
    translateLimit?: number;
    /**
     * 是否用「库里别处的官方中文名」替换临时机翻名。
     * 默认关闭：官方译名真正到达时，syncSeason 的 UPSERT 已经自动替换了它。
     */
    heal?: boolean;
    onProgress?: (message: string) => void;
  } = {},
): Promise<FullUpdateResult> {
  const {
    season = seasonOf(new Date()),
    backfill = DEFAULT_BACKFILL,
    force = false,
    translate = true,
    translateLimit = 0,
    heal = false,
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
  const scope: UpdateScope = {
    mode: explicitSeasons.length > 0 ? 'seasons' : 'backfill',
    seasons: planSeasons,
    backfill: effectiveBackfill,
    backfillIgnored,
    force,
    translateSeasons: planSeasons,
  };
  if (backfillIgnored) {
    onProgress?.(`已按你挑的 ${planSeasons.length} 个季度更新，backfill 参数被忽略`);
  }

  // 用户数据不可重建 —— 动手之前先备份
  const backup = backupDatabase(db, { label: 'pre-update' });
  pruneBackups();

  onProgress?.(`正在抓取 ${mainSeason.label}…`);
  const current = await syncSeason(db, mainSeason);

  onProgress?.(
    scope.mode === 'seasons'
      ? `正在抓取你挑的 ${planSeasons.length} 个季度…`
      : '正在回填历史季度…',
  );
  // 主季上面已经单独抓过一次了，回填阶段把它排除掉：
  //   - 不排除的话报告里同一季会出现两次（「主季写入 59 部」+「2024-07 跳过」），看着自相矛盾；
  //   - `force` 时更糟：同一季会被抓两遍，白打一次源站。
  const archiveSeasons = planSeasons.filter((id) => id !== mainSeason.id);
  let archive: ArchiveSyncResult = { seasons: [], totalWritten: 0, totalEpisodes: 0 };
  try {
    if (archiveSeasons.length > 0) {
      archive = await syncArchive(db, {
        // mode='seasons' 时按用户给的列表（跳过推导）；否则沿用"到当季、往回 backfill 季"。
        ...(scope.mode === 'seasons'
          ? { seasons: archiveSeasons }
          : { toSeason: season.id, backfill: effectiveBackfill }),
        force,
        intervalMs: 1_000,
        onProgress,
      });
    }
  } catch (error) {
    archive = {
      seasons: [
        {
          season: mainSeason.id,
          status: 'failed',
          written: 0,
          episodeCount: 0,
          reports: [],
          error: error instanceof Error ? error.message : String(error),
        },
      ],
      totalWritten: 0,
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

  let translated: TranslateResult = { translated: [], skipped: 0, failed: [], candidates: 0 };
  if (translate) {
    onProgress?.(
      scope.mode === 'seasons'
        ? `正在为挑中的 ${scope.translateSeasons.length} 个季度里缺中文名的番做临时机翻…`
        : '正在为缺中文名的番做临时机翻…',
    );
    try {
      translated = await translateMissingTitles(db, {
        // ⚠ 多季时传**数组**（只翻用户挑的那几季）。不要图省事传 null 全库翻：
        //   那会翻掉用户没选的季度，慢且耗免费接口的额度。
        season: scope.mode === 'seasons' ? scope.translateSeasons : mainSeason.id,
        limit: translateLimit,
        minIntervalMs: 700,
        onProgress: (done, total) => onProgress?.(`机翻中 ${done}/${total}`),
      });
    } catch (error) {
      translated = {
        translated: [],
        skipped: 0,
        failed: [{ key: '', titleOriginal: '', error: error instanceof Error ? error.message : String(error) }],
        candidates: 0,
      };
    }
  }

  const failedProviders = current.outcome.reports.filter((report) => !report.ok).map((report) => report.provider);
  const movedToBacklog = current.archive.toBacklog.length;
  const movedToFinished = current.archive.toFinished.length;

  return {
    season: mainSeason.id,
    current: {
      written: current.written,
      episodeCount: current.episodeCount,
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
    summary: {
      written: current.written + archive.totalWritten,
      episodes: current.episodeCount + archive.totalEpisodes,
      officialReplaced: healed.replaced,
      machineFilled: translated.translated.length,
      movedToBacklog,
      movedToFinished,
      changeCount: current.changes.length,
      failedProviders,
      translationFailures: translated.failed.length,
    },
    moved: current.archive.moved,
  };
}
