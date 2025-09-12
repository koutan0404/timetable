-- ============================================
-- fix-user-fks-v2.sql (no UNION; per-table inserts)
-- ============================================

-- 1) users_backup にいる “参照されるユーザー” を users に補完（テーブルごとにEXISTSで）
INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM share_profiles sp WHERE sp.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM likes l WHERE l.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM notifications n WHERE n.actor_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM profile_prefs pp WHERE pp.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM follows f WHERE f.followee_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM user_tokens ut WHERE ut.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM notification_logs nl WHERE nl.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM push_queue pq WHERE pq.user_id = ub.id);

INSERT OR IGNORE INTO users (id, user_id, display_name, bio, icon_url, created_at)
SELECT ub.id, ub.id, ub.display_name, ub.bio, COALESCE(ub.icon_url, ub.avatar_url), ub.created_at
FROM users_backup ub
WHERE EXISTS (SELECT 1 FROM topic_subscriptions ts WHERE ts.user_id = ub.id);

-- 2) 各テーブルの FK を users(id) に付け替え

-- share_profiles
PRAGMA foreign_keys=OFF;
CREATE TABLE share_profiles_new (
  user_id    TEXT PRIMARY KEY,
  is_public  INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP,
  extra      TEXT,
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO share_profiles_new (user_id, is_public, expires_at, extra)
SELECT user_id, is_public, expires_at, extra FROM share_profiles;
DROP TABLE share_profiles;
ALTER TABLE share_profiles_new RENAME TO share_profiles;
PRAGMA foreign_keys=ON;

-- likes
PRAGMA foreign_keys=OFF;
CREATE TABLE likes_new (
  post_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  liked_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO likes_new (post_id, user_id, liked_at)
SELECT post_id, user_id, liked_at FROM likes;
DROP TABLE likes;
ALTER TABLE likes_new RENAME TO likes;
PRAGMA foreign_keys=ON;

-- notifications
PRAGMA foreign_keys=OFF;
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('follow','like','reply','mention')),
  actor_id   TEXT NOT NULL,
  post_id    TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_read    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id)  REFERENCES posts(id) ON DELETE CASCADE
);
INSERT INTO notifications_new (id, user_id, type, actor_id, post_id, created_at, is_read)
SELECT id, user_id, type, actor_id, post_id, created_at, is_read FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
PRAGMA foreign_keys=ON;

-- profile_prefs
PRAGMA foreign_keys=OFF;
CREATE TABLE profile_prefs_new (
  user_id   TEXT PRIMARY KEY,
  is_public INTEGER NOT NULL CHECK (is_public IN (0,1)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO profile_prefs_new (user_id, is_public)
SELECT user_id, is_public FROM profile_prefs;
DROP TABLE profile_prefs;
ALTER TABLE profile_prefs_new RENAME TO profile_prefs;
PRAGMA foreign_keys=ON;

-- follows
PRAGMA foreign_keys=OFF;
CREATE TABLE follows_new (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  followed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  state       TEXT NOT NULL CHECK (state IN ('active','inactive')),
  PRIMARY KEY (follower_id, followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO follows_new (follower_id, followee_id, followed_at, state)
SELECT follower_id, followee_id, followed_at, state FROM follows;
DROP TABLE follows;
ALTER TABLE follows_new RENAME TO follows;
PRAGMA foreign_keys=ON;

-- user_tokens
PRAGMA foreign_keys=OFF;
CREATE TABLE user_tokens_new (
  user_id     TEXT NOT NULL,
  fcm_token   TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_id   TEXT,
  app_version TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, fcm_token),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO user_tokens_new (user_id, fcm_token, platform, device_id, app_version, created_at, updated_at)
SELECT user_id, fcm_token, platform, device_id, app_version, created_at, updated_at FROM user_tokens;
DROP TABLE user_tokens;
ALTER TABLE user_tokens_new RENAME TO user_tokens;
PRAGMA foreign_keys=ON;

-- notification_settings
PRAGMA foreign_keys=OFF;
CREATE TABLE notification_settings_new (
  user_id TEXT PRIMARY KEY,
  follow_enabled BOOLEAN DEFAULT 1,
  like_enabled   BOOLEAN DEFAULT 1,
  reply_enabled  BOOLEAN DEFAULT 1,
  mention_enabled BOOLEAN DEFAULT 1,
  direct_message_enabled BOOLEAN DEFAULT 1,
  email_enabled  BOOLEAN DEFAULT 0,
  quiet_hours_start TIME,
  quiet_hours_end   TIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO notification_settings_new (
  user_id, follow_enabled, like_enabled, reply_enabled, mention_enabled, direct_message_enabled,
  email_enabled, quiet_hours_start, quiet_hours_end, created_at, updated_at
)
SELECT
  user_id, follow_enabled, like_enabled, reply_enabled, mention_enabled, direct_message_enabled,
  email_enabled, quiet_hours_start, quiet_hours_end, created_at, updated_at
FROM notification_settings;
DROP TABLE notification_settings;
ALTER TABLE notification_settings_new RENAME TO notification_settings;
PRAGMA foreign_keys=ON;

-- notification_logs
PRAGMA foreign_keys=OFF;
CREATE TABLE notification_logs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id TEXT,
  fcm_token TEXT,
  type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  data TEXT,
  status TEXT CHECK (status IN ('pending', 'sent', 'failed', 'invalid_token')),
  error_message TEXT,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO notification_logs_new (
  id, user_id, notification_id, fcm_token, type, title, body, data, status, error_message, sent_at, created_at
)
SELECT
  id, user_id, notification_id, fcm_token, type, title, body, data, status, error_message, sent_at, created_at
FROM notification_logs;
DROP TABLE notification_logs;
ALTER TABLE notification_logs_new RENAME TO notification_logs;
PRAGMA foreign_keys=ON;

-- push_queue
PRAGMA foreign_keys=OFF;
CREATE TABLE push_queue_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  scheduled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO push_queue_new (
  id, user_id, type, payload, priority, retry_count, max_retries, scheduled_at, processed_at, status, error_message, created_at
)
SELECT
  id, user_id, type, payload, priority, retry_count, max_retries, scheduled_at, processed_at, status, error_message, created_at
FROM push_queue;
DROP TABLE push_queue;
ALTER TABLE push_queue_new RENAME TO push_queue;
PRAGMA foreign_keys=ON;

-- topic_subscriptions
PRAGMA foreign_keys=OFF;
CREATE TABLE topic_subscriptions_new (
  user_id TEXT NOT NULL,
  topic   TEXT NOT NULL,
  subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, topic),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO topic_subscriptions_new (user_id, topic, subscribed_at)
SELECT user_id, topic, subscribed_at FROM topic_subscriptions;
DROP TABLE topic_subscriptions;
ALTER TABLE topic_subscriptions_new RENAME TO topic_subscriptions;
PRAGMA foreign_keys=ON;