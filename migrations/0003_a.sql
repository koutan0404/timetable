-- users / profile_prefs / follows
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  display_name TEXT,
  bio TEXT,
  icon_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profile_prefs (
  user_id TEXT PRIMARY KEY,
  is_public INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  followed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- posts / likes / notifications / user_tokens / notification_settings
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  media_url TEXT,
  reply_to_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  post_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_tokens (
  user_id TEXT NOT NULL,
  fcm_token TEXT NOT NULL,
  platform TEXT,
  device_id TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, fcm_token)
);

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id TEXT PRIMARY KEY,
  follow_enabled INTEGER NOT NULL DEFAULT 1,
  like_enabled INTEGER NOT NULL DEFAULT 1,
  reply_enabled INTEGER NOT NULL DEFAULT 1,
  mention_enabled INTEGER NOT NULL DEFAULT 1,
  direct_message_enabled INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 互換: share_profile が「存在しない」場合のみ作成（ビュー運用ならスキップ）
-- ★ もし既に TABLE もしくは VIEW がある環境では、この2行は実行しないでください
CREATE TABLE IF NOT EXISTS share_profile (
  user_id TEXT PRIMARY KEY,
  is_public INTEGER NOT NULL DEFAULT 1
);