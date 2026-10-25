'use strict';

/** Coins from the "amount" the offerwall sends (already in your app currency) times COIN_MULTIPLIER, rounded down. */
function toCoins(amount, multiplier) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * multiplier);
}

const safeId = (txId) => String(txId).replace(/[\/\s]/g, '_').slice(0, 200);

/**
 * Credits ('credit') or takes back ('reversal') the coins of ONE conversion.
 * The transaction id is the document id, so a repeated postback is never counted twice.
 * Returns { status, body }. 200 = done (the network stops retrying).
 */
async function applyConversion({ db, FieldValue, collection, source, userId, txId, coins, kind, meta = {}, now = Date.now() }) {
  if (!userId || !txId || userId.includes('/')) return { status: 400, body: 'missing or bad user_id / transaction_id' };
  const offerName = String(meta.offerName || '').slice(0, 120);
  let result = 'credited';

  await db.runTransaction(async (t) => {
    const pbRef = db.collection(collection).doc(safeId(txId));
    const userRef = db.collection('users').doc(userId);
    const pb = await t.get(pbRef);
    const user = await t.get(userRef);
    const base = { ...meta, userId, transactionId: txId, createdAt: now };

    if (kind === 'credit') {
      if (pb.exists) {
        result = 'duplicate';
        return;
      }
      if (!user.exists) {
        t.set(pbRef, { ...base, coins: 0, status: 'user_not_found' });
        result = 'user_not_found';
        return;
      }
      if (coins <= 0) {
        t.set(pbRef, { ...base, coins: 0, status: 'ignored_amount' });
        result = 'ignored_amount';
        return;
      }
      t.update(userRef, {
        coins: FieldValue.increment(coins),
        totalEarnings: FieldValue.increment(coins),
        weeklyCoins: FieldValue.increment(coins),
        monthlyCoins: FieldValue.increment(coins)
      });
      t.set(pbRef, { ...base, coins, status: 'credited' });
      t.set(userRef.collection('transactions').doc(), {
        type: 'offer',
        amount: coins,
        note: offerName ? `${source}: ${offerName}` : `${source} offer`,
        createdAt: now
      });
      result = 'credited';
      return;
    }

    // reversal: take back what was credited for this same transaction id
    if (!pb.exists) {
      t.set(pbRef, { ...base, coins: 0, status: 'reversal_without_credit' });
      result = 'reversal_without_credit';
      return;
    }
    const d = pb.data();
    if (d.status !== 'credited') {
      result = 'duplicate_reversal';
      return;
    }
    if (!user.exists) {
      t.update(pbRef, { status: 'reversed', reversedAt: now, takenBack: 0 });
      result = 'user_not_found';
      return;
    }
    const have = Number(user.data().coins) || 0;
    const take = Math.max(0, Math.min(Number(d.coins) || 0, have)); // the balance never goes below 0
    if (take > 0) {
      t.update(userRef, {
        coins: FieldValue.increment(-take),
        totalEarnings: FieldValue.increment(-take),
        weeklyCoins: FieldValue.increment(-take),
        monthlyCoins: FieldValue.increment(-take)
      });
      t.set(userRef.collection('transactions').doc(), {
        type: 'offer',
        amount: -take,
        note: `${source} reversed${offerName ? ': ' + offerName : ''}`,
        createdAt: now
      });
    }
    t.update(pbRef, { status: 'reversed', reversedAt: now, takenBack: take });
    result = 'reversed';
  });

  return { status: 200, body: result };
}

/** MM Wall: parameters user_id, amount, payout, transaction_id, user_ip, subid, offerid, offername. */
function processPostback({ db, FieldValue, params, multiplier = 1, now = Date.now() }) {
  return applyConversion({
    db,
    FieldValue,
    now,
    collection: 'mmwallPostbacks',
    source: 'MM Wall',
    userId: String(params.user_id || '').trim(),
    txId: String(params.transaction_id || '').trim(),
    coins: toCoins(params.amount, multiplier),
    kind: 'credit',
    meta: {
      amount: Number(params.amount) || 0,
      payout: Number(params.payout) || 0,
      offerId: String(params.offerid || ''),
      offerName: String(params.offername || ''),
      subid: String(params.subid || ''),
      ip: String(params.user_ip || '')
    }
  });
}

const CREDIT = ['1', 'credit', 'credited', 'approved', 'completed', 'complete', 'success', 'valid', 'ok'];
const REVERSAL = ['2', '0', '-1', 'reversal', 'reversed', 'chargeback', 'debit', 'rejected', 'revoked', 'declined', 'refunded', 'cancelled', 'canceled'];

function pick(p, ...names) {
  for (const n of names) if (p[n] !== undefined && p[n] !== null && String(p[n]) !== '') return String(p[n]).trim();
  return '';
}

/** ClixWall: user_id (u), user_payout (c), transaction_id, status (s), publisher_payout (payout), offer_id (cid), offer_name (cname). */
async function processClixwall({ db, FieldValue, params, multiplier = 1, now = Date.now() }) {
  const status = pick(params, 'status', 's').toLowerCase();
  const kind = CREDIT.includes(status) ? 'credit' : REVERSAL.includes(status) ? 'reversal' : 'unknown';
  if (kind === 'unknown') return { status: 200, body: 'unknown_status:' + status };
  return applyConversion({
    db,
    FieldValue,
    now,
    collection: 'clixwallPostbacks',
    source: 'ClixWall',
    userId: pick(params, 'user_id', 'u'),
    txId: pick(params, 'transaction_id'),
    coins: toCoins(pick(params, 'user_payout', 'c'), multiplier),
    kind,
    meta: {
      userPayoutUsd: Number(pick(params, 'user_payout_usd')) || 0,
      payout: Number(pick(params, 'publisher_payout', 'payout')) || 0,
      offerId: pick(params, 'offer_id', 'cid'),
      offerName: pick(params, 'offer_name', 'cname'),
      rawStatus: status
    }
  });
}

module.exports = { processPostback, processClixwall, applyConversion, toCoins };
