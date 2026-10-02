/**
 * bangumi-data 数据集 Provider —— 「中文名 + 放送时刻 + 平台」的主力源。
 *
 * 实测确认（2026-10-02，见 docs/sources.md）：
 *   - 数据集 8897 条，顶层 { siteMeta, items }
 *   - 当季（2026 秋）66 部，其中 62 部有简体中文名、66 部有 broadcast
 *   - broadcast 是 ISO 8601 重复区间：`R/2026-10-07T15:00:00.000Z/P7D`
 *     → 直接给出日本放送时刻的 UTC 时间戳，还能配合 end 推出全部集数的时刻
 *   - items[].sites 里带 bangumi / aniList / mal 的 ID，这正是跨源合并的锚点
 *   - 当季番通常还没有 B站 链接（版权未公布），所以国内时间必须另从 B站 API 取
 *
 * 数据整体 7.8MB，因此落盘缓存 12 小时，避免每次同步都拉一遍全库。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { parseIsoRepeatingInterval, toLiteralJstTime, type SeasonInfo } from '../core/time.ts';
import type { AiringStatus, MediaType, Platform, RawEpisode, RawSeasonAnime } from '../core/types.ts';
import { fetchText } from './http.ts';
import type { Provider } from './provider.ts';
import { DATA_DIR } from './snapshot.ts';
import { parseOrThrow } from './validate.ts';

const DATASET_URL = 'https://unpkg.com/bangumi-data/dist/data.json';
const CACHE_PATH = path.join(DATA_DIR, 'cache', 'bangumi-data.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_EPISODES_PER_SUBJECT = 300;

/**
 * 只保留「国内（含港澳台）能看」的平台。
 *
 * 实测数据集里共有 38 种平台标识，每部番平均挂 5~8 个日本流媒体
 * （unext / danime / abema / prime…），全部展示只是噪音。
 * 你要的是「在哪能看」，所以这里只留国内平台；Crunchyroll / Netflix 这类
 * 全球平台由 AniList 负责提供，不在这里重复。
 *
 * 说明：dmhy（动漫花园）/ mikan（蜜柑计划）/ acgnx 是资源站而非正版平台，
 * 单独标注为 (BT) 以便你自行取舍是否关注。
 */
const CN_PLATFORM_SITES: Record<string, string> = {
  bilibili: '哔哩哔哩',
  bilibili_tw: '哔哩哔哩（台湾）',
  bilibili_hk_mo: '哔哩哔哩（港澳）',
  bilibili_hk_mo_tw: '哔哩哔哩（港澳台）',
  acfun: 'AcFun',
  iqiyi: '爱奇艺',
  youku: '优酷',
  qq: '腾讯视频',
  mgtv: '芒果TV',
  mytv: 'myTV SUPER（香港）',
  viu: 'Viu',
  muse_hk: '木棉花（香港）',
  muse_tw: '木棉花（台湾）',
  dmhy: '动漫花园 (BT)',
  mikan: '蜜柑计划 (BT)',
  acgnx: 'ACG.RIP (BT)',
};

/** 这些平台的站点 ID 只是资源页编号，不构成「播放页」，不生成链接。 */
const NO_URL_SITES = new Set(['dmhy', 'mikan', 'acgnx']);

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

const SiteEntrySchema = z.object({
  site: z.string(),
  // 实测：85783 个 site 条目里有 28 个没有 id（例如部分爱奇艺条目），所以 id 必须可选
  id: z.string().optional(),
  begin: z.string().nullable().optional(),
  broadcast: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

const ItemSchema = z.object({
  title: z.string(),
  titleTranslate: z.record(z.string(), z.array(z.string())).nullable().optional(),
  type: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
  officialSite: z.string().nullable().optional(),
  begin: z.string().nullable().optional(),
  broadcast: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  sites: z.array(SiteEntrySchema).nullable().optional(),
});
type Item = z.infer<typeof ItemSchema>;

const DatasetSchema = z.object({
  siteMeta: z
    .record(z.string(), z.object({ title: z.string().optional(), urlTemplate: z.string().optional() }))
    .nullable()
    .optional(),
  items: z.array(ItemSchema),
});
type Dataset = z.infer<typeof DatasetSchema>;

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

function cacheIsFresh(): boolean {
  try {
    return Date.now() - statSync(CACHE_PATH).mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * 读取数据集：优先用本地缓存，过期或强制刷新时才下载。
 * 落盘的是**原始响应文本**，保证离线时解析逻辑可以原样重放。
 */
export async function loadDataset(options: { force?: boolean } = {}): Promise<Dataset> {
  if (!options.force && cacheIsFresh()) {
    try {
      return parseOrThrow(DatasetSchema, JSON.parse(readFileSync(CACHE_PATH, 'utf8')), 'bangumi-data 缓存');
    } catch {
      // 缓存损坏或结构变更则重新下载
    }
  }

  const response = await fetchText(DATASET_URL, {
    timeoutMs: 180_000,
    retries: 1,
    minIntervalMs: 0,
    userAgent: 'anime-tracker/0.1 (bangumi-data dataset sync)',
  });
  if (!response.ok) {
    throw new Error(`下载 bangumi-data 失败：HTTP ${response.status}`);
  }

  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, response.text, 'utf8');

  return parseOrThrow(DatasetSchema, JSON.parse(response.text), 'bangumi-data 数据集');
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

function mapType(type: string | null | undefined): MediaType {
  switch ((type ?? '').toLowerCase()) {
    case 'tv':
      return 'TV';
    case 'web':
      return 'WEB';
    case 'ova':
    case 'special':
      return 'OVA';
    case 'movie':
      return 'MOVIE';
    default:
      return 'UNKNOWN';
  }
}

/** 只挑出国内平台，并套用 siteMeta 的 urlTemplate 拼出播放页地址。 */
function mapPlatforms(item: Item, siteMeta: Dataset['siteMeta']): Platform[] {
  const platforms: Platform[] = [];
  for (const entry of item.sites ?? []) {
    const label = CN_PLATFORM_SITES[entry.site];
    if (!label) continue;

    const template = siteMeta?.[entry.site]?.urlTemplate;
    const url =
      !NO_URL_SITES.has(entry.site) && entry.id && template
        ? template.replace('{{id}}', entry.id)
        : entry.url ?? undefined;

    platforms.push({
      name: label,
      ...(entry.id ? { id: entry.id } : {}),
      ...(url ? { url } : {}),
    });
  }
  // 同一平台可能有多条（例如 bilibili 与 bilibili_tw），按展示名去重
  return [...new Map(platforms.map((p) => [p.name, p])).values()];
}

function idOf(item: Item, site: string): number | undefined {
  const entry = (item.sites ?? []).find((s) => s.site === site);
  if (!entry?.id) return undefined;
  const value = Number(entry.id);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 由 broadcast 区间推出分集时刻。
 *
 * 如果数据里带 end（已知完结时刻），可以算出整部番每一集的放送时刻；
 * 正在播出的番通常没有 end，此时只给出第 1 集，其余留给 AniList 的 airingSchedule 补。
 */
function buildEpisodes(item: Item): RawEpisode[] {
  if (!item.broadcast) return [];
  const interval = parseIsoRepeatingInterval(item.broadcast);
  if (!interval) return [];

  const startMs = Date.parse(interval.startUtc);
  const periodMs = interval.periodDays * 86_400_000;
  const endMs = item.end ? Date.parse(item.end) : Number.NaN;

  const count =
    Number.isFinite(endMs) && endMs > startMs
      ? Math.min(MAX_EPISODES_PER_SUBJECT, Math.floor((endMs - startMs) / periodMs) + 1)
      : 1;

  return Array.from({ length: count }, (_, index) => ({
    epNumber: index + 1,
    airAtUtc: new Date(startMs + index * periodMs).toISOString(),
    source: 'bangumi-data' as const,
  }));
}

/** 由 end 推算总集数（低优先级，会被 Bangumi / AniList 的准确值覆盖）。 */
function totalEpsFromEnd(item: Item): number | undefined {
  if (!item.broadcast || !item.end) return undefined;
  const interval = parseIsoRepeatingInterval(item.broadcast);
  if (!interval) return undefined;
  const startMs = Date.parse(interval.startUtc);
  const endMs = Date.parse(item.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  const periodMs = interval.periodDays * 86_400_000;
  return Math.min(MAX_EPISODES_PER_SUBJECT, Math.floor((endMs - startMs) / periodMs) + 1);
}

function mapItem(item: Item, siteMeta: Dataset['siteMeta']): RawSeasonAnime | null {
  const zhHans = item.titleTranslate?.['zh-Hans'] ?? [];
  const zhHant = item.titleTranslate?.['zh-Hant'] ?? [];
  const en = item.titleTranslate?.['en'] ?? [];

  const beginMs = item.begin ? Date.parse(item.begin) : Number.NaN;
  const broadcast = item.broadcast ? parseIsoRepeatingInterval(item.broadcast) : null;

  // 放送时刻：优先用 broadcast 的起点，退化到 begin
  const firstAirCandidates = [broadcast?.startUtc, Number.isFinite(beginMs) ? item.begin : undefined].filter(
    (value): value is string => typeof value === 'string',
  );
  const firstAirAtUtc = firstAirCandidates[0];
  if (!firstAirAtUtc) return null;

  const literal = toLiteralJstTime(firstAirAtUtc);
  const totalEps = totalEpsFromEnd(item);
  const bgmId = idOf(item, 'bangumi');

  // 数据集里没有「当前是否在播」这个字段，只能靠 begin/end 推断
  const now = Date.now();
  const startMs = Date.parse(firstAirAtUtc);
  const endMs = item.end ? Date.parse(item.end) : Number.NaN;
  let status: AiringStatus = 'unknown';
  if (Number.isFinite(startMs) && startMs > now) status = 'upcoming';
  else if (Number.isFinite(endMs) && endMs < now) status = 'finished';
  else if (Number.isFinite(startMs) && startMs <= now) status = 'airing';

  return {
    source: 'bangumi-data',
    // 优先用 Bangumi 条目 ID 作为源内标识，这样两个源都指向同一部番时更好对齐
    sourceId: bgmId === undefined ? item.title : String(bgmId),
    ...(bgmId === undefined ? {} : { bgmId }),
    ...(idOf(item, 'aniList') === undefined ? {} : { anilistId: idOf(item, 'aniList') }),
    ...(idOf(item, 'mal') === undefined ? {} : { malId: idOf(item, 'mal') }),

    ...(zhHans[0] ? { titleCn: zhHans[0] } : {}),
    titleOriginal: item.title,
    ...(en[0] ? { titleEn: en[0] } : {}),
    // 其余译名全部收进别名，让「B站译名 / 繁中译名 / 日文原名」都能搜到
    aliases: [...new Set([...zhHans.slice(1), ...zhHant, ...en.slice(1), item.title])].filter(
      (alias) => alias !== zhHans[0],
    ),

    mediaType: mapType(item.type),
    ...(totalEps === undefined ? {} : { totalEps }),
    // 数据集里没有制作公司与类型标签，留给 Bangumi / AniList 补
    studios: [],
    genres: [],
    status,
    firstAirAtUtc,
    broadcastWeekdayJst: literal.broadcastWeekdayJst,
    broadcastTimeJst: literal.hhmmJst,
    platforms: mapPlatforms(item, siteMeta),
    episodes: buildEpisodes(item),
    siteUrl: `https://bangumi.tv/subject_search/${encodeURIComponent(item.title)}`,
    ...(item.comment ? { synopsis: item.comment } : {}),
  };
}

// ---------------------------------------------------------------------------

export const bangumiDataProvider: Provider = {
  id: 'bangumi-data',
  label: 'bangumi-data 数据集',
  capabilities: ['season', 'platforms'],

  async fetchSeason(season: SeasonInfo): Promise<RawSeasonAnime[]> {
    const dataset = await loadDataset();

    // 宽松区间：收纳「提前一周开播」与「延后到季初才完结」的番
    const paddingDays = 20;
    const seasonStart = Date.UTC(season.year, season.month - 1, 1) - paddingDays * 86_400_000;
    const seasonEnd = Date.UTC(season.year, season.month + 2, 1) + paddingDays * 86_400_000;

    const result: RawSeasonAnime[] = [];
    for (const item of dataset.items) {
      const beginMs = item.begin ? Date.parse(item.begin) : Number.NaN;
      if (!Number.isFinite(beginMs)) continue;
      if (beginMs < seasonStart || beginMs >= seasonEnd) continue;

      const mapped = mapItem(item, dataset.siteMeta);
      if (mapped) result.push(mapped);
    }

    return result;
  },
};
