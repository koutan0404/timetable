import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, jwtVerify } from 'jose';

type Bindings = {
  FOLLOW_DB: D1Database;
  TIMETABLE_DB: D1Database;
  JWKS_URL: string;
  FIREBASE_PROJECT_ID: string;
};

type AuthedCtx = {
  uid: string;
};

const router = new Hono<{ Bindings: Bindings; Variables: AuthedCtx }>();

// --- schema helpers ---
async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const rs = await db.prepare(`PRAGMA table_info(${table})`).all();
  const rows = (rs.results ?? []) as Array<any>;
  return rows.some((r) => (r as any).name === column);
}

async function ensureTimetableSchema(c: any) {
  const db = dbTimetable(c);
  
  // 設定テーブル
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS timetable_settings (
      user_id TEXT PRIMARY KEY,
      is_public INTEGER NOT NULL DEFAULT 1,
      allow_copy INTEGER NOT NULL DEFAULT 0,
      allow_followers INTEGER NOT NULL DEFAULT 1,
      custom_colors TEXT,
      current_year INTEGER,
      current_semester INTEGER,
      current_sub_term INTEGER,
      is_term_mode INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )
  `).run();

  // エントリーテーブル（年度・学期・サブタームを削除し、最新のみ保持）
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS timetable_entries_latest (
      user_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      period INTEGER NOT NULL,
      course_code TEXT,
      course_name TEXT,
      instructor TEXT,
      updated_at INTEGER,
      PRIMARY KEY(user_id, day, period)
    )
  `).run();

  // 旧テーブルからのマイグレーション（必要に応じて）
  const oldTableExists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'timetable_entries' LIMIT 1`)
    .first();
    
  if (oldTableExists) {
    console.log('[migration] Migrating from old timetable_entries to timetable_entries_latest');
    // 最新の学期データのみを移行
    await db.prepare(`
      INSERT OR IGNORE INTO timetable_entries_latest (user_id, day, period, course_code, course_name, instructor, updated_at)
      SELECT DISTINCT user_id, day, period, course_code, course_name, instructor, updated_at
      FROM timetable_entries
      WHERE (user_id, year, semester, sub_term, updated_at) IN (
        SELECT user_id, year, semester, sub_term, MAX(updated_at)
        FROM timetable_entries
        GROUP BY user_id
      )
    `).run();
  }
}

router.use('/timetables/*', async (c, next) => { 
  await ensureTimetableSchema(c); 
  return next(); 
});

router.get('/timetables/__ping', (c) => c.json({ ok: true }));

// DB resolvers
function dbTimetable(c: any) {
  return (c.env as any).TIMETABLE_DB ?? (c.env as any).FOLLOW_DB;
}

function dbSocial(c: any) {
  return (c.env as any).FOLLOW_DB ?? (c.env as any).TIMETABLE_DB;
}

// JWT認証
const auth = async (c: any, next: any) => {
  const authz = c.req.header('Authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) throw new HTTPException(401, { message: 'Missing token' });

  const JWKS = createRemoteJWKSet(new URL(c.env.JWKS_URL));
  const iss = `https://securetoken.google.com/${c.env.FIREBASE_PROJECT_ID}`;
  const aud = c.env.FIREBASE_PROJECT_ID;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: iss,
      audience: aud,
    });
    const uid = (payload as any).user_id || (payload as any).sub;
    if (!uid) throw new Error('No uid in token');
    c.set('uid', uid);
    await next();
  } catch (e) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }
};

// day変換ユーティリティ
const dayKeyToNum = (k: string | number): number => {
  if (typeof k === 'number') return k;
  const map: Record<string, number> = { m:1, t:2, w:3, r:4, f:5 };
  const key = k.toString().toLowerCase();
  if (map[key] != null) return map[key];
  const num = parseInt(key, 10);
  if (!isNaN(num) && num >= 1 && num <= 5) return num;
  throw new HTTPException(400, { message: `bad day: ${k}` });
};

const dayNumToKey = (n: number) => {
  const map = ['','m','t','w','r','f'];
  if (n < 1 || n > 5) throw new HTTPException(500, { message: `bad day num: ${n}` });
  return map[n];
};

// UID解決
async function resolveUid(c: any, userParam: string): Promise<string> {
  if (!userParam) return userParam;
  const q = userParam.startsWith('@') ? userParam.slice(1) : userParam;
  try {
    const row = (await dbSocial(c)
      .prepare('SELECT id FROM users WHERE id = ?1 OR LOWER(user_id) = LOWER(?1) LIMIT 1')
      .bind(q)
      .first()) as { id?: string } | null;
    return row?.id ?? q;
  } catch {
    return q;
  }
}

// フォロー関係確認
async function isFollower(c: any, viewerId: string, ownerId: string): Promise<boolean> {
  if (!viewerId || !ownerId) return false;
  const row = await dbSocial(c)
    .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND state='active' LIMIT 1")
    .bind(viewerId, ownerId)
    .first();
  return !!row;
}

// ────────────────────────────────────────
// GET /timetables/:userId
// 最新の時間割を取得（年度・学期情報は設定から参照）
// ────────────────────────────────────────
router.get('/timetables/:userId', async (c) => {
  const url = new URL(c.req.url);
  const userParam = c.req.param('userId');
  const ownerUid = await resolveUid(c, userParam);
  
  // クエリパラメータは互換性のため受け取るが使用しない
  const year = Number(url.searchParams.get('year') ?? '2025');
  const semester = Number(url.searchParams.get('semester') ?? '1');
  const subTerm = Number(url.searchParams.get('subTerm') ?? '0');

  let viewer: string | null = null;

  // 設定取得
  const tdb = dbTimetable(c);
  const settingsRow = await tdb
    .prepare(`SELECT is_public, allow_copy, allow_followers, custom_colors, 
              current_year, current_semester, current_sub_term, is_term_mode 
              FROM timetable_settings WHERE user_id = ?`)
    .bind(ownerUid)
    .first() as any;

  const isPublic = settingsRow?.is_public === 1;
  const allowCopy = settingsRow?.allow_copy === 1;
  const allowFollowers = settingsRow?.allow_followers === 1;
  const customColors = settingsRow?.custom_colors ? JSON.parse(settingsRow.custom_colors) : null;
  
  // 現在の学期情報（表示用）
  const currentYear = settingsRow?.current_year ?? year;
  const currentSemester = settingsRow?.current_semester ?? semester;
  const currentSubTerm = settingsRow?.current_sub_term ?? subTerm;
  const isTermMode = settingsRow?.is_term_mode === 1;

  // アクセス権限チェック
  if (!isPublic) {
    try {
      await auth(c, async () => {});
    } catch {
      throw new HTTPException(403, { message: 'Timetable is private' });
    }
    viewer = c.get('uid');
    if (viewer !== ownerUid) {
      if (!allowFollowers) {
        throw new HTTPException(403, { message: 'Timetable is private' });
      }
      const okFollower = await isFollower(c, viewer, ownerUid);
      if (!okFollower) {
        throw new HTTPException(403, { message: 'Timetable is private' });
      }
    }
  }

  // 最新の時間割エントリー取得
  try {
    const { results } = await dbTimetable(c)
      .prepare(
        `SELECT day, period, course_code, course_name, instructor
         FROM timetable_entries_latest
         WHERE user_id = ? 
         ORDER BY day, period`
      )
      .bind(ownerUid)
      .all();

    const rows = (results ?? []) as Array<{ 
      day: number; 
      period: number; 
      course_code: string | null; 
      course_name: string | null; 
      instructor: string | null;
    }>;
    
    const entries = rows.map((r) => ({
      // 互換性のため学期情報を含める
      year: currentYear,
      semester: currentSemester,
      sub_term: currentSubTerm,
      subTerm: currentSubTerm,
      
      // 基本情報
      day: dayNumToKey(r.day),
      dayNum: r.day,
      period: r.period,
      
      // コース情報（両形式で提供）
      course_code: r.course_code ?? '',
      courseCode: r.course_code ?? '',
      course_name: r.course_name ?? '',
      courseName: r.course_name ?? '',
      instructor: r.instructor ?? '',
    }));

    return c.json({
      entries,
      items: entries,
      settings: {
        is_public: isPublic,
        allow_copy: allowCopy,
        allow_followers: allowFollowers,
        custom_colors: customColors,
        current_year: currentYear,
        current_semester: currentSemester,
        current_sub_term: currentSubTerm,
        is_term_mode: isTermMode,
      },
    });
  } catch (e) {
    console.error('[GET /timetables/:userId] Error fetching entries:', e);
    
    // エラー時は空の配列を返す（エラーを投げない）
    return c.json({
      entries: [],
      items: [],
      settings: {
        is_public: isPublic,
        allow_copy: allowCopy,
        allow_followers: allowFollowers,
        custom_colors: customColors,
        current_year: currentYear,
        current_semester: currentSemester,
        current_sub_term: currentSubTerm,
        is_term_mode: isTermMode,
      },
    });
  }
});

// ────────────────────────────────────────
// PUT /timetables/sync （認証必須）
// 完全同期：現在の時間割を完全に置き換える
// ────────────────────────────────────────
router.put('/timetables/sync', auth, async (c) => {
  const uid = c.get('uid');
  const body = await c.req.json<{ 
    year?: number;
    semester?: number;
    subTerm?: number;
    sub_term?: number;
    isTermMode?: boolean;
    entries: any[] 
  }>();
  
  // 学期情報（設定保存用）
  const year = Number(body.year ?? 2025);
  const semester = Number(body.semester ?? 1);
  const subTerm = Number(body.subTerm ?? body.sub_term ?? 0);
  const isTermMode = body.isTermMode ?? false;
  
  const entries = body?.entries ?? [];
  
  if (!Array.isArray(entries)) {
    throw new HTTPException(400, { message: 'entries must be an array' });
  }

  const tdb = dbTimetable(c);
  
  console.log('[PUT /timetables/sync] Full sync for:', { uid, entriesCount: entries.length });
  
  try {
    // 1. 既存の全エントリーを削除
    await tdb.prepare(
      `DELETE FROM timetable_entries_latest WHERE user_id = ?`
    ).bind(uid).run();
    
    console.log('[PUT /timetables/sync] Deleted all existing entries');
    
    // 2. 新しいエントリーを挿入
    if (entries.length > 0) {
      const stmts = entries.map((e) => {
        const dayValue = e.day ?? e.dayNum;
        let day: number;
        try {
          day = dayKeyToNum(dayValue);
        } catch (err) {
          console.error('[PUT /timetables/sync] Invalid day value:', dayValue);
          throw err;
        }
        
        const period = Number(e.period);
        const courseCode = e.courseCode ?? e.course_code ?? null;
        const courseName = e.courseName ?? e.course_name ?? null;
        const instructor = e.instructor ?? null;

        return tdb
          .prepare(
            `INSERT INTO timetable_entries_latest (user_id, day, period, course_code, course_name, instructor, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))`
          )
          .bind(uid, day, period, courseCode, courseName, instructor);
      });

      const results = await tdb.batch(stmts);
      console.log('[PUT /timetables/sync] Inserted new entries:', results.length);
    }
    
    // 3. 現在の学期情報を設定に保存
    const settingsExist = await tdb
      .prepare('SELECT user_id FROM timetable_settings WHERE user_id = ?')
      .bind(uid)
      .first();

    if (!settingsExist) {
      await tdb.prepare(
        `INSERT INTO timetable_settings (user_id, current_year, current_semester, current_sub_term, is_term_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`
      ).bind(uid, year, semester, subTerm, isTermMode ? 1 : 0).run();
    } else {
      await tdb.prepare(
        `UPDATE timetable_settings 
         SET current_year = ?, current_semester = ?, current_sub_term = ?, is_term_mode = ?, updated_at = strftime('%s','now')
         WHERE user_id = ?`
      ).bind(year, semester, subTerm, isTermMode ? 1 : 0, uid).run();
    }
    
    return c.json({ 
      success: true, 
      message: `Synced ${entries.length} entries as latest timetable`
    });
    
  } catch (err) {
    console.error('[PUT /timetables/sync] Sync failed:', err);
    throw new HTTPException(500, { message: 'Sync failed' });
  }
});

// ────────────────────────────────────────
// PUT /timetables/settings （認証必須）
// ────────────────────────────────────────
router.put('/timetables/settings', auth, async (c) => {
  const uid = c.get('uid');
  const b = await c.req.json();
  
  const isPublic = typeof b.isPublic === 'boolean' ? (b.isPublic ? 1 : 0) : null;
  const allowCopy = typeof b.allowCopy === 'boolean' ? (b.allowCopy ? 1 : 0) : null;
  const allowFollowers = typeof b.allowFollowers === 'boolean' ? (b.allowFollowers ? 1 : 0) : null;
  
  let customColors: string | null = null;
  if (b.customColors !== undefined) {
    if (b.customColors === null) {
      customColors = null;
    } else if (typeof b.customColors === 'string') {
      customColors = b.customColors;
    } else if (typeof b.customColors === 'object') {
      customColors = JSON.stringify(b.customColors);
    }
  }
  
  const tdb = dbTimetable(c);
  const exist = await tdb
    .prepare('SELECT user_id FROM timetable_settings WHERE user_id = ?')
    .bind(uid)
    .first();

  if (!exist) {
    await tdb
      .prepare(`INSERT INTO timetable_settings (user_id, is_public, allow_copy, allow_followers, custom_colors, updated_at)
                VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`)
      .bind(uid, isPublic ?? 1, allowCopy ?? 0, allowFollowers ?? 1, customColors)
      .run();
  } else {
    const sets: string[] = [];
    const binds: any[] = [];
    if (isPublic !== null) { sets.push('is_public = ?'); binds.push(isPublic); }
    if (allowCopy !== null) { sets.push('allow_copy = ?'); binds.push(allowCopy); }
    if (allowFollowers !== null) { sets.push('allow_followers = ?'); binds.push(allowFollowers); }
    if (customColors !== undefined) { sets.push('custom_colors = ?'); binds.push(customColors); }
    
    if (sets.length > 0) {
      sets.push("updated_at = strftime('%s','now')");
      binds.push(uid);

      await tdb
        .prepare(`UPDATE timetable_settings SET ${sets.join(', ')} WHERE user_id = ?`)
        .bind(...binds)
        .run();
    }
  }

  return c.json({ success: true });
});

// ────────────────────────────────────────
// GET /timetables/settings （認証必須）
// ────────────────────────────────────────
router.get('/timetables/settings', auth, async (c) => {
  const uid = c.get('uid');
  const tdb = dbTimetable(c);
  const row = await tdb
    .prepare(`SELECT is_public, allow_copy, allow_followers, custom_colors,
              current_year, current_semester, current_sub_term, is_term_mode
              FROM timetable_settings WHERE user_id = ?`)
    .bind(uid)
    .first() as any;
    
  return c.json({
    is_public: row?.is_public === 1,
    allow_copy: row?.allow_copy === 1,
    allow_followers: row?.allow_followers === 1,
    custom_colors: row?.custom_colors ? JSON.parse(row.custom_colors) : null,
    current_year: row?.current_year ?? 2025,
    current_semester: row?.current_semester ?? 1,
    current_sub_term: row?.current_sub_term ?? 0,
    is_term_mode: row?.is_term_mode === 1,
  });
});

export default router;