'use strict';
/**
 * "Tap & Earn": counts the ads a user taps to watch, with rest times, checked on the SERVER.
 *  - after every tap the user must wait `restSeconds` (default 15 s)
 *  - after `batchSize` taps (default 3) the user rests `longRestMinutes` (default 60 min)
 *  - at most `dailyLimit` taps per day (default 9)
 * The counts are stored in tapDays/{uid}_{day}. Users get NO coins for a tap. The admin pays later
 * (for yesterday and earlier only) from the admin panel.
 */
const DEFAULTS = { dailyLimit: 9, batchSize: 3, restSeconds: 15, longRestMinutes: 60 };
const TOLERANCE_MS = 700; // small allowance for network / clock differences

const dayString = (ms, offsetMinutes) => new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 10);

const intIn = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

function configFrom(raw) {
  const c = raw || {};
  return {
    dailyLimit: intIn(c.dailyLimit, 1, 100, DEFAULTS.dailyLimit),
    batchSize: intIn(c.batchSize, 1, 100, DEFAULTS.batchSize),
    restSeconds: intIn(c.restSeconds, 0, 600, DEFAULTS.restSeconds),
    longRestMinutes: intIn(c.longRestMinutes, 0, 1440, DEFAULTS.longRestMinutes)
  };
}

async function handleTapClaim(opts) {
  const { uid, db, now = () => Date.now(), dayOffsetMinutes = 330, log = console } = opts;
  if (!uid) return { code: 401, body: { error: 'not-logged-in' } };

  try {
    const cfgSnap = await db.doc('appConfig/tapEarn').get();
    const cfg = configFrom(cfgSnap.exists ? cfgSnap.data() : null);

    const t0 = now();
    const today = dayString(t0, dayOffsetMinutes);
    const dayRef = db.doc(`tapDays/${uid}_${today}`);
    const userRef = db.doc(`users/${uid}`);

    const result = await db.runTransaction(async (t) => {
      const daySnap = await t.get(dayRef);
      const userSnap = await t.get(userRef);

      if (!userSnap.exists) return { code: 403, body: { error: 'no-user' } };
      const u = userSnap.data() || {};
      if (u.banned === true) return { code: 403, body: { error: 'banned' } };

      const d = daySnap.exists ? daySnap.data() || {} : {};
      const count = Number(d.count) || 0;
      const batch = Number(d.batch) || 0;
      const lastAt = Number(d.lastAt) || 0;
      const restUntil = Number(d.restUntil) || 0;

      if (count >= cfg.dailyLimit) return { code: 429, body: { error: 'limit', count, limit: cfg.dailyLimit, serverNow: t0 } };
      if (restUntil > t0 + TOLERANCE_MS) return { code: 429, body: { error: 'rest', retryAt: restUntil, serverNow: t0 } };
      const nextAt = lastAt + cfg.restSeconds * 1000;
      if (lastAt && t0 < nextAt - TOLERANCE_MS) return { code: 429, body: { error: 'wait', retryAt: nextAt, serverNow: t0 } };

      const newCount = count + 1;
      let newBatch = batch + 1;
      let newRestUntil = restUntil > t0 ? restUntil : 0;
      if (newBatch >= cfg.batchSize) {
        newBatch = 0;
        newRestUntil = t0 + cfg.longRestMinutes * 60000;
      }

      t.set(dayRef, {
        uid,
        date: today,
        count: newCount,
        batch: newBatch,
        lastAt: t0,
        restUntil: newRestUntil,
        name: String(u.name || u.nickname || '').slice(0, 80),
        email: String(u.email || '').slice(0, 120),
        paid: d.paid === true,
        paidCoins: Number(d.paidCoins) || 0
      });
      return { code: 200, body: { ok: true, count: newCount, limit: cfg.dailyLimit, lastAt: t0, restUntil: newRestUntil, serverNow: t0 } };
    });

    log.log(`[tap] uid=${uid} -> ${result.code} ${result.body.error || 'ok'}`);
    return result;
  } catch (e) {
    log.error('[tap] error:', e && e.message);
    return { code: 500, body: { error: 'server-error' } };
  }
}

module.exports = { handleTapClaim, configFrom, DEFAULTS };
