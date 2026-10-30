'use strict';
const express = require('express');
const admin = require('firebase-admin');
const { handlePostback } = require('./offerwallapi');

// Firebase service account: any env var whose name starts with FIREBASE_SERV
// (JSON text, or the same JSON encoded as base64)
function loadServiceAccount() {
  const key = Object.keys(process.env).find((k) => k.startsWith('FIREBASE_SERV'));
  if (!key) throw new Error('Firebase service account variable not found (its name must start with FIREBASE_SERV)');
  let raw = String(process.env[key]).trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
const db = admin.firestore();

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

// OfferwallApi calls this (POST, with the parameters in the body or the query)
app.all('/offerwallapi', async (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const r = await handlePostback(params, {
    db,
    secret: String(process.env.OFFERWALLAPI_SECRET || '').trim(),
    maxReward: Number(process.env.MAX_REWARD_COINS) || 2000000
  });
  res.status(r.code).type('text/plain').send(r.text);
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.type('text/plain').send('HalalLearn postback server is running'));
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
