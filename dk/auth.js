// auth.js: Firebase sign-in, and nothing else.
//
// Firebase is used purely for identity. No app data goes near it: leagues,
// locks and money all live in D1 behind the Worker, which verifies the ID
// token this module hands out.
//
// The SDK is imported from Google's CDN on demand rather than loaded by a
// script tag, so a browser that never signs in never pays for it. Same shape
// as the sibling bankroll app.

import { FIREBASE, FIREBASE_SDK, isConfigured } from './config.js';

let app = null;
let auth = null;
let sdk = null;
let ready = null;

/** Load and initialize the SDK once. Returns null when nothing is configured. */
async function init() {
  if (!isConfigured()) return null;
  if (ready) return ready;
  ready = (async () => {
    const [appMod, authMod] = await Promise.all([
      import(`${FIREBASE_SDK}/firebase-app.js`),
      import(`${FIREBASE_SDK}/firebase-auth.js`),
    ]);
    sdk = authMod;
    app = appMod.initializeApp(FIREBASE);
    auth = authMod.getAuth(app);
    // Survive a reload and a home-screen launch without signing in again.
    try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch { /* default is fine */ }
    return auth;
  })();
  return ready;
}

/**
 * Watch the signed-in user. Fires immediately with the current state, then on
 * every change. Returns an unsubscribe function, or a no-op when Firebase is
 * not configured.
 */
export async function onAuth(cb) {
  const a = await init();
  if (!a) { cb(null); return () => {}; }
  return sdk.onAuthStateChanged(a, (user) => {
    cb(user ? { uid: user.uid, email: user.email, name: user.displayName || null } : null);
  });
}

/**
 * A fresh ID token for the Worker.
 *
 * Firebase refreshes these roughly hourly; asking for one per request is the
 * documented way to use them and is cached internally, so this is cheap.
 */
export async function token() {
  const a = await init();
  if (!a || !a.currentUser) return null;
  return a.currentUser.getIdToken();
}

/** Human-readable failures. Firebase's own codes are not for showing people. */
function readable(e) {
  const code = (e && e.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'That email and password do not match an account.';
  }
  if (code.includes('email-already-in-use')) return 'There is already an account with that email. Try signing in.';
  if (code.includes('weak-password')) return 'That password is too short. Use at least six characters.';
  if (code.includes('invalid-email')) return 'That does not look like an email address.';
  if (code.includes('network')) return 'Could not reach the sign-in service. Check your connection.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute and try again.';
  return 'Sign-in failed. Try again.';
}

export async function signIn(email, password) {
  const a = await init();
  if (!a) return { ok: false, error: 'Sign-in is not set up yet.' };
  try {
    const cred = await sdk.signInWithEmailAndPassword(a, email.trim(), password);
    return { ok: true, uid: cred.user.uid };
  } catch (e) {
    return { ok: false, error: readable(e) };
  }
}

export async function signUp(email, password, name) {
  const a = await init();
  if (!a) return { ok: false, error: 'Sign-in is not set up yet.' };
  try {
    const cred = await sdk.createUserWithEmailAndPassword(a, email.trim(), password);
    if (name) {
      try { await sdk.updateProfile(cred.user, { displayName: name }); } catch { /* the Worker stores the name anyway */ }
    }
    return { ok: true, uid: cred.user.uid };
  } catch (e) {
    return { ok: false, error: readable(e) };
  }
}

export async function signOut() {
  const a = await init();
  if (a) await sdk.signOut(a);
}

export async function resetPassword(email) {
  const a = await init();
  if (!a) return { ok: false, error: 'Sign-in is not set up yet.' };
  try {
    await sdk.sendPasswordResetEmail(a, email.trim());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readable(e) };
  }
}
