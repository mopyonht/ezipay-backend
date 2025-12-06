import express from 'express';
import cors from 'cors';
import axios from 'axios';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// ===== SERVIR FICHIERS STATIQUES =====
app.use(express.static(__dirname));

// ===== FIREBASE =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== CONFIG EZIPAY =====
const EZIPAY_CLIENT_ID = process.env.EZIPAY_CLIENT_ID;
const EZIPAY_CLIENT_SECRET = process.env.EZIPAY_CLIENT_SECRET;
const EZIPAY_BASE_URL = 'https://ezipaywallet.com/merchant/api';
const FRONTEND_URL = 'https://chanpyon509.com';

// ===== OBTENIR TOKEN EZIPAY =====
async function getEziPayToken() {
  try {
    const response = await axios.post(`${EZIPAY_BASE_URL}/access-token`, {
      client_id: EZIPAY_CLIENT_ID,
      client_secret: EZIPAY_CLIENT_SECRET
    });
    return response.data.data.access_token;
  } catch (error) {
    console.error('❌ Erreur token:', error.response?.data || error.message);
    throw new Error('Impossible d\'obtenir le token EziPay');
  }
}

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ezipay-paiement.html'));
});

// ===== CREATE DEPOSIT (VALIDATION MANUELLE) =====
app.post('/api/create-deposit', async (req, res) => {
  const { userId, amount, currency } = req.body;

  console.log('📥 CREATE DEPOSIT:', { userId, amount, currency });

  if (!userId || !amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ success: false, error: 'Paramètres invalides' });
  }

  try {
    const token = await getEziPayToken();

    const ezipayResponse = await axios.post(
      `${EZIPAY_BASE_URL}/transaction/create`,
      {
        amount: parseFloat(amount),
        currency: currency || 'USD',
        successUrl: `${FRONTEND_URL}/ezipay-paiement.html?deposit=success`,
        cancelUrl: `${FRONTEND_URL}/ezipay-paiement.html`,
        metadata: JSON.stringify({ userId, amount })
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ EziPay response:', ezipayResponse.data);

    // ✅ SAUVEGARDER DEMANDE POUR VALIDATION MANUELLE
    await db.collection('pending_deposits').add({
      userId: userId,
      amount: parseFloat(amount),
      currency: currency || 'USD',
      grantId: ezipayResponse.data.data.grant_id,
      status: 'pending_payment',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Demande sauvegardée dans pending_deposits');

    res.json({
      success: true,
      payment_url: ezipayResponse.data.data.payment_url
    });
  } catch (error) {
    console.error('❌ create-deposit error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== CREATE WITHDRAWAL =====
app.post('/api/create-withdrawal', async (req, res) => {
  const { userId, amount, currency, emailOrPhone, paymentMethodId } = req.body;

  console.log('💸 CREATE WITHDRAWAL:', { userId, amount, emailOrPhone });

  if (!userId || !amount || parseFloat(amount) <= 0 || !emailOrPhone || !paymentMethodId) {
    return res.status(400).json({ success: false, error: 'Paramètres invalides' });
  }

  try {
    const token = await getEziPayToken();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const balance = userDoc.data()?.balance || 0;
    const fees = parseFloat(amount) * 0.06;
    const totalDebit = parseFloat(amount) + fees;

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
    await userRef.update({ balance: newBalance });

    await userRef.collection('transactions').add({
      type: 'withdrawal',
      amount: parseFloat(amount),
      fees,
      totalDebit,
      status: 'completed',
      emailOrPhone,
      date: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Retrait effectué');

    res.json({ success: true, totalDebit, newBalance });
  } catch (error) {
    console.error('❌ withdrawal error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur port ${PORT}`));
