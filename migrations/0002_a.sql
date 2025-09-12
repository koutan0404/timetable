-- フォロー関係
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(follower_id, followee_id)
);

-- 検索用の簡易プロフィール
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  handle TEXT UNIQUE,
  photo_url TEXT
);

-- timetable_settings に allow_followers を追加（初期は閲覧OK）
ALTER TABLE timetable_settings
  ADD COLUMN allow_followers INTEGER NOT NULL DEFAULT 1;