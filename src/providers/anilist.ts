/**
 * AniList Provider —— 本项目的「精确时刻」主力源。
 *
 * 它不可替代的地方：`airingSchedule` 会给出**每一集的 UTC 时间戳**，
 * 这是日历能做到「还有 3 小时 12 分更新」而不是「大概今晚」的唯一依据。
 *
 * 它的短板：没有中文标题。所以中文名必须靠 Bangumi / bangumi-data 补，
 * 这正是多源融合存在的理由。
 *
 * 公开数据无需 API Key；官方限速约 90 请求/分钟（降级时 30），
 * 一个季度约 2-4 页，完全够用。
 */

import { z } from 'zod';
import { seasonFromId, weekdayInZone } from '../core/time.ts';
import type { SeasonInfo } from '../core/time.ts';
import type { MediaType, Platform, RawEpisode, RawSeasonAnime, AiringStatus } from '../core/types.ts';
import { postJson } from './http.ts';
import type { Provider } from './provider.ts';
import { parseOrThrow } from './validate.ts';

const ENDPOINT = 'https://graphql.anilist.co';
const PER_PAGE = 50;
const MAX_PAGES = 6;

/**
 * 把 AniList 的季度枚举 + 年份翻成本项目的季度 ID（如 FALL + 2026 -> "2026-10"）。
 *
 * 为什么需要它：`/api/search/import` 把搜索到的一部番落库时，
 * 以前一律写 `season = null` —— 于是一部老番在全季总览里**永远看不到**
 * （总览按 `WHERE season = ?` 过滤），只能在「我的追番」里找到。
 * 用户从搜索加入一部番、再回总览页找，就会觉得「加进去的番没了」。
 *
 * 认不出合法季度时返回 null（交给按放送时刻推导的那条路），不抛错 ——
 * 源站多一个枚举值不该让整次搜索导入失败。
 */
export function anilistSeasonId(season: string | null | undefined, year: number | null | undefined): string | null {
  if (!season || !year) return null;
  const monthBySeason: Record<string, number> = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 };
  const month = monthBySeason[season.toUpperCase()];
  if (!month) return null;
  try {
    return seasonFromId(`${year}-${String(month).padStart(2, '0')}`).id;
  } catch {
    return null;
  }
}

const SEASON_QUERY = `
query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: [POPULARITY_DESC]) {
      id
      idMal
      title { romaji native english }
      synonyms
      coverImage { extraLarge large }
      description(asHtml: false)
      format
      episodes
      duration
      status
      genres
      startDate { year month day }
      studios(isMain: true) { nodes { name } }
      nextAiringEpisode { airingAt episode }
      airingSchedule(perPage: 50) { nodes { airingAt episode } }
      externalLinks { site url type }
    }
  }
}`;

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
      id
      idMal
      title { romaji native english }
      synonyms
      coverImage { extraLarge large }
      description(asHtml: false)
      format
      episodes
      duration
      status
      genres
      season
      seasonYear
      startDate { year month day }
      studios(isMain: true) { nodes { name } }
      nextAiringEpisode { airingAt episode }
      airingSchedule(perPage: 50) { nodes { airingAt episode } }
      externalLinks { site url type }
    }
  }
}`;

// --- 响应校验 -------------------------------------------------------------
// 用 zod 卡住结构：源站改版时我们希望「早点报错」，而不是把脏数据静默写进数据库。

const NullableString = z.string().nullable().optional();

const AniListMediaSchema = z.object({
  id: z.number(),
  idMal: z.number().nullable().optional(),
  title: z
    .object({ romaji: NullableString, native: NullableString, english: NullableString })
    .nullable()
    .optional(),
  synonyms: z.array(z.string()).nullable().optional(),
  coverImage: z
    .object({ extraLarge: NullableString, large: NullableString })
    .nullable()
    .optional(),
  description: NullableString,
  format: NullableString,
  episodes: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  status: NullableString,
  genres: z.array(z.string()).nullable().optional(),
  /** 季度枚举（WINTER/SPRING/SUMMER/FALL）与年份 —— 用于把搜索导入的番回填 season */
  season: NullableString,
  seasonYear: z.number().nullable().optional(),
  startDate: z
    .object({
      year: z.number().nullable().optional(),
      month: z.number().nullable().optional(),
      day: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  studios: z
    .object({ nodes: z.array(z.object({ name: z.string() })).nullable().optional() })
    .nullable()
    .optional(),
  nextAiringEpisode: z
    .object({ airingAt: z.number(), episode: z.number() })
    .nullable()
    .optional(),
  airingSchedule: z
    .object({
      nodes: z.array(z.object({ airingAt: z.number(), episode: z.number() })).nullable().optional(),
    })
    .nullable()
    .optional(),
  externalLinks: z
    .array(z.object({ site: z.string(), url: NullableString, type: NullableString }))
    .nullable()
    .optional(),
});
type AniListMedia = z.infer<typeof AniListMediaSchema>;

const PageResponseSchema = z.object({
  data: z
    .object({
      Page: z
        .object({
          pageInfo: z
            .object({
              total: z.number().nullable().optional(),
              currentPage: z.number().nullable().optional(),
              lastPage: z.number().nullable().optional(),
              hasNextPage: z.boolean().nullable().optional(),
            })
            .nullable()
            .optional(),
          media: z.array(AniListMediaSchema).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string() })).nullable().optional(),
});

// --- 映射 -----------------------------------------------------------------

/** "2026-10-05T15:30:00.000Z" 由 unix 秒转换。 */
function utcFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function mapFormat(format: string | null | undefined): MediaType {
  switch (format) {
    case 'TV':
    case 'TV_SHORT':
      return 'TV';
    case 'ONA':
    case 'WEB':
      return 'WEB';
    case 'OVA':
    case 'SPECIAL':
      return 'OVA';
    case 'MOVIE':
      return 'MOVIE';
    default:
      return 'UNKNOWN';
  }
}

function mapStatus(status: string | null | undefined): AiringStatus {
  switch (status) {
    case 'RELEASING':
      return 'airing';
    case 'FINISHED':
      return 'finished';
    case 'NOT_YET_RELEASED':
      return 'upcoming';
    default:
      return 'unknown';
  }
}

/** AniList 的 externalLinks 里已经带了 B站 等平台的播放页，顺手收集。 */
function mapPlatforms(media: AniListMedia): Platform[] {
  const platforms: Platform[] = [];
  for (const link of media.externalLinks ?? []) {
    const site = link.site ?? '';
    if (!link.url) continue;
    if (/bilibili/i.test(site) || /bilibili\.com/i.test(link.url)) {
      platforms.push({ name: '哔哩哔哩', url: link.url });
    } else if (/crunchyroll/i.test(site)) {
      platforms.push({ name: 'Crunchyroll', url: link.url });
    } else if (/netflix/i.test(site)) {
      platforms.push({ name: 'Netflix', url: link.url });
    }
  }
  // 去重
  return [...new Map(platforms.map((p) => [p.name, p])).values()];
}

function cleanDescription(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .trim() || undefined;
}

function mapMedia(media: AniListMedia): RawSeasonAnime {
  const scheduleNodes = (media.airingSchedule?.nodes ?? []).filter((n) => Number.isFinite(n.airingAt));

  const episodes: RawEpisode[] = scheduleNodes
    .map((node) => ({
      epNumber: node.episode,
      airAtUtc: utcFromUnixSeconds(node.airingAt),
      source: 'anilist' as const,
    }))
    .sort((a, b) => a.epNumber - b.epNumber);

  // 首播时刻优先取分集表第 1 集；退化到 startDate（只有日期，按 JST 00:00 处理）
  let firstAirAtUtc = episodes[0]?.airAtUtc;
  if (!firstAirAtUtc && media.startDate?.year && media.startDate?.month) {
    const day = media.startDate.day ?? 1;
    const wallMs = Date.UTC(media.startDate.year, media.startDate.month - 1, day);
    firstAirAtUtc = new Date(wallMs - 9 * 60 * 60 * 1000).toISOString();
  }

  const broadcastWeekdayJst = firstAirAtUtc ? weekdayInZone(firstAirAtUtc, 'jst') : undefined;

  return {
    source: 'anilist',
    sourceId: String(media.id),
    anilistId: media.id,
    ...(media.idMal ? { malId: media.idMal } : {}),
    // AniList 没有中文标题：titleCn 刻意留空，等 Bangumi / bangumi-data 来填
    ...(media.title?.native ? { titleOriginal: media.title.native } : media.title?.romaji ? { titleOriginal: media.title.romaji } : {}),
    ...(media.title?.english ? { titleEn: media.title.english } : {}),
    aliases: (media.synonyms ?? []).filter(Boolean),
    ...(media.coverImage?.extraLarge ?? media.coverImage?.large
      ? { coverUrl: (media.coverImage.extraLarge ?? media.coverImage.large) as string }
      : {}),
    ...(cleanDescription(media.description) ? { synopsis: cleanDescription(media.description) as string } : {}),
    mediaType: mapFormat(media.format),
    ...(media.episodes ? { totalEps: media.episodes } : {}),
    ...(media.duration ? { durationMin: media.duration } : {}),
    studios: (media.studios?.nodes ?? []).map((n) => n.name),
    genres: (media.genres ?? []).filter(Boolean),
    status: mapStatus(media.status),
    ...(firstAirAtUtc ? { firstAirAtUtc } : {}),
    ...(broadcastWeekdayJst === undefined ? {} : { broadcastWeekdayJst }),
    // 季度：搜索导入时靠它把番归到正确的季度，否则老番在全季总览里永远看不到
    ...(anilistSeasonId(media.season, media.seasonYear) ? { season: anilistSeasonId(media.season, media.seasonYear) as string } : {}),
    platforms: mapPlatforms(media),
    episodes,
    siteUrl: `https://anilist.co/anime/${media.id}`,
  };
}

async function fetchPage(query: string, variables: Record<string, unknown>): Promise<AniListMedia[]> {
  const payload = await postJson<unknown>(ENDPOINT, { query, variables }, { minIntervalMs: 1_200 });
  const parsed = parseOrThrow(PageResponseSchema, payload, 'AniList GraphQL 响应');
  if (parsed.errors?.length) {
    throw new Error(`AniList GraphQL 报错：${parsed.errors.map((e) => e.message).join('; ')}`);
  }
  return parsed.data?.Page?.media ?? [];
}

export const anilistProvider: Provider = {
  id: 'anilist',
  label: 'AniList',
  capabilities: ['season', 'episodes', 'search', 'platforms'],

  async fetchSeason(season: SeasonInfo): Promise<RawSeasonAnime[]> {
    const collected: RawSeasonAnime[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const media = await fetchPage(SEASON_QUERY, {
        season: season.aniList,
        seasonYear: season.year,
        page,
        perPage: PER_PAGE,
      });
      collected.push(...media.map(mapMedia));
      if (media.length < PER_PAGE) break;
    }
    return collected;
  },

  async search(keyword: string, options: { limit?: number } = {}): Promise<RawSeasonAnime[]> {
    const limit = options.limit ?? 20;
    const media = await fetchPage(SEARCH_QUERY, {
      search: keyword,
      page: 1,
      perPage: Math.min(50, limit),
    });
    return media.map(mapMedia);
  },
};
