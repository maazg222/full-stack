const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

let serviceAccount;

// Check if we have Firebase config in environment variables
if (process.env.FIREBASE_PROJECT_ID) {
  serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
  };
} else {
  // Fallback to file for local development if env vars are not set
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  try {
    if (fs.existsSync(keyPath)) {
      const rawData = fs.readFileSync(keyPath);
      serviceAccount = JSON.parse(rawData);
      console.log('Firebase serviceAccountKey.json loaded successfully.');
    } else {
      console.error('Firebase configuration not found in environment variables or serviceAccountKey.json');
    }
  } catch (err) {
    console.error('Error loading serviceAccountKey.json:', err.message);
  }
}

if (serviceAccount) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('Firebase Admin initialized successfully.');
    } else {
      console.log('Firebase Admin already initialized.');
    }
  } catch (initErr) {
    console.error('Firebase initialization failed:', initErr.message);
  }
} else {
  // Fallback or placeholder for initial setup
  console.log('Firebase Admin will not be initialized until serviceAccountKey.json is provided.');
}

const db = serviceAccount ? admin.firestore() : null;
const auth = serviceAccount ? admin.auth() : null;

module.exports = { admin, db, auth };
