// ngambil fungsi fungsi penting dari firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, set, onValue, get } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

// config dari firebasenyaa
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

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('login-error');
const container = document.getElementById('saklar-container');
const connStatusEl = document.getElementById('conn-status');
const deviceStatusEl = document.getElementById('device-status');

const scheduleModal = document.getElementById('schedule-modal');
const modalTitle = document.getElementById('modal-title');
const modalSwitchName = document.getElementById('modal-switch-name');
const btnEditSwitchName = document.getElementById('btn-edit-switch-name');
const scheduleActive = document.getElementById('schedule-active');
const timeOn = document.getElementById('time-on');
const timeOff = document.getElementById('time-off');
const btnCancelSchedule = document.getElementById('btn-cancel-schedule');
const btnSaveSchedule = document.getElementById('btn-save-schedule');
const scheduleFieldsGroup = document.getElementById('schedule-fields-group');
const toggleSubtext = document.getElementById('toggle-subtext');

const editNameModal = document.getElementById('edit-name-modal');
const editNameTitle = document.getElementById('edit-name-title');
const editNameDesc = document.getElementById('edit-name-desc');
const inputSwitchName = document.getElementById('input-switch-name');
const btnCancelEditName = document.getElementById('btn-cancel-edit-name');
const btnSaveEditName = document.getElementById('btn-save-edit-name');

const DEVICE_STARTUP_GRACE_MS = 3000;
const DEVICE_OFFLINE_TIMEOUT_MS = 7000;
const COMMAND_ACK_TIMEOUT_MS = 3000;
const COMMAND_REENABLE_DELAY_MS = 300;

let relayJadwalAktif = 0;
let relayEditNamaAktif = 0;
let isOnline = navigator.onLine;
let isDeviceOnline = false;
let waktuDetakTerakhir = 0;
let waktuLogin = 0;
let dbUnsubscribes = [];
let heartbeatIntervalId = null;
let countdownIntervalId = null;
let deviceStatusIntervalId = null;
let toastTimeout = null;

const lampCards = [];
const namaSaklarMap = {};
const jadwalMap = {};
const statusRelayMap = {};
const statusKnownMap = {};
const commandSeqMap = {};
const pendingCommandMap = {};
const pendingTimeoutMap = {};

for (let i = 1; i <= 8; i++) {
    namaSaklarMap[i] = `Saklar ${i}`;
    statusRelayMap[i] = 0;
    commandSeqMap[i] = 0;
}

function nextCommandSeq(relayId) {
    const epochSeconds = Math.floor(Date.now() / 1000);
    return Math.max(epochSeconds, (commandSeqMap[relayId] || 0) + 1);
}

function clearPendingCommand(relayId) {
    if (pendingTimeoutMap[relayId]) {
        clearTimeout(pendingTimeoutMap[relayId]);
        pendingTimeoutMap[relayId] = null;
    }
    pendingCommandMap[relayId] = null;
}

function setPendingRelayUI(relayId, targetState, seq) {
    const el = lampCards[relayId];
    if (!el) return;
    const targetLabel = targetState === 1 ? 'ON' : 'OFF';
    el.btn.disabled = true;
    el.btn.innerText = 'Menunggu alat...';
    el.statusText.innerText = `Perintah ${targetLabel} terkirim, menunggu konfirmasi alat`;
    el.statusBadge.className = 'status-badge badge-loading';
    el.statusBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">...</span>';

    if (pendingTimeoutMap[relayId]) clearTimeout(pendingTimeoutMap[relayId]);
    pendingTimeoutMap[relayId] = setTimeout(() => {
        const pending = pendingCommandMap[relayId];
        if (!pending || pending.seq !== seq) return;
        showToast(`Saklar ${relayId} belum dikonfirmasi alat. Cek koneksi ESP32.`, 'warning', 4200);
        renderRelayStatus(relayId, statusRelayMap[relayId], commandSeqMap[relayId], true);
    }, COMMAND_ACK_TIMEOUT_MS);
}

function renderRelayStatus(relayId, data, ackSeq = 0, keepPending = false) {
    const el = lampCards[relayId];
    if (!el) return;

    const state = data === 1 ? 1 : 0;
    const seq = Number.isFinite(ackSeq) ? ackSeq : 0;
    statusKnownMap[relayId] = true;
    statusRelayMap[relayId] = state;
    commandSeqMap[relayId] = Math.max(commandSeqMap[relayId] || 0, seq);

    const pending = pendingCommandMap[relayId];
    const isAcked = pending && seq >= pending.seq && state === pending.targetState;
    if (isAcked) {
        clearPendingCommand(relayId);
    } else if (pending && !keepPending) {
        setPendingRelayUI(relayId, pending.targetState, pending.seq);
        updateCardScheduleUI(relayId);
        return;
    }

    const isOn = state === 1;
    el.btn.className = isOn ? 'btn btn-matikan' : 'btn btn-hidupkan';
    el.btn.innerText = isOn ? 'Matikan' : 'Hidupkan';
    el.btn.disabled = !isOnline;
    el.statusText.innerText = isOn ? 'Saklar fisik terkonfirmasi hidup' : 'Saklar fisik terkonfirmasi mati';
    el.statusBadge.className = isOn ? 'status-badge badge-on' : 'status-badge badge-off';
    el.statusBadge.innerHTML = isOn
        ? '<span class="badge-dot"></span><span class="badge-text">ON</span>'
        : '<span class="badge-dot"></span><span class="badge-text">OFF</span>';
    updateCardScheduleUI(relayId);
}

function updateConnectionStatus() {
    const buttons = document.querySelectorAll('.lamp-card .btn');
    if (isOnline) {
        connStatusEl.innerText = "Koneksi Anda: Terhubung";
        connStatusEl.className = "connection-status status-online";
        buttons.forEach((btn) => {
            const relayId = Number(btn.id.replace('btn-', ''));
            btn.disabled = Boolean(pendingCommandMap[relayId]);
        });
    } else {
        connStatusEl.innerText = "Koneksi Anda: Terputus";
        connStatusEl.className = "connection-status status-offline";
        buttons.forEach(btn => btn.disabled = true);
    }
}

window.addEventListener('online', () => {
    isOnline = true;
    updateConnectionStatus();
});
window.addEventListener('offline', () => {
    isOnline = false;
    updateConnectionStatus();
});

const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    isOnline = snap.val() === true && navigator.onLine;
    updateConnectionStatus();
});

function updateDeviceStatus() {
    if (!waktuDetakTerakhir) {
        isDeviceOnline = false;
        if (Date.now() - waktuLogin < DEVICE_STARTUP_GRACE_MS) {
            deviceStatusEl.innerText = "Koneksi Alat: Mengecek...";
        } else {
            deviceStatusEl.innerText = "Koneksi Alat: Terputus";
        }
        deviceStatusEl.className = "connection-status status-offline";
        return;
    }

    const selisihWaktu = Date.now() - waktuDetakTerakhir;
    isDeviceOnline = selisihWaktu <= DEVICE_OFFLINE_TIMEOUT_MS;
    deviceStatusEl.innerText = isDeviceOnline ? "Koneksi Alat: Terhubung" : "Koneksi Alat: Terputus";
    deviceStatusEl.className = isDeviceOnline ? "connection-status status-online" : "connection-status status-offline";
}

function stopDatabaseListeners() {
    dbUnsubscribes.forEach((unsub) => {
        try {
            if (typeof unsub === 'function') unsub();
        } catch (err) {
            console.error("Gagal melepas listener database:", err);
        }
    });
    dbUnsubscribes = [];
    [heartbeatIntervalId, countdownIntervalId, deviceStatusIntervalId].forEach((id) => {
        if (id) clearInterval(id);
    });
    heartbeatIntervalId = null;
    countdownIntervalId = null;
    deviceStatusIntervalId = null;
    for (let i = 1; i <= 8; i++) clearPendingCommand(i);
}

function startDatabaseListeners() {
    stopDatabaseListeners();
    waktuLogin = Date.now();
    waktuDetakTerakhir = 0;
    updateDeviceStatus();

    const heartbeatRef = ref(db, "status/heartbeat");
    const unsubHeartbeat = onValue(heartbeatRef, (snapshot) => {
        if (snapshot.exists()) {
            waktuDetakTerakhir = Date.now();
            updateDeviceStatus();
        }
    }, (error) => {
        console.error("Kesalahan listener heartbeat:", error);
    });
    dbUnsubscribes.push(unsubHeartbeat);

    const onlineRef = ref(db, "status/online");
    const unsubOnline = onValue(onlineRef, (snapshot) => {
        if (snapshot.val() === true) {
            waktuDetakTerakhir = Date.now();
            updateDeviceStatus();
        }
    }, (error) => {
        console.error("Kesalahan listener online alat:", error);
    });
    dbUnsubscribes.push(unsubOnline);

    for (let i = 1; i <= 8; i++) {
        const statusRef = ref(db, `status/relay${i}`);
        const unsubStatus = onValue(statusRef, (snapshot) => {
            const value = snapshot.val();
            if (value && typeof value === 'object') {
                renderRelayStatus(i, value.state, value.ackSeq || 0);
            }
        }, (error) => {
            console.error(`Kesalahan listener status relay${i}:`, error);
        });
        dbUnsubscribes.push(unsubStatus);

        const legacyRelayRef = ref(db, `stopkontak/relay${i}`);
        const unsubLegacyRelay = onValue(legacyRelayRef, (snapshot) => {
            if (!statusKnownMap[i]) {
                renderRelayStatus(i, snapshot.val(), 0);
            }
        }, (error) => {
            console.error(`Kesalahan listener legacy relay${i}:`, error);
        });
        dbUnsubscribes.push(unsubLegacyRelay);
    }

    const namaRef = ref(db, "nama_saklar");
    const unsubNama = onValue(namaRef, (snapshot) => {
        const data = snapshot.val() || {};
        for (let i = 1; i <= 8; i++) {
            const customName = data[`relay${i}`];
            const cleanName = (typeof customName === 'string' && customName.trim().length > 0) ? customName.trim() : `Saklar ${i}`;
            namaSaklarMap[i] = cleanName;
            const el = lampCards[i];
            if (el) {
                el.title.innerText = cleanName;
                el.btnJadwal.title = 'Konfigurasi Saklar';
            }
        }
        if (relayJadwalAktif && modalSwitchName) {
            modalSwitchName.innerText = namaSaklarMap[relayJadwalAktif] || `Saklar ${relayJadwalAktif}`;
        }
    }, (error) => {
        console.error("Kesalahan listener nama_saklar:", error);
    });
    dbUnsubscribes.push(unsubNama);

    const jadwalRef = ref(db, "jadwal");
    const unsubJadwal = onValue(jadwalRef, (snapshot) => {
        const data = snapshot.val() || {};
        for (let i = 1; i <= 8; i++) {
            jadwalMap[i] = data[`relay${i}`] || null;
            updateCardScheduleUI(i);
        }
    }, (error) => {
        console.error("Kesalahan listener jadwal:", error);
    });
    dbUnsubscribes.push(unsubJadwal);

    deviceStatusIntervalId = setInterval(updateDeviceStatus, 500);
    heartbeatIntervalId = setInterval(updateConnectionStatus, 1000);
    countdownIntervalId = setInterval(() => {
        for (let i = 1; i <= 8; i++) {
            if (jadwalMap[i] && jadwalMap[i].aktif) updateCardScheduleUI(i);
        }
    }, 1000);
}

function formatTwoDigits(num) {
    return String(num).padStart(2, '0');
}

function hitungEstimasiJadwal(jadwalData, currentStatus) {
    if (!jadwalData || !jadwalData.aktif) return { aktif: false, subtext: 'Jadwal Nonaktif' };
    const { jamNyala, menitNyala, jamMati, menitMati } = jadwalData;
    const hasTimeOn = jamNyala !== undefined && menitNyala !== undefined && jamNyala >= 0;
    const hasTimeOff = jamMati !== undefined && menitMati !== undefined && jamMati >= 0;
    if (!hasTimeOn && !hasTimeOff) return { aktif: false, subtext: 'Waktu belum diatur' };

    let hasDay = false;
    for (let d = 0; d <= 6; d++) {
        if (jadwalData[`hari${d}`]) {
            hasDay = true;
            break;
        }
    }
    if (!hasDay) return { aktif: false, subtext: 'Hari belum dipilih' };

    const timeRange = `${hasTimeOn ? formatTwoDigits(jamNyala) + ':' + formatTwoDigits(menitNyala) : '--:--'} - ${hasTimeOff ? formatTwoDigits(jamMati) + ':' + formatTwoDigits(menitMati) : '--:--'}`;
    const now = new Date();
    const candidates = [];
    for (let offset = 0; offset <= 7; offset++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        const dayOfWeek = targetDate.getDay();
        if (jadwalData[`hari${dayOfWeek}`]) {
            if (hasTimeOn) {
                const dateOn = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), jamNyala, menitNyala, 0);
                if (dateOn.getTime() > now.getTime()) candidates.push({ type: 'ON', time: dateOn });
            }
            if (hasTimeOff) {
                const dateOff = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), jamMati, menitMati, 0);
                if (dateOff.getTime() > now.getTime()) candidates.push({ type: 'OFF', time: dateOff });
            }
        }
    }
    if (candidates.length === 0) return { aktif: true, timeRange, countdownText: 'Menunggu siklus berikutnya' };
    candidates.sort((a, b) => a.time.getTime() - b.time.getTime());
    const nextEvent = currentStatus === 1
        ? (candidates.find(c => c.type === 'OFF') || candidates[0])
        : (candidates.find(c => c.type === 'ON') || candidates[0]);
    const diffMs = nextEvent.time.getTime() - now.getTime();
    const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
    const diffMins = Math.floor(totalSecs / 60);
    const remSecs = totalSecs % 60;
    const actionText = nextEvent.type === 'ON' ? 'Hidup' : 'Mati';
    const icon = nextEvent.type === 'ON' ? '⚡' : '🌙';
    let countdownText = '';
    if (diffMins === 0) {
        countdownText = `${icon} ${actionText} dalam ${remSecs} detik`;
    } else if (diffMins < 60) {
        countdownText = `${icon} ${actionText} dalam ${diffMins} menit ${remSecs} detik`;
    } else {
        const diffHours = Math.floor(diffMins / 60);
        const remMins = diffMins % 60;
        if (diffHours < 24) {
            countdownText = remMins > 0 ? `${icon} ${actionText} dalam ${diffHours} jam ${remMins} menit` : `${icon} ${actionText} dalam ${diffHours} jam`;
        } else {
            const diffDays = Math.floor(diffHours / 24);
            const remHours = diffHours % 24;
            const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
            const targetDay = dayNames[nextEvent.time.getDay()];
            countdownText = remHours > 0
                ? `${icon} ${actionText}: ${targetDay} (${diffDays} hari ${remHours} jam lagi)`
                : `${icon} ${actionText}: ${targetDay} (${diffDays} hari lagi)`;
        }
    }
    return { aktif: true, timeRange, countdownText };
}

function updateCardScheduleUI(relayId) {
    const el = lampCards[relayId];
    if (!el || !el.scheduleBox) return;
    const jadwalData = jadwalMap[relayId];
    const currentStatus = statusRelayMap[relayId] !== undefined ? statusRelayMap[relayId] : 0;
    const estimasi = hitungEstimasiJadwal(jadwalData, currentStatus);

    if (estimasi.aktif) {
        el.scheduleBox.className = 'card-schedule-box active';
        el.scheduleBox.innerHTML = `
            <div class="schedule-box-header">
                <span class="schedule-status-pill"><span class="pill-dot"></span>Otomatis</span>
                <span class="schedule-time-range">${estimasi.timeRange}</span>
            </div>
            <div class="schedule-countdown-row">
                <span class="schedule-countdown-text">${estimasi.countdownText}</span>
            </div>`;
    } else {
        el.scheduleBox.className = 'card-schedule-box inactive';
        el.scheduleBox.innerHTML = `
            <div class="schedule-box-header">
                <span class="schedule-status-pill muted"><span class="pill-dot"></span>Manual</span>
                <span class="schedule-time-range muted">${estimasi.subtext || 'Jadwal Nonaktif'}</span>
            </div>`;
    }
}

function initLampCards() {
    container.innerHTML = '';
    for (let i = 1; i <= 8; i++) {
        const card = document.createElement('div');
        card.className = 'lamp-card';
        const headerRow = document.createElement('div');
        headerRow.className = 'card-header-row';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'card-title-wrap';
        const title = document.createElement('h3');
        title.className = 'lamp-title';
        title.innerText = namaSaklarMap[i] || `Saklar ${i}`;
        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge badge-loading';
        statusBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">...</span>';
        titleWrap.appendChild(title);
        titleWrap.appendChild(statusBadge);
        headerRow.appendChild(titleWrap);

        const btnJadwal = document.createElement('button');
        btnJadwal.className = 'btn-schedule';
        btnJadwal.innerText = '⚙️';
        btnJadwal.title = 'Konfigurasi Saklar';
        btnJadwal.addEventListener('click', () => bukaModalJadwal(i));
        headerRow.appendChild(btnJadwal);

        const statusText = document.createElement('p');
        statusText.className = 'lamp-status-text';
        statusText.innerText = 'Memuat status fisik...';
        const scheduleBox = document.createElement('div');
        scheduleBox.className = 'card-schedule-box inactive';
        scheduleBox.innerHTML = `<div class="schedule-box-header"><span class="schedule-status-pill muted"><span class="pill-dot"></span>Manual</span><span class="schedule-time-range muted">Jadwal Nonaktif</span></div>`;
        const btn = document.createElement('button');
        btn.id = `btn-${i}`;
        btn.className = 'btn btn-hidupkan';
        btn.innerText = 'Hidupkan';

        btn.addEventListener('click', () => {
            if (!isOnline || btn.disabled) return;
            const previousStatus = statusRelayMap[i] === 1 ? 1 : 0;
            const targetStatus = previousStatus === 1 ? 0 : 1;
            const seq = nextCommandSeq(i);
            commandSeqMap[i] = seq;
            pendingCommandMap[i] = { targetState: targetStatus, seq };
            setPendingRelayUI(i, targetStatus, seq);

            const commandData = {
                state: targetStatus,
                seq,
                updatedAt: Date.now(),
                source: 'web-dashboard'
            };

            set(ref(db, `command/relay${i}`), commandData).catch((error) => {
                console.error(`Gagal mengirim command relay${i}:`, error);
                clearPendingCommand(i);
                renderRelayStatus(i, previousStatus, commandSeqMap[i], true);
                showToast("Gagal mengirim perintah. Periksa koneksi internet atau Firebase.", "error");
            }).finally(() => {
                setTimeout(() => updateConnectionStatus(), COMMAND_REENABLE_DELAY_MS);
            });
        });

        card.appendChild(headerRow);
        card.appendChild(statusText);
        card.appendChild(scheduleBox);
        card.appendChild(btn);
        container.appendChild(card);
        lampCards[i] = { card, title, statusBadge, btnJadwal, statusText, scheduleBox, btn };
    }
}

initLampCards();

onAuthStateChanged(auth, (user) => {
    if (user) {
        loginContainer.style.display = 'none';
        dashboardContainer.style.display = 'flex';
        updateConnectionStatus();
        startDatabaseListeners();
    } else {
        loginContainer.style.display = 'flex';
        dashboardContainer.style.display = 'none';
        stopDatabaseListeners();
        waktuDetakTerakhir = 0;
        for (let i = 1; i <= 8; i++) {
            namaSaklarMap[i] = `Saklar ${i}`;
            jadwalMap[i] = null;
            statusRelayMap[i] = 0;
            statusKnownMap[i] = false;
            commandSeqMap[i] = 0;
            const el = lampCards[i];
            if (el) {
                el.title.innerText = `Saklar ${i}`;
                el.statusText.innerText = 'Memuat status fisik...';
                el.btn.className = 'btn btn-hidupkan';
                el.btn.innerText = 'Hidupkan';
                el.statusBadge.className = 'status-badge badge-loading';
                el.statusBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">...</span>';
                updateCardScheduleUI(i);
            }
        }
        deviceStatusEl.innerText = "Koneksi Alat: Mengecek...";
        deviceStatusEl.className = "connection-status status-offline";
    }
});

function getPesanErrorAuth(kodeError) {
    switch (kodeError) {
        case 'auth/invalid-login-credentials':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-credential':
            return "Username atau password salah. Silakan periksa kembali.";
        case 'auth/invalid-email':
            return "Format username tidak valid.";
        case 'auth/user-disabled':
            return "Akun ini telah dinonaktifkan.";
        case 'auth/too-many-requests':
            return "Terlalu banyak percobaan masuk yang gagal. Silakan coba lagi beberapa saat.";
        case 'auth/network-request-failed':
            return "Koneksi internet terputus. Periksa jaringan Anda.";
        default:
            return "Username atau password salah. Silakan periksa kembali.";
    }
}

function handleLogin() {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        const pesan = "Mohon lengkapi Username dan Password Anda.";
        loginError.innerText = pesan;
        loginError.style.display = 'block';
        showToast(pesan, 'warning');
        return;
    }
    const emailBuatan = username + "@cairo.com";
    btnLogin.innerText = "Memuat...";
    btnLogin.disabled = true;
    signInWithEmailAndPassword(auth, emailBuatan, password).then(() => {
        loginError.style.display = 'none';
        btnLogin.innerText = "Login";
        btnLogin.disabled = false;
        usernameInput.value = '';
        passwordInput.value = '';
    }).catch((error) => {
        console.error("Firebase Login Error:", error);
        const pesanError = getPesanErrorAuth(error.code);
        loginError.innerText = pesanError;
        loginError.style.display = 'block';
        showToast(pesanError, 'error');
        btnLogin.innerText = "Login";
        btnLogin.disabled = false;
    });
}

btnLogin.addEventListener('click', handleLogin);
passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});
usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
});
usernameInput.addEventListener('input', () => loginError.style.display = 'none');
passwordInput.addEventListener('input', () => loginError.style.display = 'none');
btnLogout.addEventListener('click', () => signOut(auth));

let initialScheduleData = {
    aktif: false,
    timeOn: '',
    timeOff: '',
    days: [false, false, false, false, false, false, false]
};

function saveInitialScheduleState() {
    initialScheduleData = {
        aktif: scheduleActive.checked,
        timeOn: timeOn.value,
        timeOff: timeOff.value,
        days: []
    };
    for (let i = 0; i <= 6; i++) {
        initialScheduleData.days[i] = document.getElementById(`day-${i}`).checked;
    }
    checkScheduleChanges();
}

function updateScheduleInputsState() {
    const isAktif = scheduleActive.checked;
    timeOn.disabled = !isAktif;
    timeOff.disabled = !isAktif;
    for (let i = 0; i <= 6; i++) {
        const dayEl = document.getElementById(`day-${i}`);
        if (dayEl) dayEl.disabled = !isAktif;
    }
    if (scheduleFieldsGroup) scheduleFieldsGroup.classList.toggle('is-disabled', !isAktif);
    if (toggleSubtext) {
        toggleSubtext.innerText = isAktif ? 'Jadwal otomatis aktif' : 'Nyalakan untuk mengatur waktu & hari';
        toggleSubtext.className = isAktif ? 'toggle-subtext text-active' : 'toggle-subtext text-inactive';
    }
}

function checkScheduleChanges() {
    if (!relayJadwalAktif) {
        btnSaveSchedule.disabled = true;
        return;
    }
    const currentAktif = scheduleActive.checked;
    const currentTimeOn = timeOn.value;
    const currentTimeOff = timeOff.value;
    let hasScheduleChange = false;
    if (currentAktif !== initialScheduleData.aktif) {
        hasScheduleChange = true;
    } else if (currentAktif) {
        if (currentTimeOn !== initialScheduleData.timeOn || currentTimeOff !== initialScheduleData.timeOff) {
            hasScheduleChange = true;
        } else {
            for (let i = 0; i <= 6; i++) {
                const initialDay = initialScheduleData.days?.[i] ?? false;
                if (document.getElementById(`day-${i}`).checked !== initialDay) {
                    hasScheduleChange = true;
                    break;
                }
            }
        }
    }
    btnSaveSchedule.disabled = !hasScheduleChange;
}

scheduleActive.addEventListener('change', () => {
    updateScheduleInputsState();
    checkScheduleChanges();
});
timeOn.addEventListener('input', checkScheduleChanges);
timeOn.addEventListener('change', checkScheduleChanges);
timeOff.addEventListener('input', checkScheduleChanges);
timeOff.addEventListener('change', checkScheduleChanges);
for (let i = 0; i <= 6; i++) document.getElementById(`day-${i}`).addEventListener('change', checkScheduleChanges);

function showToast(pesan, tipe = 'success', durasi = 3000) {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;
    toastContainer.innerHTML = '';
    if (toastTimeout) clearTimeout(toastTimeout);
    const toast = document.createElement('div');
    toast.className = `custom-toast toast-${tipe}`;
    let iconSvg = '';
    if (tipe === 'success') {
        iconSvg = `<svg class="toast-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
    } else if (tipe === 'error') {
        iconSvg = `<svg class="toast-svg" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
        iconSvg = `<svg class="toast-svg" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    }
    toast.innerHTML = `<span class="toast-icon-box">${iconSvg}</span><span class="toast-message">${pesan}</span>`;
    toastContainer.appendChild(toast);
    toastTimeout = setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', () => {
            if (toast.parentNode === toastContainer) toastContainer.removeChild(toast);
        }, { once: true });
    }, durasi);
}

function bukaModalJadwal(relayId) {
    if (!isOnline) {
        showToast("Tidak ada koneksi internet. Gagal memuat jadwal.", "warning");
        return;
    }
    relayJadwalAktif = relayId;
    modalTitle.innerText = 'Konfigurasi Saklar';
    modalSwitchName.innerText = namaSaklarMap[relayId] || `Saklar ${relayId}`;
    scheduleModal.style.display = 'flex';
    scheduleActive.checked = false;
    timeOn.value = '';
    timeOff.value = '';
    for (let i = 0; i <= 6; i++) document.getElementById(`day-${i}`).checked = false;
    updateScheduleInputsState();
    btnSaveSchedule.innerText = 'Simpan Perubahan';
    btnSaveSchedule.disabled = true;

    get(ref(db, `jadwal/relay${relayId}`)).then((snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.val();
            scheduleActive.checked = data.aktif || false;
            if (data.jamNyala !== undefined && data.menitNyala !== undefined && data.jamNyala >= 0) {
                timeOn.value = `${String(data.jamNyala).padStart(2, '0')}:${String(data.menitNyala).padStart(2, '0')}`;
            }
            if (data.jamMati !== undefined && data.menitMati !== undefined && data.jamMati >= 0) {
                timeOff.value = `${String(data.jamMati).padStart(2, '0')}:${String(data.menitMati).padStart(2, '0')}`;
            }
            for (let i = 0; i <= 6; i++) document.getElementById(`day-${i}`).checked = data[`hari${i}`] || false;
        }
        updateScheduleInputsState();
        saveInitialScheduleState();
    }).catch((error) => {
        console.log("kesalahan: gagal memuat data jadwal dari server.", error);
        showToast("Gagal memuat jadwal terbaru. Coba lagi saat koneksi stabil.", "error");
        updateScheduleInputsState();
        saveInitialScheduleState();
    });
}

btnCancelSchedule.addEventListener('click', () => scheduleModal.style.display = 'none');

btnSaveSchedule.addEventListener('click', () => {
    const anyTimeFilled = Boolean(timeOn.value || timeOff.value);
    let anyDayChecked = false;
    for (let i = 0; i <= 6; i++) {
        if (document.getElementById(`day-${i}`).checked) {
            anyDayChecked = true;
            break;
        }
    }
    if (scheduleActive.checked && (!anyTimeFilled || !anyDayChecked)) {
        showToast("Pilih minimal satu waktu dan satu hari untuk mengaktifkan jadwal.", "warning");
        return;
    }

    let jamNyala = -1, menitNyala = -1, jamMati = -1, menitMati = -1;
    if (timeOn.value) {
        const partsOn = timeOn.value.split(':');
        jamNyala = parseInt(partsOn[0]);
        menitNyala = parseInt(partsOn[1]);
    }
    if (timeOff.value) {
        const partsOff = timeOff.value.split(':');
        jamMati = parseInt(partsOff[0]);
        menitMati = parseInt(partsOff[1]);
    }
    const dataJadwal = { aktif: scheduleActive.checked, jamNyala, menitNyala, jamMati, menitMati };
    for (let i = 0; i <= 6; i++) dataJadwal[`hari${i}`] = document.getElementById(`day-${i}`).checked;
    btnSaveSchedule.innerText = 'Menyimpan...';
    btnSaveSchedule.disabled = true;
    set(ref(db, `jadwal/relay${relayJadwalAktif}`), dataJadwal).then(() => {
        showToast("Perubahan berhasil disimpan", "success");
        saveInitialScheduleState();
        scheduleModal.style.display = 'none';
    }).catch((error) => {
        console.log("kesalahan: gagal menyimpan jadwal ke server.", error);
        showToast("Gagal menyimpan perubahan ke server.", "error");
    }).finally(() => {
        btnSaveSchedule.innerText = 'Simpan Perubahan';
        checkScheduleChanges();
    });
});

function checkEditNameChanges() {
    if (!relayEditNamaAktif) return;
    const defaultName = `Saklar ${relayEditNamaAktif}`;
    const currentName = (namaSaklarMap[relayEditNamaAktif] || defaultName).trim();
    const isCurrentDefault = currentName.toLowerCase() === defaultName.toLowerCase();
    const rawVal = inputSwitchName.value.trim().replace(/[.#$\[\]\/]/g, '');
    const inputVal = rawVal.substring(0, 30);
    let hasChange = false;
    if (inputVal === '') hasChange = !isCurrentDefault;
    else if (inputVal.toLowerCase() === defaultName.toLowerCase() && isCurrentDefault) hasChange = false;
    else hasChange = inputVal !== currentName;
    btnSaveEditName.disabled = !hasChange;
}

inputSwitchName.addEventListener('input', checkEditNameChanges);
inputSwitchName.addEventListener('keyup', checkEditNameChanges);
inputSwitchName.addEventListener('change', checkEditNameChanges);

function bukaModalEditNama(relayId) {
    if (!isOnline) {
        showToast("Tidak ada koneksi internet. Gagal mengubah nama saklar.", "warning");
        return;
    }
    relayEditNamaAktif = relayId;
    const defaultName = `Saklar ${relayId}`;
    const currentName = namaSaklarMap[relayId] || defaultName;
    editNameTitle.innerText = `Ubah Nama Saklar`;
    editNameDesc.innerText = `Kustomisasi nama untuk Saklar ${relayId} (Relay ${relayId})`;
    inputSwitchName.value = currentName === defaultName ? '' : currentName;
    inputSwitchName.placeholder = `Default: ${defaultName}`;
    checkEditNameChanges();
    editNameModal.style.display = 'flex';
    setTimeout(() => {
        inputSwitchName.focus();
        inputSwitchName.select();
    }, 50);
}

btnCancelEditName.addEventListener('click', () => editNameModal.style.display = 'none');

btnSaveEditName.addEventListener('click', () => {
    if (btnSaveEditName.disabled) return;
    if (!isOnline) {
        showToast("Tidak ada koneksi internet.", "warning");
        return;
    }
    const rawVal = inputSwitchName.value.trim().replace(/[.#$\[\]\/]/g, '');
    const inputVal = rawVal.substring(0, 30);
    btnSaveEditName.innerText = 'Menyimpan...';
    btnSaveEditName.disabled = true;
    const defaultName = `Saklar ${relayEditNamaAktif}`;
    const valToSave = (inputVal.length > 0 && inputVal.toLowerCase() !== defaultName.toLowerCase()) ? inputVal : null;
    set(ref(db, `nama_saklar/relay${relayEditNamaAktif}`), valToSave).then(() => {
        showToast("Nama saklar berhasil diperbarui", "success");
        editNameModal.style.display = 'none';
        const cleanNewName = valToSave || defaultName;
        namaSaklarMap[relayEditNamaAktif] = cleanNewName;
        if (modalSwitchName) modalSwitchName.innerText = cleanNewName;
        checkScheduleChanges();
    }).catch((error) => {
        console.error("Gagal menyimpan nama saklar:", error);
        showToast("Gagal menyimpan nama saklar. Periksa koneksi internet Anda.", "error");
    }).finally(() => {
        btnSaveEditName.innerText = 'Simpan Nama';
        checkEditNameChanges();
    });
});

btnEditSwitchName.addEventListener('click', () => bukaModalEditNama(relayJadwalAktif));
inputSwitchName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (!btnSaveEditName.disabled) btnSaveEditName.click();
    } else if (e.key === 'Escape') {
        editNameModal.style.display = 'none';
    }
});

updateConnectionStatus();
updateScheduleInputsState();
