'use strict';
const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const { processPostback, processClixwall } = require('./core');

// ---- settings (set them in Render > Environment) ----
const SECRET = process.env.POSTBACK_SECRET || ''; // MM Wall: you choose it
const CLIX_SECRET = process.env.CLIXWALL_SECRET || ''; // ClixWall: copy it from your website page in ClixWall
const MULTIPLIER = Number(process.env.COIN_MULTIPLIER || 1) || 1;
const ENFORCE_IP = String(process.env.ENFORCE_IP || 'false') === 'true';
const ALLOWED_IP = process.env.ALLOWED_IP || '63.32.127.99'; // MM Wall's server

if (!SECRET) console.warn('POSTBACK_SECRET is not set: MM Wall postbacks will be refused.');
if (!CLIX_SECRET) console.warn('CLIXWALL_SECRET is not set: ClixWall postbacks will be refused.');

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.set('trust proxy', true);

app.get('/', (_req, res) => res.send('MM Wall postback server is running'));

// ClixWall sends a form-encoded POST (the values can also be in the URL)
app.use(express.urlencoded({ extended: false }));

app.all('/mmwall', async (req, res) => {
  const q = req.query || {};
  if (!SECRET || !same(q.secret || '', SECRET)) return res.status(403).send('forbidden');
  if (ENFORCE_IP) {
    const ip = String(req.ip || '').replace('::ffff:', '');
    if (ip !== ALLOWED_IP) return res.status(403).send('ip not allowed');
  }
  try {
    const r = await processPostback({ db, FieldValue, params: q, multiplier: MULTIPLIER });
    console.log('postback', q.transaction_id, '->', r.body);
    return res.status(r.status).send(r.body);
  } catch (e) {
    console.error('postback failed', e);
    return res.status(500).send('error'); // MM Wall will retry
  }
});

app.all('/clixwall', async (req, res) => {
  const p = { ...(req.body || {}), ...(req.query || {}) };
  const secret = p.secret || p.pwd || '';
  if (!CLIX_SECRET || !same(secret, CLIX_SECRET)) return res.status(403).send('forbidden');
  try {
    const r = await processClixwall({ db, FieldValue, params: p, multiplier: MULTIPLIER });
    console.log('clixwall', p.transaction_id, 'status=' + (p.status || p.s), '->', r.body);
    return res.status(r.status).send(r.status === 200 ? 'OK' : r.body);
  } catch (e) {
    console.error('clixwall failed', e);
    return res.status(500).send('error');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));
