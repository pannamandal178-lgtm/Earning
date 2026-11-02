'use strict';
/**
 * Daily "Complete Task" counter.
 *
 * Flow:
 *  1. The app writes taskStarts/{uid} = { startedAt: <server time> } (Firestore rules force the time to be the real server time).
 *  2. The user stays on the ad for the wait time (default 5 seconds).
 *  3. The app calls POST /task/complete (with the Firebase login token). This code checks, on the SERVER:
 *       - the start record exists and at least `waitSeconds` have really passed
 *       - the daily limit (default 7) is not reached
 *     then adds +1 to gameTasks/{uid}_{day}. Coins are NOT given here: the admin pays them the next day.
 */
const DEFAULT_LIMIT = 7;
const DEFAULT_WAIT_SECONDS = 5;
const MAX_START_AGE_MS = 30 * 60 * 1000; // a start older than 30 minutes is void
const TOLERANCE_MS = 700; // small allowance for network / clock differences

const dayString = (ms, offsetMinutes) => new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 10);

const toMs = (v) => {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const intIn = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

async function handleTaskComplete(opts) {
  const { uid, db, now = () => Date.now(), dayOffsetMinutes = 330, log = console } = opts;
  if (!uid) return { code: 401, body: { error: 'not-logged-in' } };

  try {
    const cfgSnap = await db.doc('appConfig/taskGame').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() || {} : {};
    const limit = intIn(cfg.dailyLimit, 1, 100, DEFAULT_LIMIT);
    const waitMs = intIn(cfg.waitSeconds, 1, 120, DEFAULT_WAIT_SECONDS) * 1000;

    const t0 = now();
    const today = dayString(t0, dayOffsetMinutes);
    const startRef = db.doc(`taskStarts/${uid}`);
    const countRef = db.doc(`gameTasks/${uid}_${today}`);
    const userRef = db.doc(`users/${uid}`);

    const result = await db.runTransaction(async (t) => {
      const startSnap = await t.get(startRef);
      const countSnap = await t.get(countRef);
      const userSnap = await t.get(userRef);

      if (!userSnap.exists) return { code: 403, body: { error: 'no-user' } };
      const u = userSnap.data() || {};
      if (u.banned === true) return { code: 403, body: { error: 'banned' } };

      const current = countSnap.exists ? Number((countSnap.data() || {}).count) || 0 : 0;
      if (current >= limit) return { code: 429, body: { error: 'limit', count: current, limit } };

      if (!startSnap.exists) return { code: 400, body: { error: 'no-start' } };
      const startedMs = toMs((startSnap.data() || {}).startedAt);
      if (!Number.isFinite(startedMs)) return { code: 400, body: { error: 'no-start' } };

      const age = t0 - startedMs;
      if (age < waitMs - TOLERANCE_MS) return { code: 400, body: { error: 'too-early', waitedMs: Math.max(0, age) } };
      if (age > MAX_START_AGE_MS) {
        t.delete(startRef);
        return { code: 400, body: { error: 'expired' } };
      }

      const prev = countSnap.exists ? countSnap.data() || {} : {};
      t.set(countRef, {
        uid,
        date: today,
        count: current + 1,
        name: String(u.name || u.nickname || '').slice(0, 80),
        email: String(u.email || '').slice(0, 120),
        lastAt: t0,
        paid: prev.paid === true,
        paidCoins: Number(prev.paidCoins) || 0
      });
      t.delete(startRef); // one start = one task
      return { code: 200, body: { ok: true, count: current + 1, limit } };
    });

    log.log(`[task] uid=${uid} -> ${result.code} ${JSON.stringify(result.body)}`);
    return result;
  } catch (e) {
    log.error('[task] error:', e && e.message);
    return { code: 500, body: { error: 'server-error' } };
  }
}

module.exports = { handleTaskComplete, dayString };
