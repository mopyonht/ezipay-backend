import express from 'express';
import cors from 'cors';
import axios from 'axios';
import admin from 'firebase-admin';

const app = express();
app.use(express.json());
app.use(cors());

// ===== FIREBASE =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ===== VARIABLES =====
const EZIPAY_CLIENT_ID = process.env.EZIPAY_CLIENT_ID;
const EZIPAY_CLIENT_SECRET = process.env.EZIPAY_CLIENT_SECRET;
const EZIPAY_BASE_URL = 'https://ezipaywallet.com/merchant/api';

// ===== OBTENIR ACCESS TOKEN =====
async function getEziPayToken() {
  try {
    const response = await axios.post(
      `${EZIPAY_BASE_URL}/access-token`,
      {
        client_id: EZIPAY_CLIENT_ID,
        client_secret: EZIPAY_CLIENT_SECRET
      }
    );
    return response.data.data.access_token;
  } catch (error) {
    console.error('❌ Erreur token:', error.response?.data || error.message);
    throw new Error('Erreur authentification EziPay');
  }
}

// ===== CRÉER DÉPÔT =====
app.post('/api/create-deposit', async (req, res) => {
  const { userId, amount, currency } = req.body;

  try {
    const token = await getEziPayToken();

    const response = await axios.post(
      `${EZIPAY_BASE_URL}/transaction/create`,
      {
        amount: Math.round(amount * 100) / 100,
        currency: currency || 'USD',
        successUrl: `${process.env.FRONTEND_URL}/ezipay-paiement.html?deposit=success`,
        cancelUrl: `${process.env.FRONTEND_URL}/ezipay-paiement.html?deposit=cancel`,
        metadata: `Dépôt wallet ${userId}`
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const fees = amount * 0.06;
    const creditAmount = amount - fees;

    // Sauvegarder en attente avec grant_id
    await db
      .collection('users')
      .doc(userId)
      .collection('pending_deposits')
      .add({
        grantId: response.data.data.grant_id,
        amount: amount,
        creditAmount: creditAmount,
        fees: fees,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      success: true,
      payment_url: response.data.data.payment_url,
      grant_id: response.data.data.grant_id,
      expectedCredit: creditAmount
    });
  } catch (error) {
    console.error('❌ Erreur create-deposit:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// ===== VÉRIFIER DÉPÔT =====
// CHANGEMENT ICI : Utilise transactionId (pas grantId) pour vérifier avec EziPay
app.post('/api/verify-deposit', async (req, res) => {
  const { transactionId, userId } = req.body;

  try {
    const token = await getEziPayToken();

    // Vérifier avec transaction_id auprès d'EziPay
    const response = await axios.get(
      `${EZIPAY_BASE_URL}/transaction/get/${transactionId}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (response.data.data.status !== 'Success') {
      return res.json({ success: false, error: 'Paiement non confirmé' });
    }

    const amount = parseFloat(response.data.data.amount);
    const fees = amount * 0.06;
    const creditAmount = amount - fees;

    // Créditer l'utilisateur
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const newBalance = (userDoc.data()?.balance || 0) + creditAmount;

    await userRef.update({ balance: newBalance });

    // Enregistrer transaction
    await userRef.collection('transactions').add({
      type: 'deposit',
      amount: amount,
      creditAmount: creditAmount,
      fees: fees,
      status: 'completed',
      transactionId: transactionId,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      creditAmount: creditAmount,
      newBalance: newBalance,
      transaction: {
        type: 'deposit',
        amount: amount,
        creditAmount: creditAmount,
        status: 'completed',
        date: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Erreur verify-deposit:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// ===== CRÉER RETRAIT =====
app.post('/api/create-withdrawal', async (req, res) => {
  const { userId, amount, currency, emailOrPhone, paymentMethodId } = req.body;

  try {
    const token = await getEziPayToken();

    // Vérifier solde
    const userDoc = await db.collection('users').doc(userId).get();
    const balance = userDoc.data()?.balance || 0;
    const fees = amount * 0.06;
    const totalDebit = amount + fees;

    if (balance < totalDebit) {
      return res.json({ success: false, error: 'Solde insuffisant' });
    }

    // Créer send-money
    const response = await axios.post(
      `${EZIPAY_BASE_URL}/send-money/create`,
      {
        email_or_phone: emailOrPhone,
        currency: currency || 'USD',
        amount: Math.round(amount * 100) / 100,
        payment_method_id: parseInt(paymentMethodId)
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    // Débiter
    const newBalance = balance - totalDebit;
    await db.collection('users').doc(userId).update({
      balance: newBalance
    });

    // Enregistrer transaction
    await db.collection('users').doc(userId).collection('transactions').add({
      type: 'withdrawal',
      amount: amount,
      fees: fees,
      totalDebit: totalDebit,
      status: 'processing',
      emailOrPhone: emailOrPhone,
      paymentMethod: paymentMethodId === '1' ? 'EziPay' : 'MonCash',
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      totalDebit: totalDebit,
      newBalance: newBalance,
      transaction: {
        type: 'withdrawal',
        amount: amount,
        totalDebit: totalDebit,
        status: 'processing',
        date: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Erreur create-withdrawal:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
});
