/**
 * 结构校验辅助。
 *
 * 为什么需要单独一层：数据源改版是本项目最大的长期风险。
 * zod 的 ZodError.message 是一坨 JSON，直接抛出来在终端里完全看不出哪错了。
 * 这里把它压成「字段路径 + 人话」，并且明确指出这通常意味着源站改结构了。
 */

import type { ZodType } from 'zod';

export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(根)';
    return `${path} → ${issue.message}`;
  });

  throw new Error(
    `${label} 结构校验失败（共 ${result.error.issues.length} 处，前 ${issues.length} 处）：\n` +
      issues.map((issue) => `  - ${issue}`).join('\n') +
      `\n这通常意味着数据源改了结构。请运行 node scripts/probe-sources.ts 抓一份新快照，` +
      `对照 data/probe-*/ 里的原始响应更新对应 provider 的 schema。`,
  );
}
