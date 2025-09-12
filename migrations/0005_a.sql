/* ============================================================
0002_upgrade_existing.sql
旧テーブル → 新スキーマへ移行
============================================================ */

/* ── 保険として外部キーを一時無効化 ─── */
PRAGMA foreign_keys = OFF;

/* === follows =================================================================
   旧: id (PK) / follower_id / followee_id / state / updated_at
   新: PK(follower_id, followee_id) / followed_at / state ENUM('active','inactive')
=========================================================================== */
ALTER TABLE follows RENAME TO follows_old;

CREATE TABLE follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  followed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  state       TEXT NOT NULL CHECK (state IN ('active','inactive')),
  PRIMARY KEY (follower_id, followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO follows (follower_id, followee_id, state, followed_at)
  SELECT follower_id, followee_id,
         COALESCE(state, 'active'),
         COALESCE(updated_at, current_timestamp)
    FROM follows_old;

DROP TABLE follows_old;

/* === users ===================================================================
   旧: id / display_name
   新: +bio / +icon_url / +created_at
   → ALTER TABLE で列追加
=========================================================================== */
ALTER TABLE users ADD COLUMN bio        TEXT DEFAULT ''         /* 追加済みならエラーになるので下で無視 */;
ALTER TABLE users ADD COLUMN icon_url   TEXT;



/* ── 外部キーを再有効化 ─── */
PRAGMA foreign_keys = ON;