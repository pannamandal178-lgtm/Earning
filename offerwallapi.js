'use strict';
/**
 * OfferwallApi S2S postback handler (pure logic, no web framework).
 *
 * Rules taken from the OfferwallApi documentation:
 *  - signature  = md5(subId + transId + reward + secret)
 *  - signature2 = hmac_sha256(subId + transId + reward, secret)
 *  - reward is already converted to the app currency (do NOT multiply again)
 *  - status = 2 means chargeback / reversal
 *  - debug = 1 (and transId starting with "test-") means a test: never credit
 *  - subId must match the user id EXACTLY (no trimming / padding / fixing)
 *  - the response body must be exactly: ok
 */
const crypto = require('crypto');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const text = (v) => (v === undefined || v === null ? '' : String(v));

function safeEqual(a, b) {
  const A = Buffer.from(text(a));
  const B = Buffer.from(text(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function signatureOk(p, secret) {
  const base = text(p.subId) + text(p.transId) + text(p.reward);
  if (p.signature2) {
    const expected2 = crypto.createHmac('sha256', secret).update(base).digest('hex');
    if (safeEqual(expected2, text(p.signature2).toLowerCase())) return true;
  }
  if (p.signature) {
    const expected = crypto.createHash('md5').update(base + secret).digest('hex');
    if (safeEqual(expected, text(p.signature).toLowerCase())) return true;
  }
  return false;
}

// A Firestore document id must not contain "/" and must not be "." or ".."
function validUserId(id) {
  return id.length > 0 && id.length <= 128 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);
}

async function handlePostback(params, opts) {
  const { db, secret, maxReward = 2000000, log = console } = opts;
  const OK = { code: 200, text: 'ok' };

  if (!secret) return { code: 500, text: 'ERROR: server is not configured' };

  // Take the first value if a parameter was sent more than once
  const p = {};
  for (const k of Object.keys(params || {})) p[k] = Array.isArray(params[k]) ? params[k][0] : params[k];
  if (p.subId === undefined && p.sub_id !== undefined) p.subId = p.sub_id;

  const subId = text(p.subId);
  const transId = text(p.transId);
  const rewardRaw = text(p.reward);

  if (!subId || !transId || rewardRaw === '') return { code: 400, text: 'ERROR: missing parameters' };
  if (transId.length > 200 || subId.length > 200) return { code: 400, text: 'ERROR: parameter too long' };
  if (!signatureOk(p, secret)) return { code: 403, text: "ERROR: Signature doesn't match" };

  // Test postbacks never touch real balances
  if (text(p.debug) === '1' || transId.startsWith('test-')) {
    log.log(`[offerwallapi] test postback received (transId=${transId}) - not credited`);
    return OK;
  }

  const amount = Number(rewardRaw);
  if (!Number.isFinite(amount)) return { code: 400, text: 'ERROR: bad reward' };
  const coins = Math.round(Math.abs(amount));
  const isReversal = text(p.status) === '2';
  const offerName = text(p.offer_name).slice(0, 120) || 'OfferwallApi';

  const txKey = encodeURIComponent(transId);
  const logRef = db.doc(`offerwallapiTransactions/${isReversal ? 'r-' : ''}${txKey}`);
  const origRef = db.doc(`offerwallapiTransactions/${txKey}`);
  const base = {
    subId,
    transId,
    reward: rewardRaw,
    coins,
    offerName,
    offerType: text(p.offer_type),
    payoutUsd: text(p.payout),
    userIp: text(p.userIp),
    country: text(p.country),
    createdAt: Date.now()
  };

  try {
    if (coins === 0) return OK;

    if (!validUserId(subId)) {
      log.warn(`[offerwallapi] invalid user id format, not credited (transId=${transId})`);
      await logRef.set({ ...base, status: 'invalid_user' });
      return OK;
    }

    if (!isReversal && coins > maxReward) {
      log.warn(`[offerwallapi] reward ${coins} is above the safety limit - held for review (transId=${transId})`);
      await logRef.set({ ...base, status: 'held_for_review' });
      return OK;
    }

    const userRef = db.doc(`users/${subId}`);

    const result = await db.runTransaction(async (t) => {
      // all reads first
      const logSnap = await t.get(logRef);
      const userSnap = await t.get(userRef);
      const origSnap = isReversal ? await t.get(origRef) : null;

      if (logSnap.exists) return 'duplicate';
      if (!userSnap.exists) {
        t.set(logRef, { ...base, status: 'user_not_found' });
        return 'user_not_found';
      }

      const u = userSnap.data() || {};

      if (!isReversal) {
        t.update(userRef, {
          coins: num(u.coins) + coins,
          totalEarnings: num(u.totalEarnings) + coins,
          weeklyCoins: num(u.weeklyCoins) + coins,
          monthlyCoins: num(u.monthlyCoins) + coins
        });
        t.set(logRef, { ...base, status: 'credited' });
        t.set(db.doc(`users/${subId}/transactions/ow_${txKey}`), {
          type: 'offer',
          amount: coins,
          note: `Offer Reward: ${offerName}`,
          createdAt: base.createdAt
        });
        return 'credited';
      }

      // reversal / chargeback: only if the original credit exists
      if (!origSnap || !origSnap.exists || (origSnap.data() || {}).status !== 'credited') {
        t.set(logRef, { ...base, status: 'reversal_without_credit' });
        return 'reversal_without_credit';
      }
      const take = Math.min(num(u.coins), coins); // never below 0
      t.update(userRef, {
        coins: num(u.coins) - take,
        totalEarnings: Math.max(0, num(u.totalEarnings) - coins),
        weeklyCoins: Math.max(0, num(u.weeklyCoins) - coins),
        monthlyCoins: Math.max(0, num(u.monthlyCoins) - coins)
      });
      t.set(logRef, { ...base, status: 'reversed', taken: take });
      t.update(origRef, { status: 'reversed' });
      t.set(db.doc(`users/${subId}/transactions/ow_r_${txKey}`), {
        type: 'offer',
        amount: -take,
        note: `Offer reversed: ${offerName}`,
        createdAt: base.createdAt
      });
      return 'reversed';
    });

    log.log(`[offerwallapi] ${result} (transId=${transId}, user=${subId}, coins=${coins})`);
    return OK;
  } catch (e) {
    log.error('[offerwallapi] error:', e && e.message);
    // not "ok" -> OfferwallApi will retry later
    return { code: 500, text: 'ERROR: try again' };
  }
}

module.exports = { handlePostback, signatureOk };
