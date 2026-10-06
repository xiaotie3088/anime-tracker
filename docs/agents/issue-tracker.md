# Issue tracker：本地 Markdown

本仓库的 issue 与 spec 以 markdown 文件存放在 `.scratch/`。
（单人自用、本地优先的项目，刻意不使用 GitHub Issues：真实开发状态与用户数据都留在本机。）

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`
- spec：`.scratch/<feature-slug>/spec.md`
- 实现票：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，
  **一票一文件**，绝不合并成单个 tickets 文件
- 分诊状态记录在文件靠上的 `Status:` 行（角色标签串见 `triage-labels.md`）
- 讨论与对话历史追加到文件底部 `## Comments` 标题下

## 技能说「publish to the issue tracker」时

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在就创建）。

## 技能说「fetch the relevant ticket」时

读取所引用路径的文件。用户通常会直接给路径或票号。

## Wayfinding 用语（供 /wayfinder 使用）

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）
- **子票**：`.scratch/<effort>/issues/NN-<slug>.md`，正文是问题；
  `Type:` 行记 `research` / `prototype` / `grilling` / `task`，`Status:` 行记 `claimed` / `resolved`
- **阻塞**：靠上的 `Blocked by: NN, NN` 行；所列文件全部 `resolved` 才算解除
- **Frontier**：扫 `.scratch/<effort>/issues/`，取未关闭、未阻塞、未认领的，编号最小者优先
- **认领**：先写 `Status: claimed` 再动手
- **解决**：在 `## Answer` 下追加答案，置 `Status: resolved`，
  再把「要点 + 链接」回填到 `map.md` 的 Decisions-so-far

## 其他约定

- `.scratch/` 已加入 `.gitignore`，不入库；想版本化就删掉那一行
- 缺陷（bug）与增强（enhancement）走**不同**的流程：缺陷先进诊断环（先有会红的反馈）、
  增强先进需求拷问；两者不要挤在同一个上下文里做
