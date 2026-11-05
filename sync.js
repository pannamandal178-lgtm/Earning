'use strict';
/**
 * Finds profiles in the database (Firestore "users") whose login account no longer exists in
 * Firebase Authentication, and (only when the admin confirms) removes their data.
 * That is how people deleted in Authentication also disappear from the leaderboard.
 *
 * Safety rules:
 *  - the admin's own profile is never touched
 *  - if the list of login accounts comes back empty, nothing is done
 *  - deleting needs the exact count the admin just saw ("expected")
 *  - if more than half of all profiles look orphaned, nothing is deleted (probably a mistake)
 */
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

async function findOrphans({ auth, db, protectUids = [] }) {
  const authUids = await listAuthUids(auth);
  if (authUids.size === 0) throw new Error('auth-list-empty');
  const snap = await db.collection('users').select('name', 'email').get();
  const protect = new Set(protectUids);
  const orphans = [];
  snap.forEach((d) => {
    if (!authUids.has(d.id) && !protect.has(d.id)) {
      orphans.push({ uid: d.id, name: String(d.get('name') || ''), email: String(d.get('email') || '') });
    }
  });
  return { authCount: authUids.size, docCount: snap.size, orphans };
}

async function removeOrphans({ auth, db, expected, protectUids = [], log = console }) {
  const r = await findOrphans({ auth, db, protectUids });
  if (!Number.isInteger(expected) || r.orphans.length !== expected) throw new Error('changed');
  if (r.docCount > 20 && r.orphans.length > r.docCount * 0.5) throw new Error('too-many');
  let deleted = 0;
  for (const o of r.orphans) {
    await db.recursiveDelete(db.collection('users').doc(o.uid)); // the profile and its history
    deleted += 1;
  }
  log.log(`[sync] deleted ${deleted} profiles without a login account`);
  return { deleted };
}

module.exports = { findOrphans, removeOrphans };
