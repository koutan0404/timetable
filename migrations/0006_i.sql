-- postsテーブルにカウンターカラムを追加
ALTER TABLE posts ADD COLUMN like_count INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN reply_count INTEGER DEFAULT 0;

-- 既存データのカウントを更新
UPDATE posts 
SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = posts.id);

UPDATE posts 
SET reply_count = (SELECT COUNT(*) FROM posts p2 WHERE p2.reply_to_id = posts.id);