require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Firebase Admin SDK Initialize
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
});

const db = admin.firestore();
const MMWALL_IP = '63.32.127.99'; // mm wall postback IP

/**
 * Verify postback IP (optional but recommended)
 */
function verifyIp(req) {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  // In production, check: clientIp.includes(MMWALL_IP)
  // But behind proxies (Railway), this may differ. Log for debugging.
  console.log(`[postback] Client IP: ${clientIp}`);
  return true;
}

/**
 * Main postback endpoint for mm wall
 * Params: user_id, amount (coins), payout (USD), transaction_id, user_ip, subid, offerid, offername
 */
app.post('/mmwall', async (req, res) => {
  try {
    const { user_id, amount, payout, transaction_id, user_ip, subid, offerid, offername } = req.query;

    // Log incoming postback
    console.log('[mmwall-postback] Received:', {
      user_id,
      amount,
      payout,
      transaction_id,
      offername,
      timestamp: new Date().toISOString(),
    });

    // Validate required fields
    if (!user_id || !amount || !transaction_id) {
      console.error('[mmwall-postback] Missing required params');
      return res.status(400).json({ error: 'Missing required params' });
    }

    const coinsToAdd = parseInt(amount, 10);
    if (isNaN(coinsToAdd) || coinsToAdd <= 0) {
      console.error('[mmwall-postback] Invalid amount:', amount);
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check for duplicate transaction
    const transactionRef = db.collection('mmwallTransactions').doc(transaction_id);
    const existingTx = await transactionRef.get();
    if (existingTx.exists) {
      console.log('[mmwall-postback] Transaction already processed:', transaction_id);
      // Return 200 to acknowledge (mm wall will not retry)
      return res.status(200).json({ message: 'Transaction already processed' });
    }

    // Find user by Firebase UID (assume user_id is the UID)
    // If user_id is something else, you may need a separate mapping collection
    const userRef = db.collection('users').doc(user_id);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      console.error('[mmwall-postback] User not found:', user_id);
      // Still log the transaction to prevent re-processing
      await transactionRef.set({
        user_id,
        amount: coinsToAdd,
        transaction_id,
        offerId: offerid,
        offerName: offername,
        status: 'user_not_found',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Return 200 (nothing to reward if user doesn't exist)
      return res.status(200).json({ message: 'User not found' });
    }

    // Update user coins in a transaction
    await db.runTransaction(async (transaction) => {
      const currentData = await transaction.get(userRef);
      const currentCoins = currentData.get('coins') || 0;
      const currentTotalEarnings = currentData.get('totalEarnings') || 0;
      const currentWeeklyCoins = currentData.get('weeklyCoins') || 0;
      const currentMonthlyCoins = currentData.get('monthlyCoins') || 0;

      // Add coins
      transaction.update(userRef, {
        coins: currentCoins + coinsToAdd,
        totalEarnings: currentTotalEarnings + coinsToAdd,
        weeklyCoins: currentWeeklyCoins + coinsToAdd,
        monthlyCoins: currentMonthlyCoins + coinsToAdd,
      });

      // Log transaction
      transaction.set(transactionRef, {
        user_id,
        amount: coinsToAdd,
        transaction_id,
        offerId: offerid,
        offerName: offername,
        payout: payout,
        subId: subid,
        userIp: user_ip,
        status: 'success',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`[mmwall-postback] Success: ${user_id} +${coinsToAdd} coins (tx: ${transaction_id})`);
    
    // Return 200 to acknowledge successful processing
    return res.status(200).json({ 
      message: 'Postback processed',
      user_id,
      coins_added: coinsToAdd,
      transaction_id,
    });
  } catch (error) {
    console.error('[mmwall-postback] Error:', error.message);
    // Return 500 so mm wall retries (as per their spec)
    return res.status(500).json({ error: 'Processing error' });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.status(200).json({ 
    service: 'HalalLearn mm wall Postback Server',
    version: '1.0.0',
    status: 'running',
  });
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`[server] mm wall Postback Server running on port ${PORT}`);
  console.log(`[server] Health check: GET http://localhost:${PORT}/health`);
  console.log(`[server] Postback endpoint: POST http://localhost:${PORT}/mmwall`);
});
