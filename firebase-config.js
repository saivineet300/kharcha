// Firebase settings for the website version of Kharcha (Google sign-in + shared books).
// Paste the config from Firebase console → Project settings → Your apps → Web app.
// These values are meant to be public; your data is protected by firestore.rules.
// Leave it as null and the website works without accounts, saving to this browser only.
window.KHARCHA_FIREBASE = null;

// Example (replace with your own):
// window.KHARCHA_FIREBASE = {
//   apiKey: 'AIza...',
//   authDomain: 'your-project.firebaseapp.com',
//   projectId: 'your-project',
//   storageBucket: 'your-project.firebasestorage.app',
//   messagingSenderId: '1234567890',
//   appId: '1:1234567890:web:abc123',
// };
