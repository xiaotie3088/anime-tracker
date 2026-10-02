/**
 * Provider 统一接口。
 *
 * 新增或替换数据源 = 新增一个文件并注册，不改动其他代码。
 * 这是应对「源站改版」的唯一有效手段：任何单一源都随时可能失效。
 */

import type { RawEpisode, RawSeasonAnime, SourceId } from '../core/types.ts';
import type { SeasonInfo } from '../core/time.ts';

export type ProviderCapability = 'season' | 'episodes' | 'search' | 'platforms';

export interface Provider {
  id: SourceId;
  label: string;
  /** 该源能为哪些能力负责 */
  capabilities: readonly ProviderCapability[];
  /** 抓取一个季度的全部番剧 */
  fetchSeason(season: SeasonInfo): Promise<RawSeasonAnime[]>;
  /** 抓取某部番的分集列表（入参为该源的内部 ID） */
  fetchEpisodes?(externalId: string): Promise<RawEpisode[]>;
  /**
   * 按关键词搜索。
   * 补番库必需：老番不属于任何当季，只能靠搜索加入。
   */
  search?(keyword: string, options?: { limit?: number }): Promise<RawSeasonAnime[]>;
}

export type ProviderRunReport = {
  provider: SourceId;
  ok: boolean;
  items: number;
  elapsedMs: number;
  error?: string;
};

/** 并发跑多个 Provider，单个失败不影响整体（返回 ok:false 并记录错误）。 */
export async function runProviders(
  providers: readonly Provider[],
  season: SeasonInfo,
): Promise<{ results: Map<SourceId, RawSeasonAnime[]>; reports: ProviderRunReport[] }> {
  const results = new Map<SourceId, RawSeasonAnime[]>();
  const reports: ProviderRunReport[] = [];

  const settled = await Promise.allSettled(
    providers
      .filter((p) => p.capabilities.includes('season'))
      .map(async (provider) => {
        const startedAt = Date.now();
        const items = await provider.fetchSeason(season);
        return { provider, items, elapsedMs: Date.now() - startedAt };
      }),
  );

  for (const [index, outcome] of settled.entries()) {
    const candidates = providers.filter((p) => p.capabilities.includes('season'));
    const provider = candidates[index];
    if (!provider) continue;

    if (outcome.status === 'fulfilled') {
      results.set(provider.id, outcome.value.items);
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
        error: String(outcome.reason),
      });
    }
  }

  return { results, reports };
}
