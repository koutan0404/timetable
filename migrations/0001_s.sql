-- ユーザーの時間割1マス=1レコード
CREATE TABLE IF NOT EXISTS timetable_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  semester INTEGER NOT NULL,     -- 1 or 2
  sub_term INTEGER NOT NULL DEFAULT 0,  -- 0:通期 or 前後期分割時のサブ学期
  day INTEGER NOT NULL,          -- 1=月 ... 5=金（クライアント側のm,t,w,r,fに合わせるならサーバーでは1-5で持つのが楽）
  period INTEGER NOT NULL,       -- 1..5
  course_code TEXT,
  course_name TEXT,
  instructor TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  UNIQUE(user_id, year, semester, sub_term, day, period)
);

-- 各ユーザーの時間割公開設定
CREATE TABLE IF NOT EXISTS timetable_settings (
  user_id TEXT PRIMARY KEY,
  is_public INTEGER NOT NULL DEFAULT 0,     -- 0/1
  allow_copy INTEGER NOT NULL DEFAULT 0,    -- 0/1
  custom_colors TEXT,                       -- JSON 文字列（{ "COMP101": 0xFFAABBCC, ... }）
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_user_term
  ON timetable_entries(user_id, year, semester, sub_term);