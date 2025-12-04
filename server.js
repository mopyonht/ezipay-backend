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
const EZIPAY_BASE_URL = 'https://ezipaywallet.com/merchant/api/';

// ===== OBTENIR ACCESS TOKEN =====
async function getEziPayToken() {
  try {
    const response = await axios.post(
      `${EZIPAY_BASE_URL}/access-token`,
      {
        grant_type: 'client_credentials',
        client_id: EZIPAY_CLIENT_ID,
        client_secret: EZIPAY_CLIENT_SECRET
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Erreur token:', error.message);
    throw new Error('Erreur authentification EziPay');
  }
}

// ===== CRÉER DÉPÔT =====
app.post('/api/create-deposit', async (req, res) => {
  const { userId, amount, currency } = req.body;

  try {
    const token = await getEziPayToken();

    const response = await axios.post(
      `${EZIPAY_BASE_URL}/api/payment/create`,
      {
        amount: amount,
        currency: currency || 'USD',
        description: `Dépôt wallet ${userId}`,
        return_url: `${process.env.FRONTEND_URL}/ezipay-paiement.html?deposit=success`,
        cancel_url: `${process.env.FRONTEND_URL}/ezipay-paiement.html?deposit=cancel`
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const fees = amount * 0.06;
    const creditAmount = amount - fees;

    // Sauvegarder en attente
    await db
      .collection('users')
      .doc(userId)
      .collection('pending_deposits')
      .add({
        transactionId: response.data.transaction_id,
        amount: amount,
        creditAmount: creditAmount,
        fees: fees,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      success: true,
      payment_url: response.data.payment_link,
      transactionId: response.data.transaction_id,
      expectedCredit: creditAmount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== VÉRIFIER DÉPÔT =====
app.post('/api/verify-deposit', async (req, res) => {
  const { transactionId, userId } = req.body;

  try {
    const token = await getEziPayToken();

    const response = await axios.get(
      `${EZIPAY_BASE_URL}/api/payment/status/${transactionId}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (response.data.status !== 'completed') {
      return res.json({ success: false, error: 'Paiement non confirmé' });
    }

    // Récupérer le dépôt en attente
    const deposits = await db
      .collection('users')
      .doc(userId)
      .collection('pending_deposits')
      .where('transactionId', '==', transactionId)
      .get();

    if (deposits.empty) {
      return res.json({ success: false, error: 'Transaction non trouvée' });
    }

    const depositDoc = deposits.docs[0];
    const deposit = depositDoc.data();
    const creditAmount = deposit.creditAmount;

    // Créditer l'utilisateur
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const newBalance = (userDoc.data()?.balance || 0) + creditAmount;

    await userRef.update({ balance: newBalance });

    // Enregistrer transaction
    await userRef.collection('transactions').add({
      type: 'deposit',
      amount: deposit.amount,
      creditAmount: creditAmount,
      fees: deposit.fees,
      status: 'completed',
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    // Marquer comme complétée
    await depositDoc.ref.update({ status: 'completed' });

    res.json({
      success: true,
      creditAmount: creditAmount,
      newBalance: newBalance,
      transaction: {
        type: 'deposit',
        amount: deposit.amount,
        creditAmount: creditAmount,
        status: 'completed',
        date: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
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

    // Créer payout
    const response = await axios.post(
      `${EZIPAY_BASE_URL}/api/payout/create`,
      {
        amount: amount,
        currency: currency || 'USD',
        email: emailOrPhone,
        payment_method_id: paymentMethodId,
        description: `Retrait wallet ${userId}`
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
      transactionId: response.data.transaction_id,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      transactionId: response.data.transaction_id,
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
    res.status(500).json({
      success: false,
      error: error.message
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
