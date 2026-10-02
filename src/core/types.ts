/**
 * 统一数据模型
 *
 * 分三层：
 *   RawSeasonAnime / RawEpisode —— 单个数据源吐出来的原始条目（字段可缺失）
 *   Subject / Episode           —— 多源融合后的规范条目（本项目对外的主模型）
 *   MyAnime / ChangeLogEntry    —— 属于「你」的数据：追番、补番、进度、变更历史
 *
 * 设计原则：**任何字段都可能来自不同数据源**，所以规范模型带 fieldSources 记录
 * 每个字段的出处，UI 上可以显示「这个时间来自 AniList / 这个来自 B站」，
 * 数据源打架时不静默取舍。
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------

export const SOURCE_IDS = ['bangumi-data', 'bangumi', 'anilist', 'jikan', 'bilibili', 'yuc', 'manual', 'mt'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
export const SourceIdSchema = z.enum(SOURCE_IDS);

export const SOURCE_LABELS: Record<SourceId, string> = {
  'bangumi-data': 'bangumi-data 数据集',
  bangumi: 'Bangumi',
  anilist: 'AniList',
  jikan: 'Jikan (MAL)',
  bilibili: '哔哩哔哩',
  yuc: 'yuc.wiki（校对）',
  manual: '手动修正',
  mt: '机器翻译（临时）',
};

// ---------------------------------------------------------------------------
// 中文名的出处：官方的，还是机器翻译兜底的
// ---------------------------------------------------------------------------

/**
 * `official` = 来自官方/人工数据源（bangumi-data / bangumi / yuc），可信、长期有效。
 * `machine`  = 机器翻译兜底出来的**临时**名字；官方译名一旦出现必须被替换掉。
 *
 * 刻意用「两态」而不是「三态」：数据库里 NULL 一律视为 official，
 * 这样引入这个字段之前落库的历史数据不需要任何迁移就语义正确。
 */
export const TITLE_CN_SOURCES = ['official', 'machine'] as const;
export type TitleCnSource = (typeof TITLE_CN_SOURCES)[number];
export const TitleCnSourceSchema = z.enum(TITLE_CN_SOURCES);

export const TITLE_CN_SOURCE_LABELS: Record<TitleCnSource, string> = {
  official: '官方译名',
  machine: '临时机翻',
};

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

export const MEDIA_TYPES = ['TV', 'WEB', 'OVA', 'MOVIE', 'UNKNOWN'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const MediaTypeSchema = z.enum(MEDIA_TYPES);

export const AIRING_STATUSES = ['upcoming', 'airing', 'finished', 'unknown'] as const;
export type AiringStatus = (typeof AIRING_STATUSES)[number];
export const AiringStatusSchema = z.enum(AIRING_STATUSES);

/**
 * 追番分类。补番库 = backlog。
 *
 * 「番剧没看完但到下一季了」这件事在这里被显式建模：
 * 季末同步时，处在 tracking、已开播完、但 watchedEps < totalEps 的条目
 * 会自动迁移到 backlog（见 merge/archive 逻辑）。
 */
export const TRACK_CATEGORIES = ['tracking', 'backlog', 'finished', 'dropped'] as const;
export type TrackCategory = (typeof TRACK_CATEGORIES)[number];
export const TrackCategorySchema = z.enum(TRACK_CATEGORIES);

export const TRACK_CATEGORY_LABELS: Record<TrackCategory, string> = {
  tracking: '追番中',
  backlog: '补番库',
  finished: '已看完',
  dropped: '弃番',
};

// ---------------------------------------------------------------------------
// 平台
// ---------------------------------------------------------------------------

export const PlatformSchema = z.object({
  /** 展示名，如「哔哩哔哩」 */
  name: z.string(),
  /** 平台内部 ID（如 B站 season_id） */
  id: z.string().optional(),
  /** 播放页地址 */
  url: z.string().optional(),
  /** 该平台上是否已确定更新时间 */
  hasSchedule: z.boolean().optional(),
});
export type Platform = z.infer<typeof PlatformSchema>;

// ---------------------------------------------------------------------------
// 原始条目（单源）
// ---------------------------------------------------------------------------

export const RawEpisodeSchema = z.object({
  epNumber: z.number(),
  title: z.string().optional(),
  titleCn: z.string().optional(),
  /** 日本放送精确时刻（ISO8601 UTC） */
  airAtUtc: z.string().optional(),
  /** 国内平台可看时刻（ISO8601 UTC） */
  pubAtUtc: z.string().optional(),
  source: SourceIdSchema,
});
export type RawEpisode = z.infer<typeof RawEpisodeSchema>;

export const RawSeasonAnimeSchema = z.object({
  source: SourceIdSchema,
  /** 该数据源内部的 ID（用于回源查询） */
  sourceId: z.string(),

  // 跨源锚点
  bgmId: z.number().optional(),
  anilistId: z.number().optional(),
  malId: z.number().optional(),
  biliSeasonId: z.number().optional(),

  // 标题
  titleCn: z.string().optional(),
  titleOriginal: z.string().optional(),
  titleEn: z.string().optional(),
  aliases: z.array(z.string()).default([]),

  // 基本属性
  coverUrl: z.string().optional(),
  synopsis: z.string().optional(),
  mediaType: MediaTypeSchema.default('UNKNOWN'),
  totalEps: z.number().optional(),
  durationMin: z.number().optional(),
  studios: z.array(z.string()).default([]),
  genres: z.array(z.string()).default([]),
  status: AiringStatusSchema.default('unknown'),

  // 放送信息
  /** 首播精确时刻（ISO8601 UTC） */
  firstAirAtUtc: z.string().optional(),
  /**
   * 这部番属于哪个季度（形如 "2026-10"）。
   *
   * 为什么数据源要给出它：抓取时季度是由调用方指定的（`fetchSeason(season)`），
   * 但**搜索导入**没有这个上下文 —— 用户搜一部老番加进来时，
   * 以前只能写 `season = null`，于是那部番在全季总览里永远看不到
   * （总览按 `WHERE season = ?` 过滤），只能在「我的追番」里找到。
   */
  season: z.string().optional(),
  /** 放送日历归属星期，0=周日 */
  broadcastWeekdayJst: z.number().min(0).max(6).optional(),
  /** 字面放送时间，如 "24:30" */
  broadcastTimeJst: z.string().optional(),

  platforms: z.array(PlatformSchema).default([]),
  episodes: z.array(RawEpisodeSchema).default([]),
  siteUrl: z.string().optional(),
});
export type RawSeasonAnime = z.infer<typeof RawSeasonAnimeSchema>;

// ---------------------------------------------------------------------------
// 规范条目（多源融合后）
// ---------------------------------------------------------------------------

export const EpisodeSchema = z.object({
  epNumber: z.number(),
  title: z.string().optional(),
  titleCn: z.string().optional(),
  /** 日本放送精确时刻 */
  airAtUtc: z.string().optional(),
  /** 国内平台可看时刻 */
  pubAtUtc: z.string().optional(),
  /** 日本放送日历归属星期（深夜番用，0=周日） */
  broadcastWeekdayJst: z.number().min(0).max(6).optional(),
  durationMin: z.number().optional(),
  /** 该集时刻的出处 */
  airSource: SourceIdSchema.optional(),
  pubSource: SourceIdSchema.optional(),
  /** 数据源之间存在分歧时置为 true，UI 上给出提示 */
  conflicting: z.boolean().default(false),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export const SubjectSchema = z.object({
  /** 内部主键，稳定不变；融合时以 bgmId 优先锚定 */
  key: z.string(),
  bgmId: z.number().optional(),
  anilistId: z.number().optional(),
  malId: z.number().optional(),
  biliSeasonId: z.number().optional(),

  titleCn: z.string().optional(),
  titleOriginal: z.string().optional(),
  titleEn: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  /**
   * titleCn 的出处。注意它**不**进 fieldSources —— 那个表是给官方源用的字段级出处，
   * 机翻名只写这一列，避免把自己伪装成官方来源（见 docs/决策记录.md D8）。
   */
  titleCnSource: TitleCnSourceSchema.default('official'),

  coverUrl: z.string().optional(),
  synopsis: z.string().optional(),
  mediaType: MediaTypeSchema.default('UNKNOWN'),
  totalEps: z.number().optional(),
  durationMin: z.number().optional(),
  studios: z.array(z.string()).default([]),
  genres: z.array(z.string()).default([]),
  status: AiringStatusSchema.default('unknown'),

  /** 首播精确时刻（ISO8601 UTC） */
  firstAirAtUtc: z.string().optional(),
  /** 这部番属于哪个季度（形如 "2026-10"）；抓取时由调用方指定，搜索导入时由数据源给出 */
  season: z.string().optional(),
  /** 放送日历归属星期，0=周日 */
  broadcastWeekdayJst: z.number().min(0).max(6).optional(),
  /** 字面放送时间，如 "24:30" */
  broadcastTimeJst: z.string().optional(),

  platforms: z.array(PlatformSchema).default([]),
  episodes: z.array(EpisodeSchema).default([]),
  /** 该条目由哪些源提供 */
  sources: z.array(SourceIdSchema).default([]),
  /** 字段级出处，如 { broadcastTimeJst: 'yuc' } */
  fieldSources: z.record(z.string(), SourceIdSchema).default({}),
  /** 参与融合的原始条目数量（>1 说明做过合并） */
  mergedFrom: z.number().default(1),
});
export type Subject = z.infer<typeof SubjectSchema>;

// ---------------------------------------------------------------------------
// 属于「你」的数据
// ---------------------------------------------------------------------------

export const MyAnimeSchema = z.object({
  subjectKey: z.string(),
  category: TrackCategorySchema.default('tracking'),
  /** 已看到第几集（REAL 以支持 5.5 话） */
  watchedEps: z.number().default(0),
  notifyEnabled: z.boolean().default(true),
  /** 补番库可选：排进日历的星期（0=周日）；不设则纯待看清单 */
  plannedWeekdayJst: z.number().min(0).max(6).nullable().default(null),
  /** 补番库可选：每天看几集，用于生成「今日补番任务」 */
  plannedEpsPerDay: z.number().positive().nullable().default(null),
  /** 补番库内排序，数字越小越靠前 */
  priority: z.number().default(100),
  note: z.string().optional(),
  addedAt: z.string(),
  updatedAt: z.string(),
});
export type MyAnime = z.infer<typeof MyAnimeSchema>;

export const ChangeLogEntrySchema = z.object({
  subjectKey: z.string(),
  epNumber: z.number().nullable(),
  field: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  detectedAt: z.string(),
});
export type ChangeLogEntry = z.infer<typeof ChangeLogEntrySchema>;

// ---------------------------------------------------------------------------
// 业务规则（实现在 core/backlog.ts，那里没有运行时依赖）
// ---------------------------------------------------------------------------

export { remainingEpisodes, shouldArchiveToBacklog } from './backlog.ts';
