const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration Firebase Admin SDK
// Railway utilisera la variable d'environnement FIREBASE_SERVICE_ACCOUNT
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error('Error parsing Firebase credentials:', error);
  throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Configuration EziPay
const BASE_URL = process.env.EZIPAY_BASE_URL || 'https://sandbox.ezipaywallet.com/merchant/api';
const CLIENT_ID = process.env.EZIPAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EZIPAY_CLIENT_SECRET;

// Cache du token
let accessToken = null;
let tokenExpiry = null;

// Fonction pour obtenir le token d'accès
async function getAccessToken() {
  try {
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
      return accessToken;
    }

    const response = await axios.post(`${BASE_URL}/access-token`, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    if (response.data.status === 'success') {
      accessToken = response.data.data.access_token;
      tokenExpiry = Date.now() + (2 * 60 * 60 * 1000);
      return accessToken;
    }
    throw new Error('Failed to get access token');
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

// Route santé
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'EziPay API Server is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is healthy' });
});

// Route pour créer un paiement (dépôt)
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, currency, metadata, userId } = req.body;
    
    if (!amount || !currency) {
      return res.status(400).json({ error: 'Amount and currency are required' });
    }

    const token = await getAccessToken();
    
    const response = await axios.post(
      `${BASE_URL}/transaction/create`,
      {
        amount: parseInt(amount),
        currency: currency,
        successUrl: `${process.env.APP_URL || 'https://your-app.railway.app'}/payment/success`,
        cancelUrl: `${process.env.APP_URL || 'https://your-app.railway.app'}/payment/cancel`,
        metadata: metadata ? JSON.stringify(metadata) : null
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Sauvegarder dans Firestore
    if (response.data.status === 'success') {
      await db.collection('payments').add({
        grant_id: response.data.data.grant_id,
        token: response.data.data.token,
        amount: parseInt(amount),
        currency: currency,
        userId: userId || null,
        metadata: metadata || null,
        status: 'pending',
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error('Error creating payment:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create payment',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour vérifier le statut d'un paiement
app.get('/api/payment/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const token = await getAccessToken();

    const response = await axios.get(
      `${BASE_URL}/transaction/get/${transactionId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    // Mettre à jour dans Firestore
    if (response.data && !response.data.error) {
      const paymentsRef = db.collection('payments');
      const snapshot = await paymentsRef.where('grant_id', '==', transactionId).limit(1).get();
      
      if (!snapshot.empty) {
        await snapshot.docs[0].ref.update({
          status: response.data.data.status.toLowerCase(),
          transaction_id: transactionId,
          fees: response.data.data.fees,
          updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.json(response.data);
  } catch (error) {
    console.error('Error getting payment status:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to get payment status',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour obtenir les méthodes de paiement
app.post('/api/payment-methods', async (req, res) => {
  try {
    const { currency } = req.body;
    
    if (!currency) {
      return res.status(400).json({ error: 'Currency is required' });
    }

    const token = await getAccessToken();

    const response = await axios.post(
      `${BASE_URL}/send-money/get/payment-methods`,
      { currency: currency },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error getting payment methods:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to get payment methods',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour vérifier un destinataire
app.post('/api/verify-receiver', async (req, res) => {
  try {
    const { email_or_phone } = req.body;
    
    if (!email_or_phone) {
      return res.status(400).json({ error: 'Email or phone is required' });
    }

    const token = await getAccessToken();

    const response = await axios.post(
      `${BASE_URL}/send-money/verify-receiver`,
      { email_or_phone: email_or_phone },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error verifying receiver:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to verify receiver',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour créer une demande de retrait
app.post('/api/withdrawal/request', async (req, res) => {
  try {
    const { email_or_phone, currency, amount, payment_method_id, moncash_account_number, userId, userEmail } = req.body;
    
    if (!email_or_phone || !currency || !amount || !payment_method_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Vérifier le destinataire
    const token = await getAccessToken();
    const verifyResponse = await axios.post(
      `${BASE_URL}/send-money/verify-receiver`,
      { email_or_phone: email_or_phone },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (verifyResponse.data.status !== 'success') {
      return res.status(400).json({ error: 'Invalid receiver' });
    }

    // Créer la demande dans Firestore
    const withdrawalRef = await db.collection('withdrawals').add({
      email_or_phone,
      currency,
      amount: parseInt(amount),
      payment_method_id: parseInt(payment_method_id),
      moncash_account_number: moncash_account_number || null,
      userId: userId || null,
      userEmail: userEmail || null,
      receiver_info: verifyResponse.data.data,
      status: 'pending',
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      processed_at: null,
      processed_by: null
    });

    res.json({
      status: 'success',
      message: 'Withdrawal request submitted. Waiting for admin approval.',
      data: {
        withdrawal_id: withdrawalRef.id,
        status: 'pending'
      }
    });
  } catch (error) {
    console.error('Error creating withdrawal request:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create withdrawal request',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour obtenir toutes les demandes de retrait (Admin)
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    
    let query = db.collection('withdrawals').orderBy('created_at', 'desc');
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    query = query.limit(parseInt(limit));
    
    const snapshot = await query.get();
    
    const withdrawals = [];
    snapshot.forEach(doc => {
      withdrawals.push({
        id: doc.id,
        ...doc.data(),
        created_at: doc.data().created_at?.toDate().toISOString(),
        processed_at: doc.data().processed_at?.toDate().toISOString()
      });
    });

    res.json({
      status: 'success',
      data: withdrawals
    });
  } catch (error) {
    console.error('Error fetching withdrawals:', error.message);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// Route pour approuver un retrait (Admin)
app.post('/api/admin/withdrawal/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;
    
    const withdrawalRef = db.collection('withdrawals').doc(id);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const withdrawal = withdrawalDoc.data();

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }

    // Exécuter le transfert via EziPay
    const token = await getAccessToken();
    
    const requestData = {
      email_or_phone: withdrawal.email_or_phone,
      currency: withdrawal.currency,
      amount: withdrawal.amount,
      payment_method_id: withdrawal.payment_method_id
    };

    if (withdrawal.moncash_account_number) {
      requestData.moncash_account_number = withdrawal.moncash_account_number;
    }

    const response = await axios.post(
      `${BASE_URL}/send-money/create`,
      requestData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Mettre à jour le statut dans Firestore
    await withdrawalRef.update({
      status: 'approved',
      processed_at: admin.firestore.FieldValue.serverTimestamp(),
      processed_by: adminId || 'admin',
      ezipay_response: response.data
    });

    const updatedDoc = await withdrawalRef.get();
    const updatedData = {
      id: updatedDoc.id,
      ...updatedDoc.data(),
      created_at: updatedDoc.data().created_at?.toDate().toISOString(),
      processed_at: updatedDoc.data().processed_at?.toDate().toISOString()
    };

    res.json({
      status: 'success',
      message: 'Withdrawal approved and processed',
      data: updatedData
    });
  } catch (error) {
    console.error('Error approving withdrawal:', error.response?.data || error.message);
    
    // Marquer comme échoué
    try {
      await db.collection('withdrawals').doc(req.params.id).update({
        status: 'failed',
        processed_at: admin.firestore.FieldValue.serverTimestamp(),
        error_message: error.response?.data?.message || error.message
      });
    } catch (updateError) {
      console.error('Error updating failed status:', updateError);
    }

    res.status(500).json({ 
      error: 'Failed to process withdrawal',
      details: error.response?.data || error.message 
    });
  }
});

// Route pour rejeter un retrait (Admin)
app.post('/api/admin/withdrawal/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, adminId } = req.body;
    
    const withdrawalRef = db.collection('withdrawals').doc(id);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const withdrawal = withdrawalDoc.data();

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }

    await withdrawalRef.update({
      status: 'rejected',
      processed_at: admin.firestore.FieldValue.serverTimestamp(),
      processed_by: adminId || 'admin',
      rejection_reason: reason || 'No reason provided'
    });

    const updatedDoc = await withdrawalRef.get();
    const updatedData = {
      id: updatedDoc.id,
      ...updatedDoc.data(),
      created_at: updatedDoc.data().created_at?.toDate().toISOString(),
      processed_at: updatedDoc.data().processed_at?.toDate().toISOString()
    };

    res.json({
      status: 'success',
      message: 'Withdrawal rejected',
      data: updatedData
    });
  } catch (error) {
    console.error('Error rejecting withdrawal:', error.message);
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

// Route pour obtenir le statut d'une demande de retrait
app.get('/api/withdrawal/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const withdrawalDoc = await db.collection('withdrawals').doc(id).get();

    if (!withdrawalDoc.exists) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const withdrawal = withdrawalDoc.data();

    res.json({
      status: 'success',
      data: {
        withdrawal_id: id,
        status: withdrawal.status,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        created_at: withdrawal.created_at?.toDate().toISOString(),
        processed_at: withdrawal.processed_at?.toDate().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching withdrawal status:', error.message);
    res.status(500).json({ error: 'Failed to fetch withdrawal status' });
  }
});

// Route pour obtenir les statistiques (Admin)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const withdrawalsRef = db.collection('withdrawals');
    
    const [totalSnap, pendingSnap, approvedSnap, rejectedSnap] = await Promise.all([
      withdrawalsRef.get(),
      withdrawalsRef.where('status', '==', 'pending').get(),
      withdrawalsRef.where('status', '==', 'approved').get(),
      withdrawalsRef.where('status', '==', 'rejected').get()
    ]);

    res.json({
      status: 'success',
      data: {
        total: totalSnap.size,
        pending: pendingSnap.size,
        approved: approvedSnap.size,
        rejected: rejectedSnap.size,
        failed: totalSnap.docs.filter(doc => doc.data().status === 'failed').length
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔥 Firestore connected`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
});
