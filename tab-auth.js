// Keep Firebase authentication isolated to this tab, including logout.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { initializeAuth, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyCIPJKs36oEABoh_tRbMEpOELhGyx-Bq40",
    authDomain: "cairosporthall.firebaseapp.com",
    databaseURL: "https://cairosporthall-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "cairosporthall",
    storageBucket: "cairosporthall.firebasestorage.app",
    messagingSenderId: "180648731836",
    appId: "1:180648731836:web:c223df91836d6cdd821cb9",
    measurementId: "G-0PP7BPGX9G"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = initializeAuth(app, { persistence: browserSessionPersistence });

// Only expose the dashboard after the server-side tab session has been checked.
const listeners = new Set();
let verifiedUser = null;
export function onTabAuthStateChanged(_auth, callback) {
    listeners.add(callback);
    callback(verifiedUser);
    return () => listeners.delete(callback);
}
export function publishTabUser(user) {
    verifiedUser = user;
    for (const callback of listeners) callback(user);
}

// Do not allow a new login to race the previous tab's asynchronous sign-out.
export let tabLogoutPending = false;
export function setTabLogoutPending(value) { tabLogoutPending = value; }
