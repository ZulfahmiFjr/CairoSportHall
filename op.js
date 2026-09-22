import {
    ref, child, set, get, update, onValue, onDisconnect, runTransaction, serverTimestamp,
    query, orderByChild, limitToLast
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";
import { db, auth, publishTabUser, setTabLogoutPending } from './tab-auth.js';

const dashboardContainer = document.getElementById('dashboard-container');
const opDashboardContainer = document.getElementById('op-dashboard-container');
const btnAdminLogout = document.getElementById('btn-logout');
const btnOpLogout = document.getElementById('btn-op-logout');
const opUsername = document.getElementById('op-username');
const opRole = document.getElementById('op-role');
const opConnStatus = document.getElementById('op-conn-status');
const opSessionCount = document.getElementById('op-session-count');
const opLogCount = document.getElementById('op-log-count');
const sessionTableBody = document.getElementById('session-table-body');
const activityLogTableBody = document.getElementById('activity-log-table-body');
const sessionAccountHeader = sessionTableBody?.closest('table')?.querySelector('thead th:first-child');

const SESSION_HEARTBEAT_MS = 5000;
const SESSION_KEY = 'cairo_tab_session_id';
const SESSION_TIMEOUT_MS = 20000;
const DEVICE_KEY = 'cairo_device_id';
const PENDING_LOGOUT_KEY = 'cairo_pending_logouts_v2';
const relayStatusSeen = {};
const namaSaklarMapOp = {};

let currentSessionRef = null;
let currentSessionId = '';
let currentUserProfile = null;
let sessionHeartbeatId = null;
let sessionForceLogoutUnsub = null;
let roleUnsubscribes = [];
let forcedLogoutActive = false;
let firebaseConnected = false;
let serverOffset = 0;
let authGeneration = 0;
let sessionReady = false;
let pendingUser = null;
let disconnectAction = null;
let presenceQueue = Promise.resolve();
let cachedSessions = {};
let sessionRenderTimer = null;
let sessionStarting = false;
let connectionEpoch = 0;
let currentConnectionId = '';
let sessionsLoaded = false;
const pageId = crypto.randomUUID();
let tabChannel = null;
let releaseTabLock = null;
let claimingId = '';
let claimingLost = false;
try { tabChannel = new BroadcastChannel('cairo-tabs-v2'); } catch (_) {}

function newSessionId() { return `web-${crypto.randomUUID()}`; }
function serverNow() { return Date.now() + serverOffset; }
function tabIsActive() {
    return document.visibilityState === 'visible' && document.hasFocus() && navigator.onLine;
}
function sessionIsOnline(session) {
    const age = serverNow() - getSessionLastSeen(session);
    const presence = session.connectionId ? session.connections?.[session.connectionId] : session;
    return firebaseConnected && !session.revoked && !session.forceLogout && presence?.online === true && age >= -5000 && age < SESSION_TIMEOUT_MS;
}

// sessionStorage survives reloads, but duplicated tabs can inherit its contents.
// Probe an existing owner before reusing an ID; every live tab owns its own row.
async function claimSessionId(generation) {
    let id = sessionStorage.getItem(SESSION_KEY);
    const inheritedId = id;
    const assertCurrent = () => {
        if (generation !== authGeneration) throw new Error('Session initialization superseded');
    };
    if (navigator.locks) {
        if (releaseTabLock) releaseTabLock();
        const acquire = candidate => new Promise((resolve, reject) => {
            navigator.locks.request(`cairo-session:${candidate}`, { ifAvailable: true }, lock => {
                if (!lock) { resolve(false); return; }
                return new Promise(release => {
                    releaseTabLock = release;
                    resolve(true);
                });
            }).catch(reject);
        });
        if (id && !(await acquire(id))) id = null;
        const fresh = !id;
        if (!id) { id = newSessionId(); await acquire(id); }
        if (generation !== authGeneration) {
            releaseTabLock?.();
            releaseTabLock = null;
            assertCurrent();
        }
        sessionStorage.setItem(SESSION_KEY, id);
        currentSessionId = id;
        return { id, fresh, inheritedId: inheritedId !== id ? inheritedId : null };
    }
    if (id && tabChannel) {
        claimingId = id;
        claimingLost = false;
        let taken = false;
        const listener = ({ data }) => {
            if (data.type === 'owner' && data.sessionId === id && data.to === pageId) taken = true;
        };
        tabChannel.addEventListener('message', listener);
        tabChannel.postMessage({ type: 'probe', sessionId: id, pageId });
        await new Promise(resolve => setTimeout(resolve, 200));
        tabChannel.removeEventListener('message', listener);
        claimingId = '';
        if (taken || claimingLost) id = null;
    } else if (id && !tabChannel) {
        // Fail closed on browsers unable to distinguish a duplicated tab.
        throw new Error('Browser tidak mendukung isolasi tab. Silakan login ulang.');
    }
    assertCurrent();
    const fresh = !id;
    if (!id) id = newSessionId();
    sessionStorage.setItem(SESSION_KEY, id);
    currentSessionId = id;
    return { id, fresh, inheritedId: inheritedId !== id ? inheritedId : null };
}
if (tabChannel) tabChannel.addEventListener('message', ({ data }) => {
    if (data.type === 'probe' && data.sessionId === claimingId && data.pageId < pageId) claimingLost = true;
    if (data.type === 'probe' && (data.sessionId === currentSessionId || (data.sessionId === claimingId && pageId < data.pageId)) && data.pageId !== pageId) {
        tabChannel.postMessage({ type: 'owner', sessionId: data.sessionId, to: data.pageId });
    }
});

if (sessionAccountHeader) sessionAccountHeader.innerText = 'Device ID';

for (let i = 1; i <= 8; i++) {
    namaSaklarMapOp[i] = `Saklar ${i}`;
}

function getDeviceId() {
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) {
        const bytes = new Uint8Array(3);
        if (window.crypto?.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        const suffix = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
        deviceId = `CSH-${suffix}`;
        localStorage.setItem(DEVICE_KEY, deviceId);
    }
    return deviceId;
}

function getUsername(user) {
    return (user.email || '').split('@')[0] || 'user';
}

function getRole(user) {
    return getUsername(user).toLowerCase() === 'op' ? 'op' : 'admin';
}

function getBrowserName() {
    const ua = navigator.userAgent;
    if (ua.includes('Edg/')) return 'Microsoft Edge';
    if (ua.includes('Chrome/')) return 'Chrome';
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
    return 'Browser';
}

function getOperatingSystem() {
    const ua = navigator.userAgent;
    const androidMatch = ua.match(/Android\s([\d.]+)/i);
    if (androidMatch) return `Android ${androidMatch[1]}`;
    const iosMatch = ua.match(/OS\s([\d_]+)/i);
    if (/iPhone|iPad|iPod/i.test(ua)) return `iOS ${iosMatch ? iosMatch[1].replace(/_/g, '.') : ''}`.trim();
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Perangkat';
}

function getDeviceType() {
    const ua = navigator.userAgent;
    if (/iPad|Tablet/i.test(ua)) return 'Tablet';
    if (/Mobi|Android|iPhone/i.test(ua)) return 'HP';
    return 'Desktop';
}

function getDeviceModel() {
    const ua = navigator.userAgent;
    const androidModel = ua.match(/;\s*([^;()]+?)\s+Build\//i);
    if (androidModel && androidModel[1]) {
        const model = androidModel[1].trim();
        return model.startsWith('SM-') ? `Samsung ${model}` : model;
    }
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    return '';
}

function getDeviceInfo() {
    const type = getDeviceType();
    const browser = getBrowserName();
    const os = getOperatingSystem();
    const model = getDeviceModel();
    return {
        deviceName: model || `${type} ${os}`,
        browser,
        os,
        userAgent: navigator.userAgent
    };
}

function formatDateTime(value) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).format(new Date(value));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getSessionCreatedAt(session) {
    return Number(session.createdAt || session.loginAt || 0);
}

function getSessionLastSeen(session) {
    const presence = session.connectionId ? session.connections?.[session.connectionId] : session;
    return Number(presence?.lastSeen || presence?.lastActive || 0);
}

function clearRoleListeners() {
    roleUnsubscribes.forEach((unsub) => {
        try {
            if (typeof unsub === 'function') unsub();
        } catch (error) {
            console.error('Gagal melepas listener role:', error);
        }
    });
    roleUnsubscribes = [];
    if (sessionRenderTimer) clearInterval(sessionRenderTimer);
    sessionRenderTimer = null;
}

// Keep the top-bar logout buttons usable even while revalidating/offline.
function setSessionControlsEnabled(enabled) {
    const controls = ['saklar-container', 'schedule-modal', 'edit-name-modal', 'delete-logs-modal']
        .map(id => document.getElementById(id));
    controls.push(opDashboardContainer?.querySelector?.('.op-shell'));
    for (const control of controls) if (control) control.inert = !enabled;
}

function stopSessionTracking() {
    setSessionControlsEnabled(false);
    sessionReady = false;
    if (sessionHeartbeatId) clearInterval(sessionHeartbeatId);
    sessionHeartbeatId = null;
    if (sessionForceLogoutUnsub) sessionForceLogoutUnsub();
    sessionForceLogoutUnsub = null;
}

function pendingLogouts() {
    try { return JSON.parse(localStorage.getItem(PENDING_LOGOUT_KEY) || '{}'); }
    catch (_) { return {}; }
}

function rememberLogout(path) {
    const pending = pendingLogouts();
    pending[path] = true;
    localStorage.setItem(PENDING_LOGOUT_KEY, JSON.stringify(pending));
}

function forgetLogout(path) {
    const pending = pendingLogouts();
    delete pending[path];
    localStorage.setItem(PENDING_LOGOUT_KEY, JSON.stringify(pending));
}

function revocationPayload() {
    return { revoked: true, forceLogout: true, online: false,
        logoutAt: serverTimestamp(), lastSeen: serverTimestamp() };
}

async function flushPendingLogouts(user) {
    const privileged = ['admin@cairo.com', 'op@cairo.com'].includes(user.email);
    for (const path of Object.keys(pendingLogouts())) {
        if (!/^sessions\/[^/]+\/(?:web|tab)-[a-zA-Z0-9-]+$/.test(path)) continue;
        if (!privileged && !path.startsWith(`sessions/${user.uid}/`)) continue;
        await update(ref(db, path), revocationPayload());
        forgetLogout(path);
    }
}

window.addEventListener('storage', event => {
    if (event.key === PENDING_LOGOUT_KEY && pendingUser && firebaseConnected) {
        flushPendingLogouts(pendingUser).catch(console.error);
    }
});

// A dropped connection must not leave the local logout button waiting forever.
async function bounded(promise, timeoutMs = 3000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

async function endTabSession(revoke = true) {
    if (forcedLogoutActive) return;
    forcedLogoutActive = true;
    setTabLogoutPending(true);
    ++authGeneration;
    pendingUser = null;
    stopSessionTracking();
    const sessionRef = currentSessionRef;
    const logoutPath = currentUserProfile && currentSessionId
        ? `sessions/${currentUserProfile.uid}/${currentSessionId}` : null;
    if (revoke && logoutPath) {
        try { rememberLogout(logoutPath); } catch (error) { console.error('Gagal menyimpan antrean logout:', error); }
    }
    currentSessionRef = null;
    publishTabUser(null);
    for (const id of ['schedule-modal', 'edit-name-modal', 'delete-logs-modal']) {
        const modal = document.getElementById(id);
        if (modal) modal.style.display = 'none';
    }
    clearRoleListeners();
    if (opDashboardContainer) opDashboardContainer.style.display = 'none';
    try { sessionStorage.removeItem(SESSION_KEY); } catch (error) { console.error(error); }
    currentSessionId = '';
    if (releaseTabLock) releaseTabLock();
    releaseTabLock = null;
    currentUserProfile = null;
    try {
        if (sessionRef && revoke && firebaseConnected) {
            // Keep a hidden revocation marker: suspended tabs must not recreate a deleted row.
            await bounded(update(sessionRef, revocationPayload()).then(() => forgetLogout(logoutPath)));
        }
    } catch (error) {
        console.error('Gagal mencabut sesi:', error);
    } finally {
        if (disconnectAction && firebaseConnected) {
            // Keep the disconnect handler if the server has not accepted the logout yet.
            if (!logoutPath || !pendingLogouts()[logoutPath]) {
                await bounded(disconnectAction.cancel().catch(console.error));
            }
        }
        disconnectAction = null;
        try { await signOut(auth); }
        finally { setTabLogoutPending(false); }
    }
}

function writePresence() {
    if (!navigator.onLine) setSessionControlsEnabled(false);
    else if (sessionReady) setSessionControlsEnabled(true);
    if (!firebaseConnected || !sessionReady || !currentSessionRef || forcedLogoutActive) return;
    const sessionRef = currentSessionRef;
    const generation = authGeneration;
    const epoch = connectionEpoch;
    const active = tabIsActive();
    const connectionId = currentConnectionId;
    presenceQueue = presenceQueue.catch(() => {}).then(async () => {
        if (!firebaseConnected || generation !== authGeneration || epoch !== connectionEpoch || !sessionReady) return;
        const result = await runTransaction(sessionRef, data => {
            if (generation !== authGeneration || epoch !== connectionEpoch || !sessionReady || !data || data.revoked || data.forceLogout) return;
            return { ...data, online: active, lastSeen: serverTimestamp(), connectionId,
                connections: { [connectionId]: { online: active, lastSeen: serverTimestamp() } },
                lastActive: active ? serverTimestamp() : data.lastActive };
        }, { applyLocally: false });
        if (generation !== authGeneration || epoch !== connectionEpoch) return;
        if (!result.committed && (!result.snapshot.exists() || result.snapshot.val()?.revoked || result.snapshot.val()?.forceLogout)) {
            await endTabSession(false);
        }
    }).catch(error => console.error('Gagal memperbarui status tab:', error));
}

async function connectSession(user, generation) {
    const sessionRef = currentSessionRef;
    if (!sessionRef || !firebaseConnected || generation !== authGeneration) return;
    sessionReady = false;
    const epoch = connectionEpoch;
    const profile = currentUserProfile;
    const connectionId = crypto.randomUUID();
    await flushPendingLogouts(user);
    if (generation !== authGeneration || epoch !== connectionEpoch || !firebaseConnected) return;
    if (profile.inheritedId) {
        const inherited = (await get(ref(db, `sessions/${user.uid}/${profile.inheritedId}`))).val();
        if (generation !== authGeneration || epoch !== connectionEpoch || !firebaseConnected) return;
        if (!inherited || inherited.revoked || inherited.forceLogout) {
            await endTabSession(false);
            return;
        }
        profile.inheritedId = null;
    }
    const snapshot = await get(sessionRef);
    if (generation !== authGeneration || epoch !== connectionEpoch || !firebaseConnected) return;
    const saved = snapshot.val();
    if (saved?.revoked || saved?.forceLogout || (!saved && !profile.fresh)) {
        await endTabSession(false);
        return;
    }
    // Disconnect leases are document-specific, so a late event from the page
    // before a refresh cannot mark the replacement page offline.
    const action = onDisconnect(child(sessionRef, `connections/${connectionId}`));
    await action.update({ online: false, lastSeen: serverTimestamp() });
    if (generation !== authGeneration || epoch !== connectionEpoch || !firebaseConnected) return;
    disconnectAction = action;
    const result = await runTransaction(sessionRef, data => {
        if (generation !== authGeneration || epoch !== connectionEpoch || !firebaseConnected || data?.revoked || data?.forceLogout) return;
        return {
            ...profile.payload, ...(data || {}),
            online: tabIsActive(), lastSeen: serverTimestamp(), lastActive: serverTimestamp(),
            connectionId, connections: { [connectionId]: { online: tabIsActive(), lastSeen: serverTimestamp() } }
        };
    }, { applyLocally: false });
    if (generation !== authGeneration || epoch !== connectionEpoch) return;
    if (!result.committed) {
        await endTabSession(false);
        return;
    }
    profile.fresh = false;
    if (!firebaseConnected) return;
    currentConnectionId = connectionId;
    sessionReady = true;
    setSessionControlsEnabled(true);
    publishTabUser(user);
    routeByRole(user);
    if (!sessionForceLogoutUnsub) {
        sessionForceLogoutUnsub = onValue(sessionRef, snapshot => {
            if (!sessionReady || generation !== authGeneration) return;
            const data = snapshot.val();
            if (!data || data.revoked || data.forceLogout) endTabSession(false);
        }, error => {
            console.error('Gagal memverifikasi sesi:', error);
            endTabSession(false);
        });
    }
    if (!sessionHeartbeatId) sessionHeartbeatId = setInterval(writePresence, SESSION_HEARTBEAT_MS);
}

async function setupSession(user, generation) {
    const { id, fresh, inheritedId } = await claimSessionId(generation);
    if (generation !== authGeneration) return;
    const username = getUsername(user);
    const role = getRole(user);
    const deviceId = getDeviceId();
    const deviceInfo = getDeviceInfo();
    currentUserProfile = { uid: user.uid, username, role, email: user.email || '', sessionId: id, deviceId, ...deviceInfo, fresh, inheritedId };
    currentUserProfile.payload = {
        uid: user.uid, username, role, deviceId, ...deviceInfo,
        sessionId: id, email: user.email || '',
        createdAt: serverTimestamp(), loginAt: serverTimestamp(),
        forceLogout: false, revoked: false, logoutRequestedBy: ''
    };
    currentSessionRef = ref(db, `sessions/${user.uid}/${id}`);
    await resumeSession();
}

async function resumeSession() {
    if (sessionStarting || !pendingUser || !currentSessionRef || !firebaseConnected) return;
    const generation = authGeneration;
    sessionStarting = true;
    try { await connectSession(pendingUser, generation); }
    catch (error) {
        console.error('Gagal memulai sesi tab:', error);
        if (generation === authGeneration) await endTabSession(false);
    } finally {
        sessionStarting = false;
        if (pendingUser && currentSessionRef && firebaseConnected && !sessionReady) {
            setTimeout(resumeSession, 250);
        }
    }
}

onValue(ref(db, '.info/serverTimeOffset'), snapshot => {
    serverOffset = Number(snapshot.val()) || 0;
});
onValue(ref(db, '.info/connected'), snapshot => {
    ++connectionEpoch;
    presenceQueue = Promise.resolve();
    firebaseConnected = snapshot.val() === true;
    if (firebaseConnected) resumeSession();
    else {
        sessionReady = false;
        setSessionControlsEnabled(false);
    }
});
for (const event of ['focus', 'blur', 'pageshow', 'online', 'offline']) window.addEventListener(event, writePresence);
document.addEventListener('visibilitychange', writePresence);
window.addEventListener('pagehide', () => {
    // Best effort only. Server-side onDisconnect remains authoritative on abrupt termination.
    if (currentSessionRef && currentConnectionId && firebaseConnected && !forcedLogoutActive) {
        update(child(currentSessionRef, `connections/${currentConnectionId}`), { online: false, lastSeen: serverTimestamp() }).catch(console.error);
    }
});

function routeByRole(user) {
    const role = getRole(user);

    if (opUsername) {
        const usernamePill = opUsername.closest('.op-profile-pill');
        if (usernamePill) usernamePill.remove();
        else opUsername.innerText = '';
    }
    if (opRole) opRole.innerText = role.toUpperCase();

    if (role === 'op') {
        if (dashboardContainer) dashboardContainer.style.display = 'none';
        if (opDashboardContainer) opDashboardContainer.style.display = 'flex';
        startOperatorPanel();
    } else {
        if (opDashboardContainer) opDashboardContainer.style.display = 'none';
        if (dashboardContainer) dashboardContainer.style.display = 'flex';
        startAdminAuditLogging();
    }
}

function startOperatorPanel() {
    clearRoleListeners();

    const connectedRef = ref(db, '.info/connected');
    const unsubConnected = onValue(connectedRef, (snapshot) => {
        const connected = snapshot.val() === true && navigator.onLine;
        if (!opConnStatus) return;
        opConnStatus.innerText = connected ? 'Firebase: Terhubung' : 'Firebase: Terputus';
        opConnStatus.className = connected ? 'connection-status status-online' : 'connection-status status-offline';
    });
    roleUnsubscribes.push(unsubConnected);

    const unsubNama = onValue(ref(db, 'nama_saklar'), (snapshot) => {
        const data = snapshot.val() || {};
        for (let i = 1; i <= 8; i++) {
            const customName = data[`relay${i}`];
            namaSaklarMapOp[i] = typeof customName === 'string' && customName.trim()
                ? customName.trim()
                : `Saklar ${i}`;
        }
    });
    roleUnsubscribes.push(unsubNama);

    sessionsLoaded = false;
    const unsubSessions = onValue(ref(db, 'sessions'), (snapshot) => {
        sessionsLoaded = true;
        cachedSessions = snapshot.val() || {};
        renderSessions(cachedSessions);
    }, (error) => {
        sessionsLoaded = false;
        if (opSessionCount) opSessionCount.innerText = '-';
        console.error('Gagal memuat sesi login:', error);
        renderSessionError();
    });
    roleUnsubscribes.push(unsubSessions);
    sessionRenderTimer = setInterval(() => { if (sessionsLoaded) renderSessions(cachedSessions); }, 1000);

    const activityQuery = query(ref(db, 'activity_logs'), orderByChild('createdAt'), limitToLast(80));
    const unsubLogs = onValue(activityQuery, (snapshot) => {
        renderActivityLogs(snapshot.val() || {});
    }, (error) => {
        console.error('Gagal memuat log aktivitas:', error);
        renderLogError();
    });
    roleUnsubscribes.push(unsubLogs);
}

function startAdminAuditLogging() {
    clearRoleListeners();

    const unsubNama = onValue(ref(db, 'nama_saklar'), (snapshot) => {
        const data = snapshot.val() || {};
        for (let i = 1; i <= 8; i++) {
            const customName = data[`relay${i}`];
            namaSaklarMapOp[i] = typeof customName === 'string' && customName.trim()
                ? customName.trim()
                : `Saklar ${i}`;
        }
    });
    roleUnsubscribes.push(unsubNama);

    for (let i = 1; i <= 8; i++) {
        const unsubStatus = onValue(ref(db, `status/relay${i}`), (snapshot) => {
            const value = snapshot.val();
            if (!value || typeof value !== 'object') return;

            const nextState = value.state === 1 ? 1 : 0;
            const ackSeq = Number(value.ackSeq || 0);
            const previous = relayStatusSeen[i];
            relayStatusSeen[i] = { state: nextState, ackSeq };

            if (!previous || (previous.state === nextState && previous.ackSeq === ackSeq)) return;
            writeRelayActivityLog(i, nextState, ackSeq);
        });
        roleUnsubscribes.push(unsubStatus);
    }
}

function writeRelayActivityLog(relayId, state, ackSeq) {
    if (!currentUserProfile) return;
    const createdAt = Date.now();
    const logId = `${createdAt}-${relayId}-${Math.random().toString(36).slice(2, 8)}`;
    const switchName = namaSaklarMapOp[relayId] || `Saklar ${relayId}`;

    set(ref(db, `activity_logs/${logId}`), {
        createdAt,
        relayId,
        switchName,
        state,
        actionText: state === 1 ? 'Hidup' : 'Mati',
        ackSeq,
        actorUsername: currentUserProfile.username,
        actorRole: currentUserProfile.role,
        actorUid: currentUserProfile.uid,
        deviceId: currentUserProfile.deviceId,
        deviceName: currentUserProfile.deviceName,
        browser: currentUserProfile.browser,
        source: 'status-confirmed'
    }).catch((error) => {
        console.error('Gagal mencatat log saklar:', error);
    });
}

function flattenSessions(data) {
    const sessions = [];
    Object.entries(data).forEach(([uid, userSessions]) => {
        Object.entries(userSessions || {}).forEach(([sessionId, session]) => {
            // Ignore partial records left by old clients' disconnect handlers.
            if (!session || !session.deviceId || (!session.createdAt && !session.loginAt)) return;
            sessions.push({
                uid,
                sessionId,
                ...(session || {})
            });
        });
    });
    return sessions.sort((a, b) => getSessionLastSeen(b) - getSessionLastSeen(a));
}

function renderSessions(data) {
    if (!sessionTableBody) return;
    const sessions = flattenSessions(data).filter(session => !session.revoked && !session.forceLogout);
    const onlineCount = sessions.filter(sessionIsOnline).length;

    if (opSessionCount) opSessionCount.innerText = firebaseConnected ? String(onlineCount) : '-';
    if (!sessions.length) {
        sessionTableBody.innerHTML = '<tr><td colspan="7" class="op-empty-cell">Belum ada device yang tercatat login.</td></tr>';
        return;
    }

    sessionTableBody.innerHTML = sessions.map((session) => {
        const isCurrentSession = currentUserProfile
            && session.uid === currentUserProfile.uid
            && session.sessionId === currentUserProfile.sessionId;
        const isOnline = sessionIsOnline(session);
        const statusClass = isOnline ? 'op-pill-online' : 'op-pill-offline';
        const statusText = !firebaseConnected ? 'Tidak diketahui' : isOnline ? 'Online' : 'Offline';
        const actionText = isCurrentSession ? 'Logout Saya' : 'Logout';
        const deviceIdentifier = session.deviceId || session.uid || '-';
        const uidText = session.uid && session.deviceId ? session.uid : '';

        return `
            <tr>
                <td>
                    <strong>${escapeHtml(deviceIdentifier)}</strong>
                    <span class="op-table-muted">${escapeHtml(uidText)}</span>
                </td>
                <td><span class="op-role-pill">${escapeHtml((session.role || '-').toUpperCase())}</span></td>
                <td>
                    <strong>${escapeHtml(session.deviceName || '-')}</strong>
                    <span class="op-table-muted">${escapeHtml(session.browser || '')} - ${escapeHtml(session.os || '')}</span>
                </td>
                <td>${formatDateTime(getSessionCreatedAt(session))}</td>
                <td>${formatDateTime(getSessionLastSeen(session))}</td>
                <td><span class="op-status-pill ${statusClass}"><span></span>${statusText}</span></td>
                <td>
                    <button class="op-action-btn" data-uid="${escapeHtml(session.uid)}" data-session="${escapeHtml(session.sessionId)}">${actionText}</button>
                </td>
            </tr>
        `;
    }).join('');
}

function renderActivityLogs(data) {
    if (!activityLogTableBody) return;
    const logs = Object.entries(data)
        .map(([id, value]) => ({ id, ...value }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (opLogCount) opLogCount.innerText = String(logs.length);
    if (!logs.length) {
        activityLogTableBody.innerHTML = '<tr><td colspan="6" class="op-empty-cell">Belum ada perubahan saklar yang tercatat.</td></tr>';
        return;
    }

    activityLogTableBody.innerHTML = logs.map((log) => {
        const isOn = log.state === 1;
        return `
            <tr>
                <td>${formatDateTime(log.createdAt)}</td>
                <td>
                    <strong>${escapeHtml(log.switchName || `Saklar ${log.relayId || '-'}`)}</strong>
                    <span class="op-table-muted">Relay ${escapeHtml(log.relayId || '-')}</span>
                </td>
                <td><span class="op-state-pill ${isOn ? 'op-state-on' : 'op-state-off'}">${isOn ? 'ON' : 'OFF'}</span></td>
                <td>${escapeHtml(log.deviceId || log.actorUid || '-')}</td>
                <td>${escapeHtml((log.actorRole || '-').toUpperCase())}</td>
                <td>${escapeHtml(log.deviceName || '-')}</td>
            </tr>
        `;
    }).join('');
}

function renderSessionError() {
    if (sessionTableBody) {
        sessionTableBody.innerHTML = '<tr><td colspan="7" class="op-empty-cell">Gagal memuat data device. Periksa rules Firebase.</td></tr>';
    }
}

function renderLogError() {
    if (activityLogTableBody) {
        activityLogTableBody.innerHTML = '<tr><td colspan="6" class="op-empty-cell">Gagal memuat log. Periksa rules Firebase.</td></tr>';
    }
}

if (sessionTableBody) {
    sessionTableBody.addEventListener('click', (event) => {
        const button = event.target.closest('.op-action-btn');
        if (!button || !currentUserProfile) return;

        const uid = button.dataset.uid;
        const sessionId = button.dataset.session;
        button.disabled = true;
        button.innerText = 'Memproses...';
        if (!firebaseConnected) {
            button.disabled = false;
            button.innerText = 'Logout';
            return;
        }

        update(ref(db, `sessions/${uid}/${sessionId}`), {
            online: false,
            revoked: true,
            forceLogout: true,
            logoutAt: serverTimestamp(),
            logoutRequestedAt: serverTimestamp(),
            logoutRequestedBy: currentUserProfile.username
        }).catch((error) => {
            console.error('Gagal mengirim logout device:', error);
            button.disabled = false;
            button.innerText = 'Logout';
        });
    });
}

if (btnAdminLogout) btnAdminLogout.addEventListener('click', () => endTabSession());
if (btnOpLogout) btnOpLogout.addEventListener('click', () => endTabSession());

onAuthStateChanged(auth, user => {
    const generation = ++authGeneration;
    clearRoleListeners();
    stopSessionTracking();
    publishTabUser(null);
    if (opDashboardContainer) opDashboardContainer.style.display = 'none';
    forcedLogoutActive = false;
    pendingUser = user;
    currentSessionRef = null;
    currentUserProfile = null;
    if (user) setupSession(user, generation).catch(error => {
        if (generation !== authGeneration) return;
        console.error('Gagal menyiapkan sesi tab:', error);
        endTabSession(false);
    });
});
