/**
 * 多源融合：把 N 个数据源吐出来的原始条目合并成规范条目。
 *
 * 为什么不能只用一个源：没有任何一个源同时具备
 *   - 中文译名与国内平台链接（bangumi-data / Bangumi 强）
 *   - 每集精确到秒的 UTC 放送时刻（AniList 强）
 *   - 国内平台实际可看时刻（B站强）
 *   - 人工校对的当季信息（yuc.wiki 强）
 *
 * 融合策略：
 *   1) 身份聚类：靠 bgmId / anilistId / malId / biliSeasonId / 归一化标题 做并查集，
 *      只要两个源共享任一锚点就认为是一部番。
 *   2) 字段级优先级：每个字段单独定义源的优先级表 —— 因为不同源在不同字段上强弱相反
 *      （例如「精确时刻」AniList 最强，但「字面放送时间 24:30」是 yuc/bangumi-data 更强）。
 *   3) 记录出处：fieldSources 保留每个字段最终来自哪个源，UI 可展示、可排查。
 */

import type { Episode, RawEpisode, RawSeasonAnime, SourceId, Subject } from './types.ts';

/** 字段级源优先级（从左到右依次降级）。 */
export const FIELD_PRIORITY: Record<string, readonly SourceId[]> = {
  titleCn: ['bangumi', 'bangumi-data', 'yuc', 'anilist', 'jikan', 'bilibili'],
  titleOriginal: ['bangumi', 'bangumi-data', 'anilist', 'jikan', 'yuc', 'bilibili'],
  titleEn: ['anilist', 'jikan', 'bangumi-data', 'bangumi'],
  coverUrl: ['bangumi', 'bangumi-data', 'anilist', 'jikan', 'yuc', 'bilibili'],
  synopsis: ['bangumi', 'anilist', 'jikan', 'bangumi-data'],
  mediaType: ['bangumi', 'bangumi-data', 'anilist', 'jikan', 'bilibili', 'yuc'],
  totalEps: ['bangumi', 'anilist', 'jikan', 'bangumi-data', 'bilibili', 'yuc'],
  durationMin: ['anilist', 'jikan', 'bangumi', 'bangumi-data'],
  studios: ['bangumi', 'anilist', 'jikan', 'bangumi-data'],
  genres: ['bangumi', 'anilist', 'jikan', 'bangumi-data'],
  status: ['anilist', 'bangumi', 'jikan', 'bangumi-data', 'bilibili', 'yuc'],
  // 首播精确时刻：bangumi-data 给的是 broadcast 区间的 UTC 起点（精确到秒），
  // 而 AniList 在没有 airingSchedule 时会用 startDate 退化（只有日期，00:00 JST），
  // 所以这里让 bangumi-data 优先。分集级别的时刻仍然优先 AniList（见 EPISODE_AIR_PRIORITY）。
  firstAirAtUtc: ['bangumi-data', 'anilist', 'jikan', 'bangumi', 'yuc'],
  // 注意：字面放送时间与放送日历归属，反而是人工维护的源更准
  //   - yuc.wiki 的按天网格直接给 「25:00」这种字面写法，并显式按星期排列，
  //     不需要任何反推，所以它排第一。
  //   - AniList 只给 UTC 时间戳，要反推字面写法得靠「凌晨 0-6 点算前一天」的惯例。
  broadcastWeekdayJst: ['yuc', 'bangumi', 'bangumi-data', 'jikan', 'anilist'],
  broadcastTimeJst: ['yuc', 'bangumi-data', 'bangumi', 'jikan', 'anilist'],
  // 季度归属：优先人工维护的源，AniList 的 season/seasonYear 殿后。
  // 它只在**搜索导入**这种没有抓取上下文的地方才起作用（抓取时季度由调用方指定）。
  season: ['yuc', 'bangumi', 'bangumi-data', 'jikan', 'anilist'],
};

/** 逐集时刻的源优先级：精确时刻优先 AniList，国内可看时刻优先 B站。 */
export const EPISODE_AIR_PRIORITY: readonly SourceId[] = ['anilist', 'jikan', 'bangumi', 'bangumi-data', 'yuc', 'bilibili'];
export const EPISODE_PUB_PRIORITY: readonly SourceId[] = ['bilibili', 'yuc', 'bangumi-data', 'manual'];

/**
 * 标题归一化：用于跨源匹配。
 * 处理：大小写、全角半角、空白与常见标点、季数后缀（第2季 / Season 2 / II / 2nd Season）。
 *
 * TODO(Phase 1)：接入简繁转换（opencc）。B站译名与 Bangumi 译名常一个简体一个繁体，
 * 目前只能靠同一部番的其他锚点（id）兜住，没有 id 时会漏配。
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～、-〜・「」『』（）［］【】〈〉《》〔〕]/g, '')
    .replace(/(第[0-9一二三四五六七八九十]+[季期部章]|season[0-9]+|[0-9]+(?:st|nd|rd|th)season|part[0-9]+|[0-9]+期|Ⅱ|Ⅲ|Ⅳ|ii|iii|iv)$/g, '');
}

type Cluster = {
  keys: Set<string>;
  raws: RawSeasonAnime[];
};

function anchorsOf(raw: RawSeasonAnime): string[] {
  const keys: string[] = [];
  if (raw.bgmId) keys.push(`bgm:${raw.bgmId}`);
  if (raw.anilistId) keys.push(`anilist:${raw.anilistId}`);
  if (raw.malId) keys.push(`mal:${raw.malId}`);
  if (raw.biliSeasonId) keys.push(`bili:${raw.biliSeasonId}`);
  for (const title of [raw.titleCn, raw.titleOriginal, raw.titleEn, ...raw.aliases]) {
    if (title && title.trim()) keys.push(`title:${normalizeTitle(title)}`);
  }
  return keys;
}

/** 按字段优先级从一组原始条目里挑值，并记录最终出处。 */
function pickField<K extends keyof RawSeasonAnime>(
  raws: RawSeasonAnime[],
  field: K,
  fieldSources: Record<string, SourceId>,
): RawSeasonAnime[K] | undefined {
  const priority = FIELD_PRIORITY[field as string] ?? [];
  const ordered = [...raws].sort((a, b) => {
    const ia = priority.indexOf(a.source);
    const ib = priority.indexOf(b.source);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  for (const raw of ordered) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    fieldSources[field as string] = raw.source;
    return value;
  }
  return undefined;
}

function mergeEpisodes(raws: RawSeasonAnime[]): Episode[] {
  const byNumber = new Map<number, Episode>();

  const airRank = (source: SourceId) => {
    const i = EPISODE_AIR_PRIORITY.indexOf(source);
    return i === -1 ? 999 : i;
  };
  const pubRank = (source: SourceId) => {
    const i = EPISODE_PUB_PRIORITY.indexOf(source);
    return i === -1 ? 999 : i;
  };

  for (const raw of raws) {
    for (const ep of raw.episodes as RawEpisode[]) {
      const existing = byNumber.get(ep.epNumber);
      const candidate: Episode = existing ?? {
        epNumber: ep.epNumber,
        conflicting: false,
      };

      if (ep.title && !candidate.title) candidate.title = ep.title;
      if (ep.titleCn && !candidate.titleCn) candidate.titleCn = ep.titleCn;

      if (ep.airAtUtc) {
        if (!candidate.airAtUtc) {
          candidate.airAtUtc = ep.airAtUtc;
          candidate.airSource = ep.source;
        } else if (candidate.airAtUtc !== ep.airAtUtc) {
          const existingRank = airRank(candidate.airSource ?? raw.source);
          if (airRank(ep.source) < existingRank) {
            candidate.airAtUtc = ep.airAtUtc;
            candidate.airSource = ep.source;
          }
          candidate.conflicting = true;
        }
      }

      if (ep.pubAtUtc) {
        if (!candidate.pubAtUtc) {
          candidate.pubAtUtc = ep.pubAtUtc;
          candidate.pubSource = ep.source;
        } else if (candidate.pubAtUtc !== ep.pubAtUtc) {
          const existingRank = pubRank(candidate.pubSource ?? raw.source);
          if (pubRank(ep.source) < existingRank) {
            candidate.pubAtUtc = ep.pubAtUtc;
            candidate.pubSource = ep.source;
          }
          candidate.conflicting = true;
        }
      }

      byNumber.set(ep.epNumber, candidate);
    }
  }

  return [...byNumber.values()].sort((a, b) => a.epNumber - b.epNumber);
}

function mergePlatforms(raws: RawSeasonAnime[]): Subject['platforms'] {
  const byName = new Map<string, Subject['platforms'][number]>();
  for (const raw of raws) {
    for (const platform of raw.platforms) {
      const existing = byName.get(platform.name);
      if (!existing) {
        byName.set(platform.name, { ...platform });
        continue;
      }
      if (!existing.url && platform.url) existing.url = platform.url;
      if (!existing.id && platform.id) existing.id = platform.id;
      if (platform.hasSchedule) existing.hasSchedule = true;
    }
  }
  return [...byName.values()];
}

/** 内部主键：优先用 bgmId（中文生态的锚点），否则退化到归一化标题。 */
function primaryKey(cluster: Cluster): string {
  const sorted = [...cluster.keys].sort();
  const bgm = sorted.find((k) => k.startsWith('bgm:'));
  if (bgm) return bgm;
  const anilist = sorted.find((k) => k.startsWith('anilist:'));
  if (anilist) return anilist;
  const mal = sorted.find((k) => k.startsWith('mal:'));
  if (mal) return mal;
  const bili = sorted.find((k) => k.startsWith('bili:'));
  if (bili) return bili;
  return sorted[0] ?? `unknown:${Math.random().toString(36).slice(2)}`;
}

function collectAliases(raws: RawSeasonAnime[]): string[] {
  const set = new Set<string>();
  for (const raw of raws) {
    for (const t of [raw.titleCn, raw.titleOriginal, raw.titleEn, ...raw.aliases]) {
      if (t && t.trim()) set.add(t.trim());
    }
  }
  // 规范字段中已单独保留的标题不必再重复进 aliases
  const cn = raws.map((r) => r.titleCn).find(Boolean);
  const original = raws.map((r) => r.titleOriginal).find(Boolean);
  if (cn) set.delete(cn);
  if (original) set.delete(original);
  return [...set];
}

export type MergeResult = {
  subjects: Subject[];
  /** 聚类过程被合并掉的原始条目数（>0 说明确实做了去重） */
  mergedAway: number;
  /** 只被单一数据源覆盖的条目 key —— 这些是「置信度较低」的条目 */
  singleSourceKeys: string[];
};

/** 把多个数据源的结果融合成规范条目列表。 */
export function mergeSubjects(rawGroups: RawSeasonAnime[][]): MergeResult {
  const all = rawGroups.flat();
  const clusters: Cluster[] = [];
  const keyToCluster = new Map<string, Cluster>();

  for (const raw of all) {
    const anchors = anchorsOf(raw);
    const owners = new Set<Cluster>();
    for (const anchor of anchors) {
      const found = keyToCluster.get(anchor);
      if (found) owners.add(found);
    }

    let target: Cluster;
    if (owners.size === 0) {
      target = { keys: new Set(anchors), raws: [] };
      clusters.push(target);
    } else {
      const list = [...owners];
      target = list[0] as Cluster;
      // 合并到同一个簇：把其他簇的 raw 与 key 都搬过来
      for (const other of list.slice(1)) {
        for (const r of other.raws) target.raws.push(r);
        for (const k of other.keys) {
          target.keys.add(k);
          keyToCluster.set(k, target);
        }
        const index = clusters.indexOf(other);
        if (index >= 0) clusters.splice(index, 1);
      }
      for (const anchor of anchors) target.keys.add(anchor);
    }

    target.raws.push(raw);
    for (const key of target.keys) keyToCluster.set(key, target);
  }

  const subjects: Subject[] = [];
  const singleSourceKeys: string[] = [];

  for (const cluster of clusters) {
    const raws = cluster.raws;
    const fieldSources: Record<string, SourceId> = {};

    const sources = [...new Set(raws.map((r) => r.source))];
    const key = primaryKey(cluster);
    if (sources.length === 1) singleSourceKeys.push(key);

    const subject: Subject = {
      key,
      bgmId: pickField(raws, 'bgmId', fieldSources),
      anilistId: pickField(raws, 'anilistId', fieldSources),
      malId: pickField(raws, 'malId', fieldSources),
      biliSeasonId: pickField(raws, 'biliSeasonId', fieldSources),

      titleCn: pickField(raws, 'titleCn', fieldSources),
      titleOriginal: pickField(raws, 'titleOriginal', fieldSources),
      titleEn: pickField(raws, 'titleEn', fieldSources),
      aliases: collectAliases(raws),
      // 融合出来的中文名一定来自官方/人工数据源，所以恒为 official。
      // 机翻名不走这条路径 —— 它由 db.ts 的 applyMachineTitle 单独写入（见 D8）。
      titleCnSource: 'official',

      coverUrl: pickField(raws, 'coverUrl', fieldSources),
      synopsis: pickField(raws, 'synopsis', fieldSources),
      mediaType: pickField(raws, 'mediaType', fieldSources) ?? 'UNKNOWN',
      totalEps: pickField(raws, 'totalEps', fieldSources),
      durationMin: pickField(raws, 'durationMin', fieldSources),
      studios: pickField(raws, 'studios', fieldSources) ?? [],
      genres: pickField(raws, 'genres', fieldSources) ?? [],
      status: pickField(raws, 'status', fieldSources) ?? 'unknown',

      firstAirAtUtc: pickField(raws, 'firstAirAtUtc', fieldSources),
      broadcastWeekdayJst: pickField(raws, 'broadcastWeekdayJst', fieldSources),
      broadcastTimeJst: pickField(raws, 'broadcastTimeJst', fieldSources),
      season: pickField(raws, 'season', fieldSources),

      platforms: mergePlatforms(raws),
      episodes: mergeEpisodes(raws),
      sources,
      fieldSources,
      mergedFrom: raws.length,
    };

    subjects.push(subject);
  }

  // 标题缺失的条目直接丢弃（多半是解析失败的脏数据）
  const usable = subjects.filter((s) => Boolean(s.titleCn || s.titleOriginal || s.titleEn));

  return {
    subjects: usable,
    mergedAway: all.length - usable.length,
    singleSourceKeys,
  };
}
