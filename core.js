'use strict';

/** Reward in app coins: the "amount" from MM Wall times COIN_MULTIPLIER, rounded down. */
function toCoins(amount, multiplier) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * multiplier);
}

/**
 * Adds the coins for one MM Wall conversion.
 * The transaction_id is used as a document id, so the same postback is never paid twice (MM Wall retries).
 * Returns { status, body }. status 200 = done (MM Wall stops retrying), anything else = MM Wall retries.
 */
async function processPostback({ db, FieldValue, params, multiplier = 1, now = Date.now() }) {
  const userId = String(params.user_id || '').trim();
  const txId = String(params.transaction_id || '').trim();
  if (!userId || !txId || userId.includes('/')) return { status: 400, body: 'missing or bad user_id / transaction_id' };

  const coins = toCoins(params.amount, multiplier);
  const pbId = txId.replace(/[\/\s]/g, '_').slice(0, 200);
  const offerName = String(params.offername || '').slice(0, 120);
  let result = 'credited';

  await db.runTransaction(async (t) => {
    const pbRef = db.collection('mmwallPostbacks').doc(pbId);
    const userRef = db.collection('users').doc(userId);
    const pb = await t.get(pbRef);
    if (pb.exists) {
      result = 'duplicate';
      return;
    }
    const base = {
      userId,
      transactionId: txId,
      amount: Number(params.amount) || 0,
      payout: Number(params.payout) || 0,
      offerId: String(params.offerid || ''),
      offerName,
      subid: String(params.subid || ''),
      ip: String(params.user_ip || ''),
      createdAt: now
    };
    const user = await t.get(userRef);
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
      note: offerName ? `MM Wall: ${offerName}` : 'MM Wall offer',
      createdAt: now
    });
  });

  return { status: 200, body: result };
}

module.exports = { processPostback, toCoins };
