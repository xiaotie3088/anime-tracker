# Triage 标签

技能内部用五个规范分诊角色说话，本文件把这些角色映射到本仓库 issue tracker 里实际使用的标签串。
本仓库使用**默认值**（标签串即角色名）。

| 技能里的角色 | 本仓库使用的标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 需要维护者评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完整描述，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不会处理 |

## 分类角色

每个已分诊的 issue 还应带**恰好一个**分类角色：

- `bug`：东西坏了
- `enhancement`：新功能或改进

## 本仓库的落地方式

本地 markdown tracker 没有原生标签，标签串写在 issue 文件靠上的 `Status:` 行，
例如 `Status: ready-for-agent`；分类角色另起一行 `Category: bug`。
状态冲突时先向维护者确认，不要自行取舍。

若以后改用其他标签串（例如 `bug:triage` 代替 `needs-triage`），
只改本文件右列，技能会按这里的映射来用现有标签，避免造出重复标签。
