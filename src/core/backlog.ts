/**
 * 补番库规则。
 *
 * 单独成一个模块的原因有两条：
 *   1. 这些是**业务规则**，不是数据结构，混在 types.ts 里会被数据结构淹没。
 *   2. 本文件零运行时依赖（只做 type-only 导入），
 *      因此 src/server/db.ts 可以放心依赖它，让 `node scripts/verify.ts` 在
 *      一个包都没装的情况下也能跑起来。
 */

import type { AiringStatus, TrackCategory } from './types.ts';

/**
 * 判断一部番是否应该从「追番中」自动掉进「补番库」。
 *
 * 规则：已播完 + 有明确总集数 + 至少看了 1 集 + 没看完 + 当前未弃番。
 *
 * 不满足的三种典型情况，都是刻意的：
 *   - 一集没看（watchedEps = 0）：那是「想看」，不是「没看完」，凭这个自动搬会很烦人。
 *   - 已经看完：应该进「已看完」，不该进补番库。
 *   - 还在放送中：当季还没结束，不该动它。
 */
export function shouldArchiveToBacklog(input: {
  status: AiringStatus;
  totalEps?: number | undefined;
  watchedEps: number;
  category: TrackCategory;
}): boolean {
  if (input.category !== 'tracking') return false;
  if (input.status !== 'finished') return false;
  if (!input.totalEps || input.totalEps <= 0) return false;
  if (input.watchedEps <= 0) return false;
  return input.watchedEps < input.totalEps;
}

/**
 * 补番库剩余集数。
 * 总集数缺失时返回 undefined —— UI 应显示「集数未知」而不是显示 0，
 * 因为「不知道还剩几集」和「看完了」是完全不同的两件事。
 */
export function remainingEpisodes(totalEps?: number, watchedEps = 0): number | undefined {
  if (!totalEps || totalEps <= 0) return undefined;
  return Math.max(0, totalEps - watchedEps);
}
