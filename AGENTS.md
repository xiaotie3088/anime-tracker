# anime-tracker 项目规则

## 输出语言

回复用户、任务记录（issue-tracker）与生成的文档一律用简体中文，除非用户明确要求英文。
代码的变量名、命令、文件名保持原样；文档标题与正文用中文，但保留英文字段标识。

## 动手之前必读

`docs/交接说明-第四轮.md` 是自包含的最新交接（含全部硬约束、现状、坑与待办）。
文件名虽写「第四轮」，但内容已经合并了第五、六轮，**只要读这一份就够**。
需要更深背景时再看 `README.md`、`docs/决策记录.md`（决策记录）、`docs/sources.md`（数据源实测）。

硬约束（违反会静默出问题，详见交接文档）：

- TypeScript + Node 24 **原生直跑 `.ts`，没有构建步骤**；SQLite 用 `node:sqlite`；不引入框架/打包器。
- 代码里不能用 `enum` / `namespace` / 构造函数参数属性（tsconfig 开了 `erasableSyntaxOnly`）。
- 时间一律存 ISO8601 UTC；星期归属用 `broadcast_weekday_jst`，
  **禁止**用「UTC 转本地取星期」推算——深夜番会整体错位一天。
- 源码必须 UTF-8 无 BOM；`desktop/` 与 `scripts/` 下的启动脚本必须纯 ASCII（含注释）。
- **不要用 PowerShell 的 `Get-Content` / `Set-Content` 改源码**：PS 5.1 默认 ANSI 会毁中文，
  `-Encoding UTF8` 又会加 BOM。改源码只用编辑工具。
- 改了 `src/` 必须**重启服务**才生效；`web/` 是静态文件，刷新页面即可。
- 改样式只能用 `web/styles.css` 里的**设计令牌**，不要在组件里写死色值（主题是跟随系统的双主题）。

改动后的验收标准（四条必须全绿）：

```powershell
pnpm exec tsc --noEmit        # 0 错误
pnpm verify                   # 102 项，离线，不需要联网
pnpm verify:api               # 28 项，需先启动服务；会真实打源站与翻译接口
pnpm ui:smoke                 # 前端交互，需服务已启动
```

`data/anime.db` 里是用户真实在用的追番与进度数据，**不要为了测试去动它**。

## Agent skills

### Issue tracker

issue 与 spec 以本地 markdown 存放在 `.scratch/`，一个功能一个目录。详见 `docs/agents/issue-tracker.md`。

### Triage labels

五个分诊角色使用默认标签串，记录在 issue 文件的 `Status:` 行。详见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：仓库根一份 `GLOSSARY.md` 加 `docs/adr/`。详见 `docs/agents/domain.md`。
