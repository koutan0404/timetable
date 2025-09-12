-- ===================================
-- FCM (Firebase Cloud Messaging) 機能追加
-- Date: 2024
-- Description: プッシュ通知機能のためのテーブル追加
-- ===================================

-- 1. FCMトークン管理テーブル
-- ユーザーのデバイストークンを管理
CREATE TABLE IF NOT EXISTS user_tokens (
  user_id TEXT NOT NULL,
  fcm_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_id TEXT,
  app_version TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, fcm_token),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 2. 通知設定テーブル
-- ユーザーごとの通知ON/OFF設定
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id TEXT PRIMARY KEY,
  follow_enabled BOOLEAN DEFAULT 1,
  like_enabled BOOLEAN DEFAULT 1,
  reply_enabled BOOLEAN DEFAULT 1,
  mention_enabled BOOLEAN DEFAULT 1,
  direct_message_enabled BOOLEAN DEFAULT 1,
  email_enabled BOOLEAN DEFAULT 0,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. 通知ログテーブル
-- 送信履歴とデバッグ用
CREATE TABLE IF NOT EXISTS notification_logs (
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

-- 4. プッシュ通知キューテーブル
-- バッチ処理とリトライ管理用
CREATE TABLE IF NOT EXISTS push_queue (
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

-- 5. トピック購読管理テーブル
-- グループ通知用
CREATE TABLE IF NOT EXISTS topic_subscriptions (
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, topic),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ===================================
-- インデックスの作成（パフォーマンス向上）
-- ===================================

-- user_tokens用インデックス
CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id 
  ON user_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tokens_updated_at 
  ON user_tokens(updated_at);
CREATE INDEX IF NOT EXISTS idx_user_tokens_platform 
  ON user_tokens(platform);

-- notification_logs用インデックス
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_id 
  ON notification_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_status 
  ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created_at 
  ON notification_logs(created_at);

-- push_queue用インデックス
CREATE INDEX IF NOT EXISTS idx_push_queue_status 
  ON push_queue(status);
CREATE INDEX IF NOT EXISTS idx_push_queue_scheduled_at 
  ON push_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_push_queue_priority 
  ON push_queue(priority DESC);

-- topic_subscriptions用インデックス
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_topic 
  ON topic_subscriptions(topic);