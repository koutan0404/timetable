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
  uid: string; // Firebase UID など
};

const router = new Hono<{ Bindings: Bindings; Variables: AuthedCtx }>();

// --- schema helpers (auto-migration) ---
async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const rs = await db.prepare(`PRAGMA table_info(${table})`).all();
  const rows = (rs.results ?? []) as Array<any>;
  return rows.some((r) => (r as any).name === column);
}

async function ensureTimetableSchema(c: any) {
  const db = dbTimetable(c);
  // create tables if not exist
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

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS timetable_entries (
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      semester INTEGER NOT NULL,
      sub_term INTEGER NOT NULL DEFAULT 0,
      day INTEGER NOT NULL,
      period INTEGER NOT NULL,
      course_code TEXT,
      course_name TEXT,
      instructor TEXT,
      updated_at INTEGER,
      PRIMARY KEY(user_id, year, semester, sub_term, day, period)
    )
  `).run();

  // add missing columns lazily (backfill for older DBs)
  if (!(await hasColumn(db, 'timetable_settings', 'allow_copy'))) {
    await db.prepare(`ALTER TABLE timetable_settings ADD COLUMN allow_copy INTEGER NOT NULL DEFAULT 0`).run();
  }
  if (!(await hasColumn(db, 'timetable_settings', 'allow_followers'))) {
    await db.prepare(`ALTER TABLE timetable_settings ADD COLUMN allow_followers INTEGER NOT NULL DEFAULT 1`).run();
  }
  if (!(await hasColumn(db, 'timetable_settings', 'custom_colors'))) {
    await db.prepare(`ALTER TABLE timetable_settings ADD COLUMN custom_colors TEXT`).run();
  }
  if (!(await hasColumn(db, 'timetable_settings', 'updated_at'))) {
    await db.prepare(`ALTER TABLE timetable_settings ADD COLUMN updated_at INTEGER`).run();
  }

  // PUBLICATION INDEX: which terms are published and which is pinned as latest
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS timetable_published_terms (
      user_id    TEXT NOT NULL,
      year       INTEGER NOT NULL,
      semester   INTEGER NOT NULL,
      sub_term   INTEGER NOT NULL DEFAULT 0,
      is_latest  INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, year, semester, sub_term)
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_published_user_latest
      ON timetable_published_terms(user_id, is_latest, published_at DESC)
  `).run();
}

// ensure schema for all timetable endpoints
router.use('/timetables/*', async (c, next) => { await ensureTimetableSchema(c); return next(); });

// Ping first (must be before ":userId" route)
router.get('/timetables/__ping', (c) => c.json({ ok: true }));

// DB resolvers
function dbTimetable(c: any) {
  return (c.env as any).TIMETABLE_DB ?? (c.env as any).FOLLOW_DB;
}
function dbSocial(c: any) {
  return (c.env as any).FOLLOW_DB ?? (c.env as any).TIMETABLE_DB;
}

// ────────────────────────────────────────
// JWT 検証（Authorization: Bearer <token>）
// ────────────────────────────────────────
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
    // Firebase: uid は payload.user_id or sub に入る
    const uid = (payload as any).user_id || (payload as any).sub;
    if (!uid) throw new Error('No uid in token');
    c.set('uid', uid);
    await next();
  } catch (e) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }
};

// ────────────────────────────────────────
// ユーティリティ：day 変換
// ────────────────────────────────────────
const dayKeyToNum = (k: string | number): number => {
  // 数値が直接渡された場合はそのまま返す
  if (typeof k === 'number') return k;
  
  const map: Record<string, number> = { m:1, t:2, w:3, r:4, f:5 };
  const key = k.toString().toLowerCase();
  
  if (map[key] != null) return map[key];
  
  // 数値文字列の場合
  const num = parseInt(key, 10);
  if (!isNaN(num) && num >= 1 && num <= 5) return num;
  
  throw new HTTPException(400, { message: `bad day: ${k}` });
};

const dayNumToKey = (n: number) => {
  const map = ['','m','t','w','r','f'];
  if (n < 1 || n > 5) throw new HTTPException(500, { message: `bad day num: ${n}` });
  return map[n];
};

// ────────────────────────────────────────
// helper: userId (path) → UID 解決（users.id または users.user_id を許容）
// ────────────────────────────────────────
async function resolveUid(c: any, userParam: string): Promise<string> {
  if (!userParam) return userParam;
  // 先頭の @ を許容し、user_id は大文字小文字を無視して照合
  const q = userParam.startsWith('@') ? userParam.slice(1) : userParam;
  try {
    const row = (await dbSocial(c)
      .prepare('SELECT id FROM users WHERE id = ?1 OR LOWER(user_id) = LOWER(?1) LIMIT 1')
      .bind(q)
      .first()) as { id?: string } | null;
    return row?.id ?? q; // 見つからなければそのまま（既にUIDの可能性）
  } catch {
    return q;
  }
}

// ────────────────────────────────────────
// helper: フォロー関係の確認
// ────────────────────────────────────────
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
// クエリ: year, semester, subTerm
// レスポンス: { entries: [...], settings: {...} }
// ────────────────────────────────────────

router.get('/timetables/:userId', async (c) => {
  const url = new URL(c.req.url);
  const debugMode = url.searchParams.get('debug') === '1' || c.req.header('x-debug') === '1';

  const userParam = c.req.param('userId');
  const ownerUid = await resolveUid(c, userParam);

  // Parse query, but do not default; we'll resolve from publication index if unspecified
  const qYear = url.searchParams.get('year');
  const qSem  = url.searchParams.get('semester') ?? url.searchParams.get('term');
  const qSub  = url.searchParams.get('subTerm') ?? url.searchParams.get('sub_term') ?? url.searchParams.get('subterm');

  let year     = qYear != null ? Number(qYear) : NaN;
  let semester = qSem  != null ? Number(qSem)  : NaN;
  let subTerm  = qSub  != null ? Number(qSub)  : NaN;

  let viewer: string | null = null;
  if (debugMode) {
    try { await auth(c, async () => {}); viewer = c.get('uid'); } catch {}
  }

  // 設定取得（allow_followers が無い古いDBも許容）
  const tdb = dbTimetable(c);
  let settingsRow: any = null;
  let hasAllowFollowersCol = true;
  try {
    settingsRow = await tdb
      .prepare('SELECT is_public, allow_copy, allow_followers, custom_colors FROM timetable_settings WHERE user_id = ?')
      .bind(ownerUid)
      .first();
  } catch (e: any) {
    const msg = String(e || '');
    if (msg.includes('no such column: allow_followers')) {
      hasAllowFollowersCol = false;
      settingsRow = await tdb
        .prepare('SELECT is_public, allow_copy, custom_colors FROM timetable_settings WHERE user_id = ?')
        .bind(ownerUid)
        .first();
    } else {
      throw e;
    }
  }

  const isPublic = settingsRow?.is_public === 1;
  const allowCopy = settingsRow?.allow_copy === 1;
  const allowFollowers = hasAllowFollowersCol ? settingsRow?.allow_followers === 1 : false; // 古いDBでは既定 false
  const customColors = settingsRow?.custom_colors ? JSON.parse(settingsRow.custom_colors) : null;

  // 非公開のときは、本人 or (フォロワー & allow_followers=1) のみ許可
  let okFollower: boolean | null = null;
  if (!isPublic) {
    try { await auth(c, async () => {}); } catch { throw new HTTPException(403, { message: 'Timetable is private' }); }
    const uid = c.get('uid');
    if (uid !== ownerUid) {
      if (!allowFollowers) throw new HTTPException(403, { message: 'Timetable is private' });
      okFollower = await isFollower(c, uid, ownerUid);
      if (!okFollower) throw new HTTPException(403, { message: 'Timetable is private' });
    }
  }

// Resolve term if unspecified from publication index
const noTermSpecified = Number.isNaN(year) || Number.isNaN(semester) || Number.isNaN(subTerm);
if (noTermSpecified) {
  let row = await tdb.prepare(
    `SELECT year, semester, sub_term FROM timetable_published_terms
      WHERE user_id=? AND is_latest=1
      ORDER BY published_at DESC LIMIT 1`
  ).bind(ownerUid).first() as { year: number; semester: number; sub_term: number } | null;

  if (!row) {
    row = await tdb.prepare(
      `SELECT year, semester, sub_term FROM timetable_published_terms
         WHERE user_id=?
         ORDER BY published_at DESC LIMIT 1`
    ).bind(ownerUid).first() as { year: number; semester: number; sub_term: number } | null;
  }

  if (row) {
    year = row.year; semester = row.semester; subTerm = row.sub_term;
  } else {
    return c.json({
      entries: [], items: [],
      settings: { is_public: isPublic ? 1 : 0, allow_copy: allowCopy ? 1 : 0, allow_followers: allowFollowers ? 1 : 0, custom_colors: customColors },
      available_terms: [],
      meta: { selected: null }
    });
  }
}

  // Fetch entries
  const { results } = await dbTimetable(c)
    .prepare(
      `SELECT day, period, course_code, course_name, instructor, sub_term
         FROM timetable_entries
        WHERE user_id = ? AND year = ? AND semester = ? AND sub_term = ?
        ORDER BY day, period`
    )
    .bind(ownerUid, year, semester, subTerm)
    .all();

  const rows = (results ?? []) as Array<{ 
    day: number; 
    period: number; 
    course_code: string | null; 
    course_name: string | null; 
    instructor: string | null; 
    sub_term: number 
  }>;

  const entries = rows.map((r) => ({
    // 基本フィールド（後方互換も付与）
    sub_term: r.sub_term ?? 0,
    subTerm: r.sub_term ?? 0,
    day: dayNumToKey(r.day),
    dayNum: r.day,
    period: r.period,
    course_code: r.course_code ?? '',
    courseCode: r.course_code ?? '',
    course_name: r.course_name ?? '',
    courseName: r.course_name ?? '',
    instructor: r.instructor ?? ''
  }));

  // 公開学期一覧
  const { results: termRows = [] } = await tdb.prepare(
    `SELECT year, semester, sub_term AS subTerm,
            CASE WHEN is_latest=1 THEN 1 ELSE 0 END AS isLatest,
            published_at AS publishedAt
       FROM timetable_published_terms
      WHERE user_id = ?
      ORDER BY is_latest DESC, published_at DESC`
  ).bind(ownerUid).all();

  return c.json({
    entries, items: entries,
    settings: { is_public: isPublic ? 1 : 0, allow_copy: allowCopy ? 1 : 0, allow_followers: allowFollowers ? 1 : 0, custom_colors: customColors },
    available_terms: termRows,
    meta: { selected: { year, semester, subTerm } }
  });
});


// ────────────────────────────────────────
// PUT /timetables/sync   （認証必須）
// 完全同期エンドポイント：指定された学期のデータを完全に置き換える
// ボディ: { year, semester, subTerm, entries: [...] }
// ────────────────────────────────────────
router.put('/timetables/sync', auth, async (c) => {
  const uid = c.get('uid');
  const body = await c.req.json<{ 
    year: number;
    semester: number;
    subTerm?: number;
    sub_term?: number;
    entries: any[] 
  }>();
  
  const year = Number(body.year);
  const semester = Number(body.semester);
  const subTerm = Number(body.subTerm ?? body.sub_term ?? 0);
  const entries = body?.entries ?? [];
  
  if (!Array.isArray(entries)) {
    throw new HTTPException(400, { message: 'entries must be an array' });
  }

  const tdb = dbTimetable(c);
  
  console.log('[PUT /timetables/sync] Full sync for:', { uid, year, semester, subTerm });
  console.log('[PUT /timetables/sync] Entries count:', entries.length);
  
  // トランザクション的に処理
  try {
    // 1. 既存のエントリーを全て削除
    await tdb.prepare(
      `DELETE FROM timetable_entries 
       WHERE user_id = ? AND year = ? AND semester = ? AND sub_term = ?`
    ).bind(uid, year, semester, subTerm).run();
    
    console.log('[PUT /timetables/sync] Deleted existing entries');
    
    // 2. 新しいエントリーを挿入（空の場合はスキップ）
    if (entries.length > 0) {
      const stmts = entries.map((e) => {
        // 両方のフィールド名に対応
        const entryYear = Number(e.year ?? year);
        const entrySemester = Number(e.semester ?? semester);
        const entrySubTerm = Number(e.subTerm ?? e.sub_term ?? subTerm);
        
        // dayが文字列または数値の両方に対応
        const dayValue = e.day ?? e.dayNum;
        let day: number;
        try {
          day = dayKeyToNum(dayValue);
        } catch (err) {
          console.error('[PUT /timetables/sync] Invalid day value:', dayValue, 'in entry:', e);
          throw err;
        }
        
        const period = Number(e.period);
        
        // 両方のフィールド名に対応
        const courseCode = e.courseCode ?? e.course_code ?? null;
        const courseName = e.courseName ?? e.course_name ?? null;
        const instructor = e.instructor ?? null;

        return tdb
          .prepare(
            `INSERT INTO timetable_entries (user_id, year, semester, sub_term, day, period, course_code, course_name, instructor, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`
          )
          .bind(uid, entryYear, entrySemester, entrySubTerm, day, period, courseCode, courseName, instructor);
      });

      const results = await tdb.batch(stmts);
      console.log('[PUT /timetables/sync] Inserted new entries:', results.length);
    }
    
    
    // Optionally set this term as latest published
    try {
      const publishLatest = (body as any)?.publishLatest ? true : false;
      if (publishLatest) {
        await tdb.prepare(`
          INSERT INTO timetable_published_terms (user_id, year, semester, sub_term, is_latest, published_at)
          VALUES (?, ?, ?, ?, 1, strftime('%s','now'))
          ON CONFLICT(user_id, year, semester, sub_term)
          DO UPDATE SET is_latest=1, published_at=excluded.published_at
        `).bind(uid, year, semester, subTerm).run();
        await tdb.prepare(`
          UPDATE timetable_published_terms
             SET is_latest=0
           WHERE user_id=? AND NOT (year=? AND semester=? AND sub_term=?)
        `).bind(uid, year, semester, subTerm).run();
      }
    } catch (e) {
      console.warn('[PUT /timetables/sync] publishLatest failed (ignored):', e);
    }

    return c.json({ 
      success: true, 
      deleted: true,
      inserted: entries.length,
      message: `Synced ${entries.length} entries for ${year}年度 学期${semester} サブターム${subTerm}`
    });
    
  } catch (err) {
    console.error('[PUT /timetables/sync] Sync failed:', err);
    throw new HTTPException(500, { message: 'Sync failed' });
  }
});

// ────────────────────────────────────────
// POST /timetables   （認証必須）
// ボディ: { entries: [{ year, semester, subTerm, day, period, courseCode, courseName, instructor }] }
// 既存と同一キー(ユーザー,年,学期,subTerm,day,period)はUPSERT
// ────────────────────────────────────────
router.post('/timetables', auth, async (c) => {
  const uid = c.get('uid');
  const body = await c.req.json<{ entries: any[] }>();
  const entries = body?.entries ?? [];
  
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new HTTPException(400, { message: 'entries required' });
  }

  const tdb = dbTimetable(c);
  
  // デバッグログ
  console.log('[POST /timetables] Received entries:', entries.length);
  console.log('[POST /timetables] First entry:', entries[0]);
  
  const stmts = entries.map((e) => {
    const year = Number(e.year);
    const semester = Number(e.semester);
    // 両方のフィールド名に対応
    const subTerm = Number(e.subTerm ?? e.sub_term ?? 0);
    
    // dayが文字列または数値の両方に対応
    const dayValue = e.day ?? e.dayNum;
    let day: number;
    try {
      day = dayKeyToNum(dayValue);
    } catch (err) {
      console.error('[POST /timetables] Invalid day value:', dayValue, 'in entry:', e);
      throw err;
    }
    
    const period = Number(e.period);
    
    // 両方のフィールド名に対応
    const courseCode = e.courseCode ?? e.course_code ?? null;
    const courseName = e.courseName ?? e.course_name ?? null;
    const instructor = e.instructor ?? null;

    console.log('[POST /timetables] Processing entry:', {
      uid, year, semester, subTerm, day, period, courseCode, courseName
    });

    return tdb
      .prepare(
        `INSERT INTO timetable_entries (user_id, year, semester, sub_term, day, period, course_code, course_name, instructor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(user_id, year, semester, sub_term, day, period) DO UPDATE SET
           course_code = excluded.course_code,
           course_name = excluded.course_name,
           instructor = excluded.instructor,
           updated_at = excluded.updated_at`
      )
      .bind(uid, year, semester, subTerm, day, period, courseCode, courseName, instructor);
  });

  try {
    const results = await tdb.batch(stmts);
    console.log('[POST /timetables] Batch update successful:', results.length);
    return c.json({ success: true, upserted: entries.length });
  } catch (err) {
    console.error('[POST /timetables] Batch update failed:', err);
    throw err;
  }
});

// ────────────────────────────────────────
// DELETE /timetables  （認証必須）
// ボディ: { year, semester, subTerm, day, period }
// ────────────────────────────────────────
router.delete('/timetables', auth, async (c) => {
  const uid = c.get('uid');
  const body = await c.req.json<{ 
    year: number; 
    semester: number; 
    subTerm?: number;
    sub_term?: number;
    day: string | number; 
    period: number;
  }>();
  
  const year = Number(body.year);
  const semester = Number(body.semester);
  const subTerm = Number(body.subTerm ?? body.sub_term ?? 0);
  
  let day: number;
  try {
    day = dayKeyToNum(body.day);
  } catch (err) {
    console.error('[DELETE /timetables] Invalid day value:', body.day);
    throw err;
  }
  
  const period = Number(body.period);

  const tdb = dbTimetable(c);
  
  console.log('[DELETE /timetables] Deleting entry:', {
    uid, year, semester, subTerm, day, period
  });
  
  await tdb.prepare(
    `DELETE FROM timetable_entries 
     WHERE user_id = ? AND year = ? AND semester = ? AND sub_term = ? AND day = ? AND period = ?`
  ).bind(uid, year, semester, subTerm, day, period).run();

  return c.json({ success: true });
});

// ────────────────────────────────────────
// PUT /timetables/settings （認証必須）
// ボディ: { isPublic?: boolean, allowCopy?: boolean, customColors?: object }
// ────────────────────────────────────────
router.put('/timetables/settings', auth, async (c) => {
  const uid = c.get('uid');
  const b = await c.req.json();
  const isPublic = typeof b.isPublic === 'boolean' ? (b.isPublic ? 1 : 0) : null;
  const allowCopy = typeof b.allowCopy === 'boolean' ? (b.allowCopy ? 1 : 0) : null;
  const allowFollowers = typeof b.allowFollowers === 'boolean' ? (b.allowFollowers ? 1 : 0) : null;
  
  // customColorsの処理を修正
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
  
  // 既存 row 有無
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

// GET /timetables/settings  （認証必須）
// 応答: { is_public, allow_copy, allow_followers, custom_colors }
router.get('/timetables/settings', auth, async (c) => {
  const uid = c.get('uid');
  const tdb = dbTimetable(c);
  const row = (await tdb
    .prepare('SELECT is_public, allow_copy, allow_followers, custom_colors FROM timetable_settings WHERE user_id = ?')
    .bind(uid)
    .first()) as { is_public?: number; allow_copy?: number; allow_followers?: number; custom_colors?: string | null } | null;
  return c.json({
    is_public: row?.is_public === 1,
    allow_copy: row?.allow_copy === 1,
    allow_followers: row?.allow_followers === 1,
    custom_colors: row?.custom_colors ? JSON.parse(row.custom_colors) : null,
  });
});

// ────────────────────────────────────────
// POST /timetables/copy/:sourceUserId （認証必須）
// ボディ: { year, semester, subTerm }
// 条件: source の is_public=1 && allow_copy=1 でないと 403
// 処理: 自分の同一学期データを削除 → source を丸ごとコピー
//      custom_colors も一緒にコピーしておくとUX良い
// ────────────────────────────────────────
router.post('/timetables/copy/:sourceUserId', auth, async (c) => {
  const sourceUserIdParam = c.req.param('sourceUserId');
  const sourceUserId = await resolveUid(c, sourceUserIdParam);
  const uid = c.get('uid');
  const b = await c.req.json();
  const year = Number(b.year);
  const semester = Number(b.semester);
  const subTerm = Number(b.subTerm ?? 0);

  // 権限確認
  const tdb = dbTimetable(c);
  const settings = (await tdb
    .prepare('SELECT is_public, allow_copy, custom_colors FROM timetable_settings WHERE user_id = ?')
    .bind(sourceUserId)
    .first()) as { is_public?: number; allow_copy?: number; custom_colors?: string | null } | null;

  if (!settings || settings.is_public !== 1 || settings.allow_copy !== 1) {
    throw new HTTPException(403, { message: 'Copy not allowed' });
  }

  // 自分の該当学期データを削除
  await tdb
    .prepare('DELETE FROM timetable_entries WHERE user_id = ? AND year = ? AND semester = ? AND sub_term = ?')
    .bind(uid, year, semester, subTerm)
    .run();

  // source の entries を取得
  const { results } = await tdb
    .prepare(
      `SELECT day, period, course_code, course_name, instructor
       FROM timetable_entries
       WHERE user_id = ? AND year = ? AND semester = ? AND sub_term = ?
       ORDER BY day, period`
    )
    .bind(sourceUserId, year, semester, subTerm)
    .all();

  const srcRows = (results ?? []) as Array<{ day: number; period: number; course_code: string | null; course_name: string | null; instructor: string | null }>;
  // バルク挿入
  const stmts = srcRows.map((r) =>
    tdb.prepare(
      `INSERT INTO timetable_entries (user_id, year, semester, sub_term, day, period, course_code, course_name, instructor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`
    ).bind(uid, year, semester, subTerm, r.day, r.period, r.course_code, r.course_name, r.instructor)
  );
  if (stmts.length) await tdb.batch(stmts);

  // custom_colors もコピー（任意）
  await tdb
    .prepare(
      `INSERT INTO timetable_settings (user_id, is_public, allow_copy, custom_colors, updated_at)
       VALUES (?, 0, 0, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET custom_colors = excluded.custom_colors, updated_at = excluded.updated_at`
    )
    .bind(uid, settings.custom_colors ?? null)
    .run();

  return c.json({ success: true, copied: stmts.length });
});



// Publish selected term (and optionally pin as latest)
router.put('/timetables/publish', auth, async (c) => {
  const uid = c.get('uid');
  const body = await c.req.json<any>();
  const year = Number(body.year);
  const semester = Number(body.semester);
  const subTerm = Number(body.subTerm ?? body.sub_term ?? 0);
  const latest = !!body.latest;

  if (!Number.isFinite(year) || !Number.isFinite(semester)) {
    throw new HTTPException(400, { message: 'year/semester required' });
  }

  const tdb = dbTimetable(c);
  await tdb.prepare(`
    INSERT INTO timetable_published_terms (user_id, year, semester, sub_term, is_latest, published_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, year, semester, sub_term)
    DO UPDATE SET published_at=excluded.published_at,
                  is_latest=CASE WHEN ?5=1 THEN 1 ELSE timetable_published_terms.is_latest END
  `).bind(uid, year, semester, subTerm, latest ? 1 : 0).run();

  if (latest) {
    await tdb.prepare(`
      UPDATE timetable_published_terms
         SET is_latest=0
       WHERE user_id=? AND NOT (year=? AND semester=? AND sub_term=?)
    `).bind(uid, year, semester, subTerm).run();
  }

  return c.json({ ok: true });
});

// List published terms for a user
router.get('/timetables/:userId/terms', async (c) => {
  const ownerUid = await resolveUid(c, c.req.param('userId'));
  const tdb = dbTimetable(c);
  const { results = [] } = await tdb.prepare(`
    SELECT year, semester, sub_term AS subTerm,
           CASE WHEN is_latest=1 THEN 1 ELSE 0 END AS isLatest,
           published_at AS publishedAt
      FROM timetable_published_terms
     WHERE user_id = ?
     ORDER BY is_latest DESC, published_at DESC
  `).bind(ownerUid).all();
  return c.json({ items: results });
});

export default router;