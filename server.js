'use strict';
const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const { processPostback } = require('./core');

// ---- settings (set them in Render > Environment) ----
const SECRET = process.env.POSTBACK_SECRET || '';
const MULTIPLIER = Number(process.env.COIN_MULTIPLIER || 1) || 1;
const ENFORCE_IP = String(process.env.ENFORCE_IP || 'false') === 'true';
const ALLOWED_IP = process.env.ALLOWED_IP || '63.32.127.99'; // MM Wall's server

if (!SECRET) console.warn('POSTBACK_SECRET is not set: every postback will be refused.');

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

app.listen(process.env.PORT || 3000, () => console.log('listening'));
