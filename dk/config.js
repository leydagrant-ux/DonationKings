// config.js: the two things that have to be filled in before leagues can be
// shared between devices. Until then the app runs entirely in the browser,
// which is a working app, just a single-player one.
//
// None of this is secret. A Firebase web config is public by design: it
// identifies the project, it does not authorize anything. What authorizes a
// request is the signed ID token, which the Worker verifies against Google's
// keys on every call.

/* 1. Firebase, for sign-in only. Console -> Project settings -> Your apps ->
 *    Web app -> SDK setup and configuration -> Config.
 *    Enable Email/Password under Authentication -> Sign-in method, and add
 *    your site to Authentication -> Settings -> Authorized domains. */
export const FIREBASE = {
  apiKey: 'AIzaSyDmFS48qkPpp10joPoVSQ-WOw9g1Z0X9YI',
  authDomain: 'donationkings.firebaseapp.com',
  projectId: 'donationkings',
  appId: '1:403792935207:web:03ae0c5c0f578fd7aad102',
};

/* 2. The Worker's URL, printed by `npx wrangler deploy`. For local work
 *    against `npx wrangler dev --local`, use http://127.0.0.1:8787 */
export const API_URL = 'https://donationkings-api.leydagrant.workers.dev';

/** True once both halves are filled in. */
export const isConfigured = () =>
  FIREBASE.apiKey !== 'PASTE_ME' && FIREBASE.projectId !== 'PASTE_ME' && !!API_URL;

/** The Firebase SDK version loaded from Google's CDN. Pinned on purpose. */
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
