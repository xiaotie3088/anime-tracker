/**
 * 临时机翻译名的业务规则。
 *
 * 严格说这里只有「决定要不要翻」这一条规则，但它必须与 db.ts / mt.ts 分开放在 core/：
 *   - 本文件零运行时依赖（只做 type-only 导入），所以 `node scripts/verify.ts`
 *     在没装任何依赖的情况下也能验证它；
 *   - 它是**产品语义**（哪些番该翻、哪些不该翻），不是网络代码。
 *
 * 背景（用户诉求原话）：「有些番没中文译名，能否对原名机翻，加『临时机翻译名』；
 * 官方译名出来后一键更新改成官方名」。
 *
 * 所以机翻的定位是**兜底**，两条硬规则：
 *   1. 已经有官方中文名的，绝不翻（会被官方名覆盖，翻了也是白翻）；
 *   2. 翻了之后官方名一到，必须能把它换掉（这条在 db.ts 的 UPSERT 里实现）。
 */

import type { TitleCnSource } from './types.ts';

// ---------------------------------------------------------------------------
// 字符判定
// ---------------------------------------------------------------------------

/** 平假名 + 片假名（含半角片假名与长音符）。有假名 = 几乎肯定是日文。 */
const KANA_PATTERN = /[\u3041-\u309f\u30a0-\u30fa\u30fc-\u30ff\uff66-\uff9f]/;

/** 汉字（含扩展 A 区），覆盖中日双方使用的表意文字。 */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 纯拉丁：只由 ASCII 字母、数字、空白与常见标点组成。 */
const LATIN_ONLY_PATTERN = /^[\x20-\x7e\u00c0-\u024f]+$/;

export function hasKana(text: string): boolean {
  return KANA_PATTERN.test(text);
}

export function hasHan(text: string): boolean {
  return HAN_PATTERN.test(text);
}

/** 只由拉丁字母/数字/标点组成（例如 "DARK MACHINE THE ANIMATION"）。 */
export function isLatinOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return LATIN_ONLY_PATTERN.test(trimmed) && /[a-zA-Z]/.test(trimmed);
}

/** 已经是纯中文（有汉字、没有假名）—— 例如「夏日」「魔法使之夜」，直接可用。 */
export function isReadableChinese(text: string): boolean {
  return hasHan(text) && !hasKana(text);
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

export type TranslateDecision = {
  translate: boolean;
  /** 不翻的原因，直接可以展示给用户（中文） */
  reason: string;
};

/**
 * 决定一部番要不要做临时机翻。
 *
 * 调用方必须传「当前的中文名」与「titleCnSource」：
 *   - 已有 official 中文名 -> 不翻（官方名优先，翻了也会被覆盖）
 *   - 已有 machine 中文名  -> 不翻（除非 force，force 由调用方处理）
 *
 * 为什么不翻「纯拉丁」：`DARK MACHINE THE ANIMATION` 这种原名直接可读，
 * 机翻成「黑暗机器 动画」反而是**信息损失**（实测样例，见 docs/sources.md 的机翻一节）。
 *
 * 为什么翻「纯汉字无假名」以外的一切：如「魔法使いの夜」含假名，需要翻；
 * 而「夏日」不含假名、本身就是可读中文，不需要翻。
 */
export function decideMachineTranslation(input: {
  titleCn?: string | null | undefined;
  titleCnSource?: TitleCnSource | null | undefined;
  titleOriginal?: string | null | undefined;
  titleEn?: string | null | undefined;
}): TranslateDecision {
  const titleCn = (input.titleCn ?? '').trim();
  const source: TitleCnSource = input.titleCnSource ?? 'official';

  if (titleCn !== '') {
    if (source === 'official') {
      return { translate: false, reason: '已有官方中文名' };
    }
    return { translate: false, reason: '已有临时机翻名（官方名一到会自动替换）' };
  }

  const candidate = (input.titleOriginal ?? '').trim() || (input.titleEn ?? '').trim();
  if (candidate === '') {
    return { translate: false, reason: '没有可翻译的原名' };
  }

  if (isLatinOnly(candidate)) {
    return { translate: false, reason: `原名是纯拉丁字母，直接可读（${candidate}）` };
  }

  if (isReadableChinese(candidate)) {
    return { translate: false, reason: `原名本身已是可读中文（${candidate}）` };
  }

  return { translate: true, reason: '缺中文名，用原名机翻兜底' };
}

/**
 * 需要翻译的原名长度上限。
 *
 * 超过这个长度的标题（实测有 40+ 字的轻小说长标题）机翻出来的结果无法阅读，
 * 而且容易把免费接口的额度耗掉。宁可留着日文原名。
 */
export const MAX_TRANSLATE_LENGTH = 120;

export function isTranslatableLength(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TRANSLATE_LENGTH;
}
