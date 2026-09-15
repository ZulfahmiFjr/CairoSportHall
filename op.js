import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import {
    getDatabase,
    ref,
    set,
    update,
    onValue,
    onDisconnect,
    query,
    orderByChild,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

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

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const dashboardContainer = document.getElementById('dashboard-container');
const opDashboardContainer = document.getElementById('op-dashboard-container');
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
const ACTIVE_SESSION_WINDOW_MS = 30000;
const SESSION_KEY = 'cairo_session_id';
const DEVICE_KEY = 'cairo_device_id';
const relayStatusSeen = {};
const namaSaklarMapOp = {};

let currentSessionRef = null;
let currentSessionId = '';
let currentUserProfile = null;
let sessionHeartbeatId = null;
let sessionForceLogoutUnsub = null;
let roleUnsubscribes = [];
let forcedLogoutActive = false;

if (sessionAccountHeader) sessionAccountHeader.innerText = 'Device ID';

for (let i = 1; i <= 8; i++) {
    namaSaklarMapOp[i] = `Saklar ${i}`;
}

function getSessionId() {
    let sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
        sessionId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(SESSION_KEY, sessionId);
    }
    return sessionId;
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
    return Number(session.lastSeen || session.lastActive || 0);
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
}

function cleanupCurrentSession(markOfflineOnly = false) {
    if (sessionHeartbeatId) clearInterval(sessionHeartbeatId);
    sessionHeartbeatId = null;
    if (sessionForceLogoutUnsub) {
        sessionForceLogoutUnsub();
        sessionForceLogoutUnsub = null;
    }
    if (!currentSessionRef) return Promise.resolve();

    const now = Date.now();
    const payload = {
        online: false,
        lastSeen: now,
        lastActive: now,
        logoutAt: now
    };

    return update(currentSessionRef, payload).catch((error) => {
        console.error('Gagal memperbarui status sesi:', error);
    }).finally(() => {
        if (!markOfflineOnly) localStorage.removeItem(SESSION_KEY);
        currentSessionRef = null;
    });
}

function setupSession(user) {
    currentSessionId = getSessionId();
    const username = getUsername(user);
    const role = getRole(user);
    const deviceId = getDeviceId();
    const deviceInfo = getDeviceInfo();

    currentUserProfile = {
        uid: user.uid,
        username,
        role,
        email: user.email || '',
        sessionId: currentSessionId,
        deviceId,
        ...deviceInfo
    };

    currentSessionRef = ref(db, `sessions/${user.uid}/${currentSessionId}`);
    const now = Date.now();
    const sessionPayload = {
        uid: user.uid,
        username,
        role,
        deviceId,
        deviceName: deviceInfo.deviceName,
        browser: deviceInfo.browser,
        os: deviceInfo.os,
        createdAt: now,
        lastSeen: now,
        online: true,
        sessionId: currentSessionId,
        email: user.email || '',
        loginAt: now,
        lastActive: now,
        forceLogout: false,
        logoutRequestedBy: '',
        userAgent: deviceInfo.userAgent
    };

    set(currentSessionRef, sessionPayload).catch((error) => {
        console.error('Gagal mencatat sesi login:', error);
    });
    onDisconnect(currentSessionRef).update({
        online: false,
        lastSeen: Date.now(),
        lastActive: Date.now()
    });

    if (sessionHeartbeatId) clearInterval(sessionHeartbeatId);
    sessionHeartbeatId = setInterval(() => {
        if (!currentSessionRef) return;
        const heartbeatAt = Date.now();
        update(currentSessionRef, {
            online: true,
            lastSeen: heartbeatAt,
            lastActive: heartbeatAt
        }).catch((error) => {
            console.error('Gagal memperbarui heartbeat sesi:', error);
        });
    }, SESSION_HEARTBEAT_MS);

    if (sessionForceLogoutUnsub) sessionForceLogoutUnsub();
    sessionForceLogoutUnsub = onValue(currentSessionRef, (snapshot) => {
        const data = snapshot.val();
        if (!data || data.forceLogout !== true || forcedLogoutActive) return;
        forcedLogoutActive = true;
        cleanupCurrentSession(true).finally(() => signOut(auth));
    });
}

function routeByRole(user) {
    const username = getUsername(user);
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

    const unsubSessions = onValue(ref(db, 'sessions'), (snapshot) => {
        renderSessions(snapshot.val() || {});
    }, (error) => {
        console.error('Gagal memuat sesi login:', error);
        renderSessionError();
    });
    roleUnsubscribes.push(unsubSessions);

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
    const sessions = flattenSessions(data);
    const now = Date.now();
    const activeSessions = sessions.filter((session) => {
        return session.online === true || now - getSessionLastSeen(session) <= ACTIVE_SESSION_WINDOW_MS;
    });

    if (opSessionCount) opSessionCount.innerText = String(activeSessions.length);
    if (!sessions.length) {
        sessionTableBody.innerHTML = '<tr><td colspan="7" class="op-empty-cell">Belum ada device yang tercatat login.</td></tr>';
        return;
    }

    sessionTableBody.innerHTML = sessions.map((session) => {
        const isCurrentSession = currentUserProfile
            && session.uid === currentUserProfile.uid
            && session.sessionId === currentUserProfile.sessionId;
        const isActive = session.online === true || now - getSessionLastSeen(session) <= ACTIVE_SESSION_WINDOW_MS;
        const statusClass = isActive ? 'op-pill-online' : 'op-pill-offline';
        const statusText = isActive ? 'Online' : 'Offline';
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
                <td>${escapeHtml(log.actorUsername || '-')}</td>
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

        update(ref(db, `sessions/${uid}/${sessionId}`), {
            forceLogout: true,
            logoutRequestedAt: Date.now(),
            logoutRequestedBy: currentUserProfile.username
        }).catch((error) => {
            console.error('Gagal mengirim logout device:', error);
            button.disabled = false;
            button.innerText = 'Logout';
        });
    });
}

if (btnOpLogout) {
    btnOpLogout.addEventListener('click', () => {
        cleanupCurrentSession().finally(() => signOut(auth));
    });
}

window.addEventListener('beforeunload', () => {
    if (!currentSessionRef) return;
    const now = Date.now();
    update(currentSessionRef, {
        online: false,
        lastSeen: now,
        lastActive: now
    });
});

onAuthStateChanged(auth, (user) => {
    clearRoleListeners();
    forcedLogoutActive = false;

    if (!user) {
        if (opDashboardContainer) opDashboardContainer.style.display = 'none';
        cleanupCurrentSession();
        currentUserProfile = null;
        return;
    }

    setupSession(user);
    routeByRole(user);
});
