-- usersテーブルが存在しない場合の完全なスキーマ
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  bio TEXT,
  icon_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- profile_prefsテーブル
CREATE TABLE IF NOT EXISTS profile_prefs (
  user_id TEXT PRIMARY KEY,
  is_public INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);