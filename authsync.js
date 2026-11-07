'use strict';
/**
 * Keeps the database in step with Firebase Authentication, automatically.
 * When an account is deleted in Authentication, its profile (coins, history) in Firestore "users" is removed too,
 * so the person also leaves the leaderboard and the admin user list.
 *
 * How it works (cheap enough for the free plan):
 *  - every run lists the login accounts (Authentication, free) and compares with the list saved by the last run
 *    -> accounts that disappeared are candidates
 *  - once a day (and on the very first run) it also scans all profiles for ones without a login account
 *  - a candidate is only deleted when it is seen missing on TWO runs at least 2 minutes apart (protects from glitches)
 *  - if more than 30% of the profiles look orphaned (and more than 20 of them), nothing is deleted
 *  - if the login list comes back empty, nothing is done
 * State is kept in syncState/auth, syncState/pending and syncState/status (the admin can read the status).
 */
const GRACE_MS = 2 * 60 * 1000;
const FULL_SCAN_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_FRACTION = 0.3;
const MIN_ALLOWED = 20;
const MAX_SNAPSHOT_UIDS = 20000; // keeps the saved list far below the 1 MB document limit

async function listAuthUids(auth) {
  const uids = new Set();
  let pageToken;
  do {
    const res = await auth.listUsers(1000, pageToken);
    res.users.forEach((u) => uids.add(u.uid));
    pageToken = res.pageToken;
  } while (pageToken);
  return uids;
}

async function runAuthSync({ auth, db, now = () => Date.now(), log = console, forceScan = false }) {
  const t = now();
  const current = await listAuthUids(auth);
  if (current.size === 0) {
    log.warn('[authsync] login list is empty, nothing done');
    return { skipped: 'auth-list-empty' };
  }

  const snapRef = db.doc('syncState/auth');
  const pendRef = db.doc('syncState/pending');
  const statRef = db.doc('syncState/status');
  const [snapDoc, pendDoc, statDoc] = await Promise.all([snapRef.get(), pendRef.get(), statRef.get()]);
  const prev = snapDoc.exists && Array.isArray((snapDoc.data() || {}).uids) ? new Set(snapDoc.data().uids) : null;
  const pending = pendDoc.exists ? { ...((pendDoc.data() || {}).seen || {}) } : {};
  const stat = statDoc.exists ? statDoc.data() || {} : {};

  const candidates = new Set();
  if (prev) for (const u of prev) if (!current.has(u)) candidates.add(u);

  const needScan = forceScan || !prev || !stat.lastScan || t - stat.lastScan >= FULL_SCAN_EVERY_MS;
  let docCount = Number(stat.docCount) || 0;
  if (needScan) {
    const snap = await db.collection('users').select().get();
    docCount = snap.size;
    snap.forEach((d) => {
      if (!current.has(d.id)) candidates.add(d.id);
    });
  }
  for (const u of Object.keys(pending)) if (!current.has(u)) candidates.add(u);

  const base = Math.max(docCount, current.size);
  const blocked = candidates.size > Math.max(MIN_ALLOWED, Math.floor(base * MAX_FRACTION));

  let deleted = 0;
  const newPending = {};
  if (blocked) {
    log.warn(`[authsync] ${candidates.size} profiles look orphaned, that is too many. Nothing deleted.`);
    Object.assign(newPending, pending);
  } else {
    for (const u of candidates) {
      const first = pending[u];
      if (first && t - first >= GRACE_MS) {
        await db.recursiveDelete(db.doc(`users/${u}`)); // the profile and its history
        deleted += 1;
      } else {
        newPending[u] = first || t;
      }
    }
  }
  if (deleted) docCount = Math.max(0, docCount - deleted);

  await pendRef.set({ seen: newPending, updatedAt: t });
  if (current.size <= MAX_SNAPSHOT_UIDS) await snapRef.set({ uids: [...current], at: t });
  await statRef.set({
    authCount: current.size,
    docCount,
    lastRun: t,
    lastScan: needScan ? t : stat.lastScan || 0,
    pending: Object.keys(newPending).length,
    deletedTotal: (Number(stat.deletedTotal) || 0) + deleted,
    blocked
  });

  if (deleted) log.log(`[authsync] removed ${deleted} profiles without a login account`);
  return { authCount: current.size, docCount, deleted, pending: Object.keys(newPending).length, blocked };
}

module.exports = { runAuthSync, GRACE_MS, FULL_SCAN_EVERY_MS };
