import { Hono } from 'hono';
import { Context } from 'hono';
import { cors } from 'hono/cors';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { FCMNotificationHelper } from './fcm-v1-service';
import timetableRouter from './timetable';

// Utility: UUID shortcut
const uuid = () => crypto.randomUUID();

export interface Env {
  FOLLOW_DB: D1Database;
  TIMETABLE_DB: D1Database;
  JWKS_URL: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  KV?: KVNamespace;
}

interface Vars {
  sub?: string;
  user?: UserInfo;
}

interface UserInfo {
  id: string;
  user_id: string; // @username
  display_name: string;
  bio?: string;
  icon_url?: string | null;
}

type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ───────────────────────────────────────────────────────────────
// テーブル作成とマイグレーション
// ───────────────────────────────────────────────────────────────

async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const rs = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return Array.isArray(rs.results) && rs.results.some((r: any) => r.name === column);
}

async function ensureTables(db: D1Database) {
  // Users table
  const utb = await db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'users' LIMIT 1`)
    .first<{ name: string }>();
  if (!utb) {
    try {
      await db.prepare(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          user_id TEXT UNIQUE NOT NULL,
          display_name TEXT,
          bio TEXT,
          icon_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`).run();
      console.log('[schema] Created users table');
    } catch (e) {
      console.error('[schema] create users failed:', e);
    }
  }

  // Profile prefs table
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS profile_prefs (
        user_id TEXT PRIMARY KEY,
        is_public INTEGER NOT NULL DEFAULT 1
      )`).run();
  } catch (e) {
    console.error('[schema] create profile_prefs failed:', e);
  }

  // Follows table
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_id TEXT NOT NULL,
        followee_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        followed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (follower_id, followee_id)
      )`).run();
  } catch (e) {
    console.error('[schema] create follows failed:', e);
  }
  
  // Index for follows
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)`).run();
  } catch (e) {
    console.error('[schema] create index idx_follows_followee failed:', e);
  }


  // Notifications table
  const nt = await db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'notifications' LIMIT 1`)
    .first<{ name: string }>();
  if (!nt) {
    try {
      await db.prepare(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          post_id TEXT,
          is_read INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`).run();
      console.log('[schema] Created notifications table');
    } catch (e) {
      console.warn('[schema] create notifications failed:', e);
    }
  }
  
  // Index for notifications
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)`).run();
  } catch (e) {
    console.error('[schema] create index idx_notifications_user failed:', e);
  }

  // FCM tokens table
  const ut = await db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'user_tokens' LIMIT 1`)
    .first<{ name: string }>();
  if (!ut) {
    try {
      await db.prepare(`
        CREATE TABLE user_tokens (
          user_id TEXT NOT NULL,
          fcm_token TEXT NOT NULL,
          platform TEXT,
          device_id TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, fcm_token)
        )`).run();
      console.log('[schema] Created user_tokens table');
    } catch (e) {
      console.warn('[schema] create user_tokens failed:', e);
    }
  }

  // Notification settings table
  const ns = await db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'notification_settings' LIMIT 1`)
    .first<{ name: string }>();
  if (!ns) {
    try {
      await db.prepare(`
        CREATE TABLE notification_settings (
          user_id TEXT PRIMARY KEY,
          follow_enabled INTEGER NOT NULL DEFAULT 1,
          like_enabled INTEGER NOT NULL DEFAULT 1,
          reply_enabled INTEGER NOT NULL DEFAULT 1,
          mention_enabled INTEGER NOT NULL DEFAULT 1,
          direct_message_enabled INTEGER NOT NULL DEFAULT 1,
          email_enabled INTEGER NOT NULL DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`).run();
      console.log('[schema] Created notification_settings table');
    } catch (e) {
      console.warn('[schema] create notification_settings failed:', e);
    }
  }

  // マイグレーション
  try { 
    if (!(await hasColumn(db, 'users', 'bio'))) {
      await db.prepare(`ALTER TABLE users ADD COLUMN bio TEXT`).run();
    }
  } catch (e) { 
    console.error('[schema] add users.bio failed:', e); 
  }
  
  try { 
    if (!(await hasColumn(db, 'users', 'icon_url'))) {
      await db.prepare(`ALTER TABLE users ADD COLUMN icon_url TEXT`).run();
    }
  } catch (e) { 
    console.error('[schema] add users.icon_url failed:', e); 
  }
}

// CORS設定
app.use('/*', cors({
  origin: '*',
  credentials: true,
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// ヘルスチェック
app.get('/api/health', (c: AppContext) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasFollowDB: !!c.env.FOLLOW_DB,
      hasTimetableDB: !!c.env.TIMETABLE_DB,
      hasJWKS: !!c.env.JWKS_URL,
      hasProjectId: !!c.env.FIREBASE_PROJECT_ID,
      hasServiceAccount: !!c.env.FIREBASE_SERVICE_ACCOUNT,
      hasKV: !!c.env.KV,
    },
  });
});

// ルート
app.get('/', (c: AppContext) => c.text('Follow Worker is running!'));

// ───────────────────────────────────────────────────────────────

// ユーザー管理の統一関数

// ───────────────────────────────────────────────────────────────

async function ensureUserRow(db: D1Database, id: string, displayName?: string): Promise<UserInfo> {
  await ensureTables(db);
  
  // 既存のユーザーチェック
  let existing = await db.prepare(
    `SELECT id, user_id, display_name, bio, icon_url FROM users WHERE id = ?1`
  ).bind(id).first<UserInfo>();
  
  // user_idの生成
  const generateUserId = () => {
    const base = `user_${id.substring(0, 8).toLowerCase()}`;
    return base;
  };
  
  if (!existing) {
    // 新規ユーザー作成
    const newUserId = generateUserId();
    const finalDisplayName = displayName || 'User';
    
    try {
      await db.prepare(
        `INSERT INTO users (id, user_id, display_name, bio, icon_url, created_at)
         VALUES (?1, ?2, ?3, '', NULL, CURRENT_TIMESTAMP)`
      ).bind(id, newUserId, finalDisplayName).run();
      
      console.log(`[ensureUserRow] Created new user: ${id} with user_id: ${newUserId}`);
      
      return {
        id: id,
        user_id: newUserId,
        display_name: finalDisplayName,
        bio: '',
        icon_url: null
      };
    } catch (e) {
      console.error(`[ensureUserRow] Failed to create user: ${id}`, e);
      
      // UNIQUE制約違反の可能性があるので、再度取得を試みる
      existing = await db.prepare(
        `SELECT id, user_id, display_name, bio, icon_url FROM users WHERE id = ?1`
      ).bind(id).first<UserInfo>();
      
      if (existing) {
        if (!existing.user_id) {
          // user_idがNULLの場合は更新
          const newUserId = generateUserId();
          await db.prepare(
            `UPDATE users SET user_id = ?2 WHERE id = ?1`
          ).bind(id, newUserId).run();
          existing.user_id = newUserId;
        }
        return existing;
      }
      
      // それでも存在しない場合は、最小限の情報を返す
      return {
        id: id,
        user_id: generateUserId(),
        display_name: displayName || 'User',
        bio: '',
        icon_url: null
      };
    }
  } else if (!existing.user_id) {
    // user_idがNULLまたは未設定の場合は更新
    const newUserId = generateUserId();
    try {
      await db.prepare(
        `UPDATE users SET user_id = ?2 WHERE id = ?1`
      ).bind(id, newUserId).run();
      
      existing.user_id = newUserId;
      console.log(`[ensureUserRow] Updated user_id for: ${id} to ${newUserId}`);
    } catch (e) {
      console.error(`[ensureUserRow] Failed to update user_id for: ${id}`, e);
      existing.user_id = newUserId; // メモリ上では設定
    }
  }
  
  return existing;
}

// ───────────────────────────────────────────────────────────────

// Firebase JWT 検証（改善版）

// ───────────────────────────────────────────────────────────────
const requireAuth = async (c: AppContext) => {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return c.text('unauthorized', 401);

  const token = auth.slice(7);

  // KV キャッシュチェック
  if (c.env.KV) {
    const cacheKey = `auth:${token.slice(-20)}`;
    try {
      const cached = (await c.env.KV.get(cacheKey, 'json')) as { sub: string; user?: UserInfo } | null;
      if (cached?.sub && cached?.user?.user_id) {
        c.set('sub', cached.sub);
        c.set('user', cached.user);
        return null;
      }
    } catch (e) {
      console.error('Cache read error:', e);
    }
  }

  try {
    const JWKS = createRemoteJWKSet(new URL(c.env.JWKS_URL));
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${c.env.FIREBASE_PROJECT_ID}`,
      audience: c.env.FIREBASE_PROJECT_ID,
    });
    
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return c.text('invalid token', 401);
    }
    
    // ユーザー行を確実に作成し、ユーザー情報を取得
    const user = await ensureUserRow(c.env.FOLLOW_DB, payload.sub);
    
    c.set('user', user);
    c.set('sub', payload.sub);

    // キャッシュに保存
    if (c.env.KV && user.user_id) {
      const cacheKey = `auth:${token.slice(-20)}`;
      try {
        await c.env.KV.put(
          cacheKey, 
          JSON.stringify({ sub: payload.sub, user }), 
          { expirationTtl: 300 }
        );
      } catch (e) {
        console.error('Cache write error:', e);
      }
    }
    
    return null;
  } catch (error) {
    console.error('JWT verification failed:', error);
    return c.text('invalid token', 401);
  }
};

// ───────────────────────────────────────────────────────────────
// 通知ヘルパー
// ───────────────────────────────────────────────────────────────
const createNotification = async (
  db: D1Database,
  serviceAccountJson: string,
  userId: string,
  type: 'follow',
  actorId: string,
  postId?: string
): Promise<void> => {
  const notificationId = uuid();
  try {
    await db.prepare(
      `INSERT INTO notifications(id, user_id, type, actor_id, post_id)
         VALUES(?1, ?2, ?3, ?4, ?5)`
    ).bind(notificationId, userId, type, actorId, postId ?? null).run();
  } catch (e) {
    console.warn('[notify] insert notifications failed:', e);
  }

  try {
    interface ActorInfo { display_name: string }
    const actor = await db.prepare(
      `SELECT display_name FROM users WHERE id = ?1`
    ).bind(actorId).first<ActorInfo>();
    const actorName = actor?.display_name || 'ユーザー';

    const fcmHelper = new FCMNotificationHelper(db, serviceAccountJson);
    await fcmHelper.sendFollowNotification(userId, actorName, actorId);
  } catch (error) {
    console.error('Failed to send push notification:', error);
  }
};

// ───────────────────────────────────────────────────────────────
// ユーザー関連エンドポイント
// ───────────────────────────────────────────────────────────────

/* ユーザーID重複チェック */
app.get('/api/users/check-id/:userId', async (c: AppContext) => {
  const userId = (c.req.param('userId') || '').trim();
  const regex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!regex.test(userId)) return c.json({ available: false, error: 'Invalid format' }, 400);

  const db = c.env.FOLLOW_DB;
  const existing = await db.prepare(
    `SELECT id FROM users WHERE user_id = ?1`
  ).bind(userId.toLowerCase()).first();

  return c.json({ available: !existing, userId: userId.toLowerCase() });
});

/* ユーザー存在確認（常にtrueを返す） */
app.get('/api/users/exists', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  
  // requireAuthで既にユーザーが作成されているはず
  return c.json({ 
    exists: true, 
    userId: user.user_id,
    displayName: user.display_name
  });
});

/* ユーザー登録（既存ユーザーの更新） */
app.post('/api/users/register', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const db = c.env.FOLLOW_DB;
  const user = c.get('user') as UserInfo;
  const { userId, displayName } = await c.req.json<{ userId: string; displayName?: string }>();

  const regex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!userId || !regex.test(userId)) return c.json({ error: 'Invalid user ID format' }, 400);

  const normalizedUserId = userId.toLowerCase();

  // 既存チェック
  const existing = await db.prepare(
    `SELECT id FROM users WHERE user_id = ?1 AND id != ?2`
  ).bind(normalizedUserId, user.id).first();
  
  if (existing) {
    return c.json({ error: 'User ID already taken' }, 400);
  }

  // 更新
  try {
    await db.prepare(
      `UPDATE users SET user_id = ?2, display_name = ?3 WHERE id = ?1`
    ).bind(user.id, normalizedUserId, displayName || normalizedUserId).run();
    
    return c.json({ success: true, userId: normalizedUserId, displayName: displayName || normalizedUserId });
  } catch (e: any) {
    console.error('User registration update error:', e);
    return c.json({ error: 'Registration failed' }, 500);
  }
});

/* ユーザーID更新 */
app.put('/api/users/update-id', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const { userId } = await c.req.json<{ userId: string }>();

  const regex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!userId || !regex.test(userId)) return c.json({ error: 'Invalid user ID format' }, 400);

  const db = c.env.FOLLOW_DB;
  const normalizedUserId = userId.toLowerCase();

  const existing = await db.prepare(
    `SELECT id FROM users WHERE user_id = ?1 AND id != ?2`
  ).bind(normalizedUserId, user.id).first();
  
  if (existing) return c.json({ error: 'User ID already taken' }, 400);

  await db.prepare(`UPDATE users SET user_id = ?2 WHERE id = ?1`).bind(user.id, normalizedUserId).run();
  return c.json({ success: true, userId: normalizedUserId });
});

/* プロフィール設定取得 */
app.get('/api/user/settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const db = c.env.FOLLOW_DB;
  
  let following: { id: string; name?: string }[] = [];

  try {
    const followingRows = await db
      .prepare(
        `SELECT followee_id AS id,
                (SELECT display_name FROM users WHERE id = followee_id) AS name
           FROM follows
          WHERE follower_id = ?1 AND state='active'`,
      )
      .bind(user.id)
      .all<{ id: string; name: string | null }>();
    following = followingRows.results.map((r) => ({ id: r.id, name: r.name ?? undefined }));
  } catch (e) {
    console.error('[settings] following query failed:', e);
  }

  return c.json({
    isPublic: true, // 常に公開
    userId: user.user_id,
    displayName: user.display_name || '',
    bio: user.bio || '',
    iconUrl: user.icon_url || '',
    following,
  });
});

/* プロフィール設定更新 */
app.put('/api/user/settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const db = c.env.FOLLOW_DB;

  const body = await c.req.json<{ 
    isPublic?: boolean;
    userId?: string;
    displayName?: string;
    bio?: string;
    iconUrl?: string;
  }>().catch(() => null);

  if (!body) return c.text('invalid request body', 400);

  // ユーザーIDの更新
  if (body.userId !== undefined && body.userId !== user.user_id) {
    const regex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!regex.test(body.userId)) {
      return c.json({ error: 'Invalid user ID format' }, 400);
    }
    
    const normalizedUserId = body.userId.toLowerCase();
    const existing = await db.prepare(
      `SELECT id FROM users WHERE user_id = ?1 AND id != ?2`
    ).bind(normalizedUserId, user.id).first();
    
    if (existing) {
      return c.json({ error: 'User ID already taken' }, 400);
    }
    
    await db.prepare(
      `UPDATE users SET user_id = ?2 WHERE id = ?1`
    ).bind(user.id, normalizedUserId).run();
  }

  // プロフィール情報の更新
  if (body.displayName !== undefined || body.bio !== undefined || body.iconUrl !== undefined) {
    const updates: string[] = [];
    const params: any[] = [user.id];
    let paramIndex = 2;

    if (body.displayName !== undefined) {
      updates.push(`display_name = ?${paramIndex}`);
      params.push(body.displayName);
      paramIndex++;
    }
    if (body.bio !== undefined) {
      updates.push(`bio = ?${paramIndex}`);
      params.push(body.bio);
      paramIndex++;
    }
    if (body.iconUrl !== undefined) {
      updates.push(`icon_url = ?${paramIndex}`);
      params.push(body.iconUrl);
      paramIndex++;
    }

    if (updates.length > 0) {
      await db.prepare(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?1`
      ).bind(...params).run();
    }
  }

  return c.json({ ok: true });
});

/* ユーザープロフィール取得（公開情報） */
app.get('/api/users/:id', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const param = c.req.param('id');
  const me = c.get('sub') as string;
  const db = c.env.FOLLOW_DB;

  try {
    // UID / user_id どちらでも解決
    let user = await db.prepare(
      `SELECT u.id, u.user_id, u.display_name, u.bio, u.icon_url,
              1 AS is_public,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id AND state='active') as following_count,
              (SELECT COUNT(*) FROM follows WHERE followee_id = u.id AND state='active') as followers_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = u.id AND state='active') as is_following
         FROM users u
        WHERE u.id = ?2 OR u.user_id = ?2
        LIMIT 1`
    ).bind(me, param).first();

    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(user);
  } catch (e) {
    console.error('[users/:id] query failed:', e);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/* ユーザー検索 */
app.get('/api/users/search', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const me = c.get('sub') as string;
  let qRaw = (c.req.query('q') ?? '').trim();
  if (!qRaw) return c.json({ results: [] });
  if (qRaw.startsWith('@')) qRaw = qRaw.slice(1);
  const q = qRaw.toLowerCase();

  const rs = await c.env.FOLLOW_DB.prepare(
    `SELECT u.id, u.user_id, u.display_name, u.icon_url,
            CASE WHEN f.followee_id IS NOT NULL THEN 1 ELSE 0 END AS is_following
       FROM users u
       LEFT JOIN follows f
         ON f.follower_id = ?1 AND f.followee_id = u.id AND f.state='active'
      WHERE LOWER(u.user_id) LIKE ?2
      ORDER BY (LOWER(u.user_id) = ?3) DESC, u.user_id ASC
      LIMIT 50`
  ).bind(me, `%${q}%`, q).all();

  return c.json({ results: rs.results });
});

// ───────────────────────────────────────────────────────────────
// フォロー関連エンドポイント
// ───────────────────────────────────────────────────────────────

/* フォロー追加 */
app.post('/api/follow', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const follower = c.get('user') as UserInfo;
  const { id: followeeId, name } = await c.req.json<{ id: string; name?: string }>();
  
  if (!followeeId || follower.id === followeeId) {
    return c.text('invalid followee id', 400);
  }

  const db = c.env.FOLLOW_DB;
  
  // フォロー対象のユーザーの存在を確保
  await ensureUserRow(db, followeeId, name);

  try {
    await db.prepare(
      `INSERT INTO follows (follower_id, followee_id, state, followed_at)
       VALUES (?1, ?2, 'active', CURRENT_TIMESTAMP)
       ON CONFLICT(follower_id, followee_id)
       DO UPDATE SET state='active', followed_at=CURRENT_TIMESTAMP`
    ).bind(follower.id, followeeId).run();
    
    // 通知を作成
    await createNotification(db, c.env.FIREBASE_SERVICE_ACCOUNT, followeeId, 'follow', follower.id);
    
    return c.json({ 
      id: followeeId, 
      name: name,
      ok: true 
    });
  } catch (e) {
    console.error(`[follow] Failed to create follow:`, e);
    return c.json({ error: 'Failed to follow user' }, 500);
  }
});

/* フォロー解除 */
app.delete('/api/follow/:id', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const follower = c.get('user') as UserInfo;
  const followee = c.req.param('id');

  await c.env.FOLLOW_DB.prepare(
    `UPDATE follows SET state='inactive' WHERE follower_id = ?1 AND followee_id = ?2`
  ).bind(follower.id, followee).run();

  return c.json({ ok: true });
});

/* フォロー中一覧 */
app.get('/api/following', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  const rs = await c.env.FOLLOW_DB.prepare(
    `SELECT f.followee_id AS id, u.user_id, u.display_name, u.bio, u.icon_url
       FROM follows f
       JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ?1 AND f.state='active'`
  ).bind(user.id).all();

  return c.json(rs.results);
});

/* フォロワー一覧 */
app.get('/api/followers', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  const rs = await c.env.FOLLOW_DB.prepare(
    `SELECT f.follower_id AS id, u.user_id, u.display_name, u.bio, u.icon_url
       FROM follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ?1 AND f.state='active'`
  ).bind(user.id).all();

  return c.json(rs.results);
});


// ───────────────────────────────────────────────────────────────
// 通知関連エンドポイント
// ───────────────────────────────────────────────────────────────

/* FCMトークン登録 */
app.post('/api/fcm/register', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const body = await c.req.json<{ token: string; platform: 'ios' | 'android' | 'web'; deviceId?: string }>();
  
  if (!body.token || !body.platform) return c.text('Invalid request', 400);

  const db = c.env.FOLLOW_DB;

  try {
    await db.prepare(
      `INSERT INTO user_tokens (user_id, fcm_token, platform, device_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, fcm_token) 
       DO UPDATE SET 
         platform = ?3,
         device_id = ?4,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(user.id, body.token, body.platform, body.deviceId ?? null).run();
    
    return c.json({ success: true });
  } catch (e) {
    console.warn('[fcm/register] upsert failed:', e);
    return c.json({ success: true, registered: false });
  }
});

/* FCMトークン削除 */
app.delete('/api/fcm/unregister', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const { token } = await c.req.json<{ token: string }>();
  
  if (!token) return c.text('Invalid request', 400);

  await c.env.FOLLOW_DB.prepare(
    `DELETE FROM user_tokens 
     WHERE user_id = ?1 AND fcm_token = ?2`
  ).bind(user.id, token).run();

  return c.json({ success: true });
});

/* 通知設定取得 */
app.get('/api/notification-settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  const settings = await c.env.FOLLOW_DB.prepare(
    `SELECT * FROM notification_settings WHERE user_id = ?1`
  ).bind(user.id).first();

  if (!settings) {
    return c.json({
      follow_enabled: true,
      like_enabled: true,
      reply_enabled: true,
      mention_enabled: true,
      direct_message_enabled: true,
      email_enabled: false,
    });
  }

  return c.json(settings);
});

/* 通知設定更新 */
app.put('/api/notification-settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const s = await c.req.json<{
    follow_enabled?: boolean;
    like_enabled?: boolean;
    reply_enabled?: boolean;
    mention_enabled?: boolean;
    direct_message_enabled?: boolean;
    email_enabled?: boolean;
  }>();

  await c.env.FOLLOW_DB.prepare(
    `INSERT INTO notification_settings 
     (user_id, follow_enabled, like_enabled, reply_enabled, 
      mention_enabled, direct_message_enabled, email_enabled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) 
     DO UPDATE SET 
       follow_enabled = ?2,
       like_enabled = ?3,
       reply_enabled = ?4,
       mention_enabled = ?5,
       direct_message_enabled = ?6,
       email_enabled = ?7,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(
    user.id,
    s.follow_enabled ? 1 : 0,
    s.like_enabled ? 1 : 0,
    s.reply_enabled ? 1 : 0,
    s.mention_enabled ? 1 : 0,
    s.direct_message_enabled ? 1 : 0,
    s.email_enabled ? 1 : 0
  ).run();

  return c.json({ success: true });
});

/* 通知取得 */
app.get('/api/notifications', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const unreadOnly = c.req.query('unreadOnly') === 'true';
  const db = c.env.FOLLOW_DB;

  const rows = await db.prepare(
    `SELECT n.id, n.type, n.actor_id, u.display_name AS actor_name,
            u.icon_url as actor_icon_url,
            n.post_id, n.created_at, n.is_read
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ?1
        ${unreadOnly ? 'AND n.is_read = 0' : ''}
      ORDER BY n.created_at DESC
      LIMIT 50`
  ).bind(user.id).all();

  return c.json(rows.results);
});

/* 通知既読 */
app.put('/api/notifications/:id/read', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const id = c.req.param('id');
  
  await c.env.FOLLOW_DB.prepare(
    `UPDATE notifications SET is_read = 1
       WHERE id = ?1 AND user_id = ?2`
  ).bind(id, user.id).run();

  return c.json({ ok: true });
});

/* 全通知既読 */
app.put('/api/notifications/read-all', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  
  await c.env.FOLLOW_DB.prepare(
    `UPDATE notifications SET is_read = 1
       WHERE user_id = ?1 AND is_read = 0`
  ).bind(user.id).run();

  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────
// 互換性のためのエンドポイント
// ───────────────────────────────────────────────────────────────

/* 互換: プロフィール更新 */
app.put('/api/profile', async (c: AppContext) => {
  return app.fetch(
    new Request(c.req.raw.url.replace('/api/profile', '/api/user/settings'), {
      method: 'PUT',
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
    c.env,
    c.executionCtx
  );
});

/* 互換: フォロー追加（パスパラメータ版） */
app.post('/api/follow/:id', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const follower = c.get('user') as UserInfo;
  const followee = c.req.param('id');
  
  if (!followee || follower.id === followee) {
    return c.text('bad request', 400);
  }

  const db = c.env.FOLLOW_DB;
  await ensureUserRow(db, followee);

  await db.prepare(
    `INSERT INTO follows (follower_id, followee_id, state, followed_at)
     VALUES (?1, ?2, 'active', CURRENT_TIMESTAMP)
     ON CONFLICT(follower_id, followee_id)
     DO UPDATE SET state='active', followed_at=CURRENT_TIMESTAMP`
  ).bind(follower.id, followee).run();

  await createNotification(
    db,
    c.env.FIREBASE_SERVICE_ACCOUNT,
    followee,
    'follow',
    follower.id
  );

  return c.json({ success: true });
});
// index.tsに追加するエンドポイントを修正
app.get('/api/user/timetable_settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const db = c.env.TIMETABLE_DB ?? c.env.FOLLOW_DB;

  try {
    const settings = await db.prepare(
      `SELECT is_public, allow_copy, allow_followers, custom_colors 
       FROM timetable_settings 
       WHERE user_id = ?`
    ).bind(user.id).first() as {
      is_public?: number;
      allow_copy?: number;
      allow_followers?: number;
      custom_colors?: string | null;
    } | null;

    if (!settings) {
      return c.json({
        is_public: true,
        allow_copy: false,
        allow_followers: true,
        custom_colors: null
      });
    }

    // custom_colorsの安全な処理
    let customColors = null;
    if (settings.custom_colors && typeof settings.custom_colors === 'string') {
      try {
        customColors = JSON.parse(settings.custom_colors);
      } catch (e) {
        console.error('[timetable_settings] Failed to parse custom_colors:', e);
        customColors = null;
      }
    }

    return c.json({
      is_public: settings.is_public === 1,
      allow_copy: settings.allow_copy === 1,
      allow_followers: settings.allow_followers === 1,
      custom_colors: customColors
    });
  } catch (e) {
    console.error('[timetable_settings] Error:', e);
    return c.json({
      is_public: true,
      allow_copy: false,
      allow_followers: true,
      custom_colors: null
    });
  }
});

app.put('/api/user/timetable_settings', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const db = c.env.TIMETABLE_DB ?? c.env.FOLLOW_DB;
  const body = await c.req.json<{ 
    isPublic?: boolean; 
    allowCopy?: boolean;
    customColors?: any;
  }>();

  const isPublic = typeof body.isPublic === 'boolean' ? (body.isPublic ? 1 : 0) : null;
  const allowCopy = typeof body.allowCopy === 'boolean' ? (body.allowCopy ? 1 : 0) : null;
  
  // customColorsをJSON文字列に変換
  let customColorsStr: string | null = null;
  if (body.customColors !== undefined) {
    if (body.customColors === null) {
      customColorsStr = null;
    } else {
      try {
        customColorsStr = JSON.stringify(body.customColors);
      } catch (e) {
        console.error('[update_timetable_settings] Failed to stringify customColors:', e);
        customColorsStr = null;
      }
    }
  }

  try {
    // テーブル作成
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS timetable_settings (
        user_id TEXT PRIMARY KEY,
        is_public INTEGER NOT NULL DEFAULT 1,
        allow_copy INTEGER NOT NULL DEFAULT 0,
        allow_followers INTEGER NOT NULL DEFAULT 1,
        custom_colors TEXT,
        updated_at INTEGER
      )
    `).run();

    // 既存レコード確認
    const existing = await db.prepare(
      'SELECT user_id FROM timetable_settings WHERE user_id = ?'
    ).bind(user.id).first();

    if (!existing) {
      // 新規作成
      await db.prepare(
        `INSERT INTO timetable_settings (user_id, is_public, allow_copy, allow_followers, custom_colors, updated_at)
         VALUES (?, ?, ?, 1, ?, strftime('%s','now'))`
      ).bind(
        user.id, 
        isPublic ?? 1, 
        allowCopy ?? 0,
        customColorsStr
      ).run();
    } else {
      // 更新用のSQL構築
      const updates: string[] = [];
      const params: any[] = [];
      
      if (isPublic !== null) {
        updates.push('is_public = ?');
        params.push(isPublic);
      }
      if (allowCopy !== null) {
        updates.push('allow_copy = ?');
        params.push(allowCopy);
      }
      if (customColorsStr !== undefined) {
        updates.push('custom_colors = ?');
        params.push(customColorsStr);
      }
      
      if (updates.length > 0) {
        updates.push("updated_at = strftime('%s','now')");
        params.push(user.id);
        
        await db.prepare(
          `UPDATE timetable_settings SET ${updates.join(', ')} WHERE user_id = ?`
        ).bind(...params).run();
      }
    }

    return c.json({ success: true });
  } catch (e) {
    console.error('[update_timetable_settings] Error:', e);
    return c.json({ error: 'Failed to update settings' }, 500);
  }
});

// index.ts（1100行目付近に追加）
/* フォロー中一覧（互換性用エンドポイント） */
app.get('/api/follows/following', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  try {
    const rs = await c.env.FOLLOW_DB.prepare(
      `SELECT f.followee_id AS id, 
              u.user_id, 
              u.display_name, 
              u.bio, 
              u.icon_url
       FROM follows f
       JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ?1 AND f.state='active'`
    ).bind(user.id).all();

    // itemsフィールドを含む形式で返す
    return c.json({
      items: rs.results,
      count: rs.results?.length ?? 0
    });
  } catch (e) {
    console.error('[follows/following] Error:', e);
    return c.json({ items: [], count: 0 });
  }
});

/* フォロワー一覧（互換性用エンドポイント） */
app.get('/api/follows/followers', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  try {
    const rs = await c.env.FOLLOW_DB.prepare(
      `SELECT f.follower_id AS id, 
              u.user_id, 
              u.display_name, 
              u.bio, 
              u.icon_url
       FROM follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ?1 AND f.state='active'`
    ).bind(user.id).all();

    return c.json({
      items: rs.results,
      count: rs.results?.length ?? 0
    });
  } catch (e) {
    console.error('[follows/followers] Error:', e);
    return c.json({ items: [], count: 0 });
  }
});

/* 相互フォロー一覧 */
app.get('/api/follows/mutuals', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;

  try {
    // 相互フォロー = 自分がフォローしていて、かつ相手も自分をフォローしている
    const rs = await c.env.FOLLOW_DB.prepare(
      `SELECT DISTINCT u.id, 
              u.user_id, 
              u.display_name, 
              u.bio, 
              u.icon_url
       FROM follows f1
       JOIN follows f2 ON f1.followee_id = f2.follower_id 
                       AND f1.follower_id = f2.followee_id
       JOIN users u ON u.id = f1.followee_id
      WHERE f1.follower_id = ?1 
        AND f1.state = 'active' 
        AND f2.state = 'active'`
    ).bind(user.id).all();

    return c.json({
      items: rs.results,
      count: rs.results?.length ?? 0
    });
  } catch (e) {
    console.error('[follows/mutuals] Error:', e);
    return c.json({ items: [], count: 0 });
  }
});


// index.ts の 1100行目付近、既存のエンドポイントの後に追加

/* フォロワー削除 */
app.delete('/api/followers/:followerId', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const user = c.get('user') as UserInfo;
  const followerId = c.req.param('followerId');

  if (!followerId || user.id === followerId) {
    return c.text('Invalid follower id', 400);
  }

  const db = c.env.FOLLOW_DB;

  try {
    // フォロー関係を削除（follower_id と followee_id の順序に注意）
    const result = await db.prepare(
      `UPDATE follows SET state='inactive' 
       WHERE follower_id = ?1 AND followee_id = ?2`
    ).bind(followerId, user.id).run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Follow relationship not found' }, 404);
    }

    return c.json({ 
      ok: true,
      message: 'Follower removed successfully'
    });
  } catch (e) {
    console.error(`[remove-follower] Failed to remove follower:`, e);
    return c.json({ error: 'Failed to remove follower' }, 500);
  }
});

/* 特定ユーザーのフォロワー一覧取得（他人も見れる） */
app.get('/api/users/:userId/followers', async (c: AppContext) => {
  const bad = await requireAuth(c);
  if (bad) return bad;

  const userId = c.req.param('userId');
  
  const rs = await c.env.FOLLOW_DB.prepare(
    `SELECT f.follower_id AS id, u.user_id, u.display_name, u.bio, u.icon_url
       FROM follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ?1 AND f.state='active'`
  ).bind(userId).all();

  return c.json(rs.results);
});




// timetable router mount
app.route('/api', timetableRouter as any);

// エントリポイント
export default app;