// ============================================
// SERVER.JS - Version ultra-simple
// ============================================

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import admin from 'firebase-admin';

const app = express();
app.use(express.json());
app.use(cors());

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Config EziPay
const EZIPAY_CLIENT_ID = process.env.EZIPAY_CLIENT_ID;
const EZIPAY_CLIENT_SECRET = process.env.EZIPAY_CLIENT_SECRET;
const EZIPAY_BASE_URL = 'https://ezipaywallet.com/merchant/api';
const FRONTEND_URL = 'https://chanpyon509.com';

// ===== OBTENIR TOKEN =====
async function getEziPayToken() {
  const response = await axios.post(`${EZIPAY_BASE_URL}/access-token`, {
    client_id: EZIPAY_CLIENT_ID,
    client_secret: EZIPAY_CLIENT_SECRET
  });
  return response.data.data.access_token;
}

// ===== CRÉER DÉPÔT =====
app.post('/api/create-deposit', async (req, res) => {
  const { userId, amount, currency } = req.body;
  
  console.log('📥 CREATE DEPOSIT:', { userId, amount, currency });

  try {
    const token = await getEziPayToken();
    console.log('✅ Token obtenu');

    const ezipayResponse = await axios.post(
      `${EZIPAY_BASE_URL}/transaction/create`,
      {
        amount: parseFloat(amount),
        currency: currency || 'USD',
        successUrl: `${FRONTEND_URL}/ezipay-paiement.html`,
        cancelUrl: `${FRONTEND_URL}/ezipay-paiement.html`,
        metadata: JSON.stringify({ userId, amount, type: 'deposit' })
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ Transaction créée:', ezipayResponse.data.data.grant_id);
    console.log('🔗 Payment URL:', ezipayResponse.data.data.payment_url);

    const fees = parseFloat(amount) * 0.06;
    const creditAmount = parseFloat(amount) - fees;

    res.json({
      success: true,
      payment_url: ezipayResponse.data.data.payment_url,
      expectedCredit: creditAmount
    });
  } catch (error) {
    console.error('❌ Erreur create-deposit:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== VÉRIFIER DÉPÔT =====
app.post('/api/verify-deposit', async (req, res) => {
  const { transactionId, userId } = req.body;
  
  console.log('🔍 VERIFY DEPOSIT:', { transactionId, userId });

  try {
    const token = await getEziPayToken();
    
    const ezipayResponse = await axios.get(
      `${EZIPAY_BASE_URL}/transaction/get/${transactionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('📦 Réponse EziPay:', ezipayResponse.data);

    if (ezipayResponse.data.data.status !== 'Success') {
      console.log('❌ Statut pas Success:', ezipayResponse.data.data.status);
      return res.json({ success: false, error: 'Paiement non confirmé' });
    }

    const amount = parseFloat(ezipayResponse.data.data.amount);
    const fees = amount * 0.06;
    const creditAmount = amount - fees;

    console.log('💰 Montants:', { amount, fees, creditAmount });

    // Mettre à jour Firebase
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const currentBalance = userDoc.data()?.balance || 0;
    const newBalance = currentBalance + creditAmount;

    console.log('💾 Update Firebase:', { currentBalance, newBalance });

    await userRef.set({ balance: newBalance }, { merge: true });

    await userRef.collection('transactions').add({
      type: 'deposit',
      amount: amount,
      creditAmount: creditAmount,
      fees: fees,
      status: 'completed',
      transactionId: transactionId,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Tout mis à jour avec succès');

    res.json({
      success: true,
      creditAmount: creditAmount,
      newBalance: newBalance
    });
  } catch (error) {
    console.error('❌ Erreur verify-deposit:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== CRÉER RETRAIT =====
app.post('/api/create-withdrawal', async (req, res) => {
  const { userId, amount, currency, emailOrPhone, paymentMethodId } = req.body;

  console.log('💸 CREATE WITHDRAWAL:', { userId, amount, emailOrPhone });

  try {
    const token = await getEziPayToken();

    const userDoc = await db.collection('users').doc(userId).get();
    const balance = userDoc.data()?.balance || 0;
    const fees = amount * 0.06;
    const totalDebit = amount + fees;

    if (balance < totalDebit) {
      return res.json({ success: false, error: 'Solde insuffisant' });
    }

    await axios.post(
      `${EZIPAY_BASE_URL}/send-money/create`,
      {
        email_or_phone: emailOrPhone,
        currency: currency || 'USD',
        amount: parseFloat(amount),
        payment_method_id: parseInt(paymentMethodId)
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const newBalance = balance - totalDebit;
    await db.collection('users').doc(userId).update({ balance: newBalance });

    await db.collection('users').doc(userId).collection('transactions').add({
      type: 'withdrawal',
      amount: amount,
      fees: fees,
      totalDebit: totalDebit,
      status: 'completed',
      emailOrPhone: emailOrPhone,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Retrait effectué');

    res.json({ success: true, totalDebit: totalDebit, newBalance: newBalance });
  } catch (error) {
    console.error('❌ Erreur withdrawal:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur port ${PORT}`));
