-- 新番追番日历 · 数据库结构
--
-- 分层：
--   subject / episode          —— 从数据源抓来的公开信息（可随时重建）
--   my_anime / schedule_override / change_log —— 属于你的数据（不可重建，必须备份）
--   source_record              —— 原始抓取记录，用于变更检测与离线重放
--
-- 说明：本文件由 src/server/db.ts 在启动时整体执行，语句必须幂等（IF NOT EXISTS）。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 抓取来的公开信息
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subject (
  key                     TEXT PRIMARY KEY,   -- 内部主键，优先用 bgm:<id>
  bgm_id                  INTEGER,
  anilist_id              INTEGER,
  mal_id                  INTEGER,
  bili_season_id          INTEGER,

  title_cn                TEXT,
  -- title_cn 的出处：'official'（官方/人工源）| 'machine'（临时机翻兜底）。
  -- NULL 一律视为 official —— 引入这两列之前落库的历史数据因此无需迁移（见 db.ts 的 ensureColumn）。
  title_cn_source         TEXT,
  -- 机翻生成时刻，用于 UI 提示「这是什么时候翻的」以及判断要不要重翻
  title_cn_source_at      TEXT,
  title_original          TEXT,
  title_en                TEXT,
  aliases                 TEXT NOT NULL DEFAULT '[]',   -- JSON 数组，用于搜索

  cover_url               TEXT,
  synopsis                TEXT,
  media_type              TEXT NOT NULL DEFAULT 'UNKNOWN',
  total_eps               INTEGER,
  duration_min            INTEGER,
  studios                 TEXT NOT NULL DEFAULT '[]',
  genres                  TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'unknown',

  season                  TEXT,                -- 形如 "2026-10"；补番库里的老番可能为 NULL
  first_air_at_utc        TEXT,                -- ISO8601 UTC，首播

  -- 深夜番的关键两列：放送日历归属 vs 真实钟点，二者不可混用
  broadcast_weekday_jst   INTEGER,             -- 0=周日 … 6=周六（放送日历归属）
  broadcast_time_jst      TEXT,                -- 字面时间，如 "24:30"

  platforms               TEXT NOT NULL DEFAULT '[]',
  sources                 TEXT NOT NULL DEFAULT '[]',
  field_sources           TEXT NOT NULL DEFAULT '{}',
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subject_season  ON subject(season);
CREATE INDEX IF NOT EXISTS idx_subject_status  ON subject(status);
CREATE INDEX IF NOT EXISTS idx_subject_bgm     ON subject(bgm_id);
CREATE INDEX IF NOT EXISTS idx_subject_anilist ON subject(anilist_id);

CREATE TABLE IF NOT EXISTS episode (
  subject_key            TEXT    NOT NULL REFERENCES subject(key) ON DELETE CASCADE,
  ep_number              REAL    NOT NULL,      -- REAL 以支持 5.5 话之类的特殊集
  title                  TEXT,
  title_cn               TEXT,
  air_at_utc             TEXT,                  -- 日本放送精确时刻
  pub_at_utc             TEXT,                  -- 国内平台可看时刻
  broadcast_weekday_jst  INTEGER,
  duration_min           INTEGER,
  air_source             TEXT,
  pub_source             TEXT,
  conflicting            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_key, ep_number)
);

CREATE INDEX IF NOT EXISTS idx_episode_air ON episode(air_at_utc);

-- ---------------------------------------------------------------------------
-- 属于你的数据
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS my_anime (
  subject_key          TEXT PRIMARY KEY REFERENCES subject(key) ON DELETE CASCADE,
  -- tracking=追番中 / backlog=补番库 / finished=已看完 / dropped=弃番
  category             TEXT    NOT NULL DEFAULT 'tracking',
  watched_eps          REAL    NOT NULL DEFAULT 0,
  notify_enabled       INTEGER NOT NULL DEFAULT 1,
  -- 补番库可选：把补番排进日历的星期（0=周日）；NULL 表示纯待看清单
  planned_weekday_jst  INTEGER,
  -- 补番库可选：每天看几集，用于生成「今日补番任务」
  planned_eps_per_day  REAL,
  priority             INTEGER NOT NULL DEFAULT 100,
  note                 TEXT,
  added_at             TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_my_anime_category ON my_anime(category);

-- 手动修正的时间：优先级最高，任何自动同步都不得覆盖
CREATE TABLE IF NOT EXISTS schedule_override (
  subject_key TEXT    NOT NULL,
  ep_number   REAL    NOT NULL,
  air_at_utc  TEXT,
  pub_at_utc  TEXT,
  reason      TEXT,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (subject_key, ep_number)
);

-- 变更历史：延期 / 改档 / 集数调整的检测结果，用于「延期提醒」
CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_key TEXT    NOT NULL,
  ep_number   REAL,
  -- 发生变化的字段：airAtUtc / episodeAdded / totalEps
  field       TEXT    NOT NULL,
  -- 变更种类：delayed / advanced / episode-added / episode-removed / total-eps-changed
  -- （已存在的库由 db.ts 的 ensureColumn 自动补上这一列）
  kind        TEXT,
  old_value   TEXT,
  new_value   TEXT,
  detected_at TEXT    NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_change_log_time ON change_log(detected_at);

-- ---------------------------------------------------------------------------
-- 抓取记录
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  url           TEXT,
  fetched_at    TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  payload_path  TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_source_record_lookup ON source_record(source, kind, fetched_at);

-- ---------------------------------------------------------------------------
-- 每次同步的运行记录
-- ---------------------------------------------------------------------------

-- 为什么需要它（.scratch/duplicate-subjects/issues/01-票A）：
--   「同一部番两条记录」这条 bug 排查时**无法判定**重复是"同一次更新的当季 pass +
--   回填 pass"造成的，还是"点了两次更新"造成的 —— 因为跨运行完全没有留痕：
--   source_record 表 0 行（代码里根本没有任何地方写它），launcher.log 只记浏览器与服务启动。
--   修好身份判定之后，"新增不再分叉"也需要一张账才能自证。
--
-- 这是**运行记录，不是缓存**：只追加、不参与抓取判断，可以随时清空（见 clearFetchedData）。
CREATE TABLE IF NOT EXISTS sync_run (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT,
  -- 'cli' | 'web' | 'test'：谁触发的
  trigger           TEXT,
  -- 'season' | 'archive-season'：这一行是当季抓取还是回填某一季
  scope             TEXT,
  -- 本次抓取的季度列表（JSON 数组）
  seasons           TEXT    NOT NULL DEFAULT '[]',
  -- 每个源的成败与条数（JSON 数组，与 sync.ts 的 ProviderReport 同构）
  providers         TEXT    NOT NULL DEFAULT '[]',
  written           INTEGER NOT NULL DEFAULT 0,
  episodes          INTEGER NOT NULL DEFAULT 0,
  merged_away       INTEGER NOT NULL DEFAULT 0,
  identity_absorbed INTEGER NOT NULL DEFAULT 0,
  identity_skipped  INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  -- 这一行属于哪次「一键更新」（回填的每一季都挂到同一次更新下）。
  -- 已存在的库由 db.ts 的 ensureColumn 自动补上这一列。
  parent_run_id     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_run_time ON sync_run(started_at);
