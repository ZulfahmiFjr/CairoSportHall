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

// nyalain layanan firebase sama authnyaa juga
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// siapin semua elemen html yang mau diotak atik
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

// elemen buat ngatur popup jadwal / saklar
const scheduleModal = document.getElementById('schedule-modal');
const modalTitle = document.getElementById('modal-title');
const modalSwitchName = document.getElementById('modal-switch-name');
const btnEditSwitchName = document.getElementById('btn-edit-switch-name');
const scheduleActive = document.getElementById('schedule-active');
const timeOn = document.getElementById('time-on');
const timeOff = document.getElementById('time-off');
const btnCancelSchedule = document.getElementById('btn-cancel-schedule');
const btnSaveSchedule = document.getElementById('btn-save-schedule');

// elemen buat popup ubah nama saklar oleh admin
const editNameModal = document.getElementById('edit-name-modal');
const editNameTitle = document.getElementById('edit-name-title');
const editNameDesc = document.getElementById('edit-name-desc');
const inputSwitchName = document.getElementById('input-switch-name');
const btnCancelEditName = document.getElementById('btn-cancel-edit-name');
const btnSaveEditName = document.getElementById('btn-save-edit-name');

let relayJadwalAktif = 0;
let relayEditNamaAktif = 0;
let isOnline = navigator.onLine;
let waktuDetakTerakhir = 0;
let waktuLogin = 0;
let dbUnsubscribes = [];
let heartbeatIntervalId = null;
const lampCards = [];
const namaSaklarMap = {};
for (let i = 1; i <= 8; i++) {
    namaSaklarMap[i] = `Saklar ${i}`;
}
const jadwalMap = {};
const statusRelayMap = {};
let countdownIntervalId = null;

// nah ini fungsi buat ngatur tampilan status koneksi internet/firebase
function updateConnectionStatus() {
    const buttons = document.querySelectorAll('.lamp-card .btn');
    if (isOnline) {
        connStatusEl.innerText = "Koneksi Anda: Terhubung";
        connStatusEl.className = "connection-status status-online";
        buttons.forEach(btn => btn.disabled = false);
    } else {
        connStatusEl.innerText = "Koneksi Anda: Terputus";
        connStatusEl.className = "connection-status status-offline";
        buttons.forEach(btn => btn.disabled = true);
    }
}

// pasang kuping buat dengerin perubahan koneksi internet di browser
window.addEventListener('online', () => {
    isOnline = true;
    updateConnectionStatus();
});
window.addEventListener('offline', () => {
    isOnline = false;
    updateConnectionStatus();
});

// ngecek status koneksi langsung ke firebase pakai jalur khusus connected
const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    isOnline = snap.val() === true && navigator.onLine;
    updateConnectionStatus();
});

// fungsi buat memperbarui tampilan status alat ESP32
function updateDeviceStatus() {
    if (!waktuDetakTerakhir) {
        if (Date.now() - waktuLogin < 5000) {
            deviceStatusEl.innerText = "Koneksi Alat: Mengecek...";
            deviceStatusEl.className = "connection-status status-offline";
            return;
        }
        deviceStatusEl.innerText = "Koneksi Alat: Terputus";
        deviceStatusEl.className = "connection-status status-offline";
        return;
    }
    const selisihWaktu = Date.now() - waktuDetakTerakhir;
    if (selisihWaktu > 8000) {
        deviceStatusEl.innerText = "Koneksi Alat: Terputus";
        deviceStatusEl.className = "connection-status status-offline";
    } else {
        deviceStatusEl.innerText = "Koneksi Alat: Terhubung";
        deviceStatusEl.className = "connection-status status-online";
    }
}

// fungsi buat ngelepas semua listener realtime database saat keluar
function stopDatabaseListeners() {
    dbUnsubscribes.forEach((unsub) => {
        try {
            if (typeof unsub === 'function') unsub();
        } catch (err) {
            console.error("Gagal melepas listener database:", err);
        }
    });
    dbUnsubscribes = [];
    if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
    }
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
}

// fungsi buat mulai mendengarkan realtime database setelah user terautentikasi
function startDatabaseListeners() {
    stopDatabaseListeners();
    waktuLogin = Date.now();
    waktuDetakTerakhir = 0;
    updateDeviceStatus();
    // 1. Pantau detak jantung ESP32
    const heartbeatRef = ref(db, "stopkontak/heartbeat");
    const unsubHeartbeat = onValue(heartbeatRef, (snapshot) => {
        if (snapshot.exists()) {
            waktuDetakTerakhir = Date.now();
            updateDeviceStatus();
        }
    }, (error) => {
        console.error("Kesalahan listener heartbeat:", error);
    });
    dbUnsubscribes.push(unsubHeartbeat);
    // 2. Pantau status 8 saklar / relay
    for (let i = 1; i <= 8; i++) {
        const relayRef = ref(db, `stopkontak/relay${i}`);
        const unsubRelay = onValue(relayRef, (snapshot) => {
            const data = snapshot.val();
            statusRelayMap[i] = data;
            const el = lampCards[i];
            if (!el) return;
            if (data === 1) {
                el.btn.className = 'btn btn-matikan';
                el.btn.innerText = 'Matikan';
                el.statusText.innerText = 'Saklar saat ini sedang hidup';
                el.statusBadge.className = 'status-badge badge-on';
                el.statusBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">ON</span>';
            } else {
                el.btn.className = 'btn btn-hidupkan';
                el.btn.innerText = 'Hidupkan';
                el.statusText.innerText = 'Saklar saat ini sedang mati';
                el.statusBadge.className = 'status-badge badge-off';
                el.statusBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">OFF</span>';
            }
            updateCardScheduleUI(i);
        }, (error) => {
            console.error(`Kesalahan listener relay${i}:`, error);
        });
        dbUnsubscribes.push(unsubRelay);
    }
    // 3. Pantau kustomisasi nama saklar realtime
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
    // 4. Pantau status jadwal otomatis untuk semua saklar realtime
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
    // 5. Interval rutin cek heartbeat ESP32
    heartbeatIntervalId = setInterval(updateDeviceStatus, 1000);
    // 6. Interval rutin hitung mundur jadwal tiap 1 detik murni jalan di sisi client
    countdownIntervalId = setInterval(() => {
        for (let i = 1; i <= 8; i++) {
            if (jadwalMap[i] && jadwalMap[i].aktif) {
                updateCardScheduleUI(i);
            }
        }
    }, 1000);
}

// format dua digit angka
function formatTwoDigits(num) {
    return String(num).padStart(2, '0');
}

// hitung perkiraan waktu pemicu berikutnya (countdown)
function hitungEstimasiJadwal(jadwalData, currentStatus) {
    if (!jadwalData || !jadwalData.aktif) {
        return { aktif: false, subtext: 'Jadwal Nonaktif' };
    }
    const { jamNyala, menitNyala, jamMati, menitMati } = jadwalData;
    const hasTimeOn = jamNyala !== undefined && menitNyala !== undefined && jamNyala >= 0;
    const hasTimeOff = jamMati !== undefined && menitMati !== undefined && jamMati >= 0;
    if (!hasTimeOn && !hasTimeOff) {
        return { aktif: false, subtext: 'Waktu belum diatur' };
    }
    let hasDay = false;
    for (let d = 0; d <= 6; d++) {
        if (jadwalData[`hari${d}`]) {
            hasDay = true;
            break;
        }
    }
    if (!hasDay) {
        return { aktif: false, subtext: 'Hari belum dipilih' };
    }
    const timeRange = `${hasTimeOn ? formatTwoDigits(jamNyala) + ':' + formatTwoDigits(menitNyala) : '--:--'} – ${hasTimeOff ? formatTwoDigits(jamMati) + ':' + formatTwoDigits(menitMati) : '--:--'}`;
    const now = new Date();
    const candidates = [];
    // Cari jadwal pemicu dalam 7 hari ke depan
    for (let offset = 0; offset <= 7; offset++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        const dayOfWeek = targetDate.getDay();
        if (jadwalData[`hari${dayOfWeek}`]) {
            if (hasTimeOn) {
                const dateOn = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), jamNyala, menitNyala, 0);
                if (dateOn.getTime() > now.getTime()) {
                    candidates.push({ type: 'ON', time: dateOn });
                }
            }
            if (hasTimeOff) {
                const dateOff = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), jamMati, menitMati, 0);
                if (dateOff.getTime() > now.getTime()) {
                    candidates.push({ type: 'OFF', time: dateOff });
                }
            }
        }
    }
    if (candidates.length === 0) {
        return { aktif: true, timeRange, countdownText: 'Menunggu siklus berikutnya' };
    }
    candidates.sort((a, b) => a.time.getTime() - b.time.getTime());
    // Cari event yang paling relevan dengan kondisi saklar saat ini
    let nextEvent = null;
    if (currentStatus === 1) {
        // Saklar sedang hidup: prioritaskan info kapan akan mati
        nextEvent = candidates.find(c => c.type === 'OFF') || candidates[0];
    } else {
        // Saklar sedang mati: prioritaskan info kapan akan hidup
        nextEvent = candidates.find(c => c.type === 'ON') || candidates[0];
    }
    // kalkulasi sisa waktu murni ke detik
    const diffMs = nextEvent.time.getTime() - now.getTime();
    const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
    const diffMins = Math.floor(totalSecs / 60);
    const remSecs = totalSecs % 60;
    const actionText = nextEvent.type === 'ON' ? 'Hidup' : 'Mati';
    const icon = nextEvent.type === 'ON' ? '⚡' : '🌙';
    let countdownText = '';
    // logika tampilan teksnyaa
    if (diffMins === 0) {
        // kalau dibawah satu menit nampilin detik doang
        countdownText = `${icon} ${actionText} dalam ${remSecs} detik`;
    } else if (diffMins < 60) {
        // kalau dibawah satu jam nampilin menit dan detiknyaa
        countdownText = `${icon} ${actionText} dalam ${diffMins} menit ${remSecs} detik`;
    } else {
        // kalau diatas satu jam balik ke tampilan format jam hari yang lama
        const diffHours = Math.floor(diffMins / 60);
        const remMins = diffMins % 60;
        if (diffHours < 24) {
            countdownText = remMins > 0
                ? `${icon} ${actionText} dalam ${diffHours} jam ${remMins} menit`
                : `${icon} ${actionText} dalam ${diffHours} jam`;
        } else {
            const diffDays = Math.floor(diffHours / 24);
            const remHours = diffHours % 24;
            const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
            const targetDay = dayNames[nextEvent.time.getDay()];
            if (remHours > 0) {
                countdownText = `${icon} ${actionText}: ${targetDay} (${diffDays} hari ${remHours} jam lagi)`;
            } else {
                countdownText = `${icon} ${actionText}: ${targetDay} (${diffDays} hari lagi)`;
            }
        }
    }
    return { aktif: true, timeRange, countdownText };
}

// perbarui UI box jadwal di kartu saklar
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
            </div>
        `;
    } else {
        el.scheduleBox.className = 'card-schedule-box inactive';
        el.scheduleBox.innerHTML = `
            <div class="schedule-box-header">
                <span class="schedule-status-pill muted"><span class="pill-dot"></span>Manual</span>
                <span class="schedule-time-range muted">${estimasi.subtext || 'Jadwal Nonaktif'}</span>
            </div>
        `;
    }
}

// fungsi buat membuat 8 kartu saklar sekali di awal
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
        btnJadwal.addEventListener('click', () => {
            bukaModalJadwal(i);
        });
        headerRow.appendChild(btnJadwal);

        const statusText = document.createElement('p');
        statusText.className = 'lamp-status-text';
        statusText.innerText = 'Memuat status...';

        // Kotak status jadwal otomatis
        const scheduleBox = document.createElement('div');
        scheduleBox.className = 'card-schedule-box inactive';
        scheduleBox.innerHTML = `
            <div class="schedule-box-header">
                <span class="schedule-status-pill muted"><span class="pill-dot"></span>Manual</span>
                <span class="schedule-time-range muted">Jadwal Nonaktif</span>
            </div>
        `;

        const btn = document.createElement('button');
        btn.id = `btn-${i}`;
        btn.className = 'btn btn-hidupkan';
        btn.innerText = 'Hidupkan';

        // lempar data ke firebase pas tombol saklarnya diklik
        btn.addEventListener('click', () => {
            if (!isOnline) return;
            const statusSekarang = btn.classList.contains('btn-matikan') ? 0 : 1;
            set(ref(db, `stopkontak/relay${i}`), statusSekarang);
        });

        card.appendChild(headerRow);
        card.appendChild(statusText);
        card.appendChild(scheduleBox);
        card.appendChild(btn);
        container.appendChild(card);

        lampCards[i] = { card, title, statusBadge, btnJadwal, statusText, scheduleBox, btn };
    }
}

// buat kartu saklar di DOM
initLampCards();

// pantengin terus status loginnya lalu jalankan listener database jika sudah login
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
        // reset tampilan kartu saat logout
        for (let i = 1; i <= 8; i++) {
            namaSaklarMap[i] = `Saklar ${i}`;
            jadwalMap[i] = null;
            statusRelayMap[i] = 0;
            const el = lampCards[i];
            if (el) {
                el.title.innerText = `Saklar ${i}`;
                el.statusText.innerText = 'Memuat status...';
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

// mengubah kode error firebase auth menjadi pesan yang jelas dan ramah bagi pengguna
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

// pas tombol login dipencet kita gabungin username yang diinput sama string emailnyaa
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
usernameInput.addEventListener('input', () => {
    loginError.style.display = 'none';
});
passwordInput.addEventListener('input', () => {
    loginError.style.display = 'none';
});

// kalau udah beres trus pengen keluar pencet tombol yang ini
btnLogout.addEventListener('click', () => {
    signOut(auth);
});

let initialScheduleData = {
    aktif: false,
    timeOn: '',
    timeOff: '',
    days: [false, false, false, false, false, false, false]
};

// simpan kondisi awal jadwal saat dibuka
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

// periksa apakah ada perubahan pada form jadwal
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
    } else if (currentTimeOn !== initialScheduleData.timeOn) {
        hasScheduleChange = true;
    } else if (currentTimeOff !== initialScheduleData.timeOff) {
        hasScheduleChange = true;
    } else {
        for (let i = 0; i <= 6; i++) {
            const initialDay = (initialScheduleData.days && initialScheduleData.days[i] !== undefined) ? initialScheduleData.days[i] : false;
            if (document.getElementById(`day-${i}`).checked !== initialDay) {
                hasScheduleChange = true;
                break;
            }
        }
    }

    btnSaveSchedule.disabled = !hasScheduleChange;
}

// pasang listener pada semua kontrol jadwal
scheduleActive.addEventListener('change', checkScheduleChanges);
timeOn.addEventListener('input', checkScheduleChanges);
timeOn.addEventListener('change', checkScheduleChanges);
timeOff.addEventListener('input', checkScheduleChanges);
timeOff.addEventListener('change', checkScheduleChanges);

for (let i = 0; i <= 6; i++) {
    document.getElementById(`day-${i}`).addEventListener('change', checkScheduleChanges);
}

// fungsi untuk menampilkan popup notifikasi custom menggantikan alert bawaan browser
let toastTimeout = null;
function showToast(pesan, tipe = 'success', durasi = 3000) {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;

    toastContainer.innerHTML = '';
    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }

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

    toast.innerHTML = `
        <span class="toast-icon-box">${iconSvg}</span>
        <span class="toast-message">${pesan}</span>
    `;

    toastContainer.appendChild(toast);

    toastTimeout = setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', () => {
            if (toast.parentNode === toastContainer) {
                toastContainer.removeChild(toast);
            }
        }, { once: true });
    }, durasi);
}

// nampilin modal jadwal trus narik data langsung dari firebase biar akurat
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
    for (let i = 0; i <= 6; i++) {
        document.getElementById(`day-${i}`).checked = false;
    }
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
            for (let i = 0; i <= 6; i++) {
                document.getElementById(`day-${i}`).checked = data[`hari${i}`] || false;
            }
        }
        saveInitialScheduleState();
    }).catch((error) => {
        console.log("kesalahan: gagal memuat data jadwal dari server.", error);
        saveInitialScheduleState();
    });
}

// tutup modalnyaa pas batal diklik
btnCancelSchedule.addEventListener('click', () => {
    scheduleModal.style.display = 'none';
});

// ngelempar data json jadwal baru ke firebase pas tombol simpan diklik
btnSaveSchedule.addEventListener('click', () => {
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
    const dataJadwal = {
        aktif: scheduleActive.checked,
        jamNyala: jamNyala,
        menitNyala: menitNyala,
        jamMati: jamMati,
        menitMati: menitMati
    };
    for (let i = 0; i <= 6; i++) {
        dataJadwal[`hari${i}`] = document.getElementById(`day-${i}`).checked;
    }
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

// fungsi buat mengecek apakah nama saklar berubah dari kondisi saat ini
function checkEditNameChanges() {
    if (!relayEditNamaAktif) return;
    const defaultName = `Saklar ${relayEditNamaAktif}`;
    const currentName = (namaSaklarMap[relayEditNamaAktif] || defaultName).trim();
    const isCurrentDefault = currentName.toLowerCase() === defaultName.toLowerCase();
    // bersihin karakter terlarang rtdb trus potong maksimal tiga puluh huruf
    const rawVal = inputSwitchName.value.trim().replace(/[.#$\[\]\/]/g, '');
    const inputVal = rawVal.substring(0, 30);
    let hasChange = false;
    if (inputVal === '') {
        hasChange = !isCurrentDefault;
    } else {
        if (inputVal.toLowerCase() === defaultName.toLowerCase() && isCurrentDefault) {
            hasChange = false;
        } else {
            hasChange = (inputVal !== currentName);
        }
    }
    btnSaveEditName.disabled = !hasChange;
}

// listener input nama untuk deteksi perubahan secara langsung
inputSwitchName.addEventListener('input', checkEditNameChanges);
inputSwitchName.addEventListener('keyup', checkEditNameChanges);
inputSwitchName.addEventListener('change', checkEditNameChanges);

// fungsi untuk membuka modal kustomisasi nama saklar
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

// tutup modal edit nama saat tombol batal diklik
btnCancelEditName.addEventListener('click', () => {
    editNameModal.style.display = 'none';
});

// simpan perubahan nama saklar ke firebase
btnSaveEditName.addEventListener('click', () => {
    if (btnSaveEditName.disabled) return;
    if (!isOnline) {
        showToast("Tidak ada koneksi internet.", "warning");
        return;
    }
    // bersihin karakter terlarang rtdb trus potong maksimal tiga puluh huruf
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
        if (modalSwitchName) {
            modalSwitchName.innerText = cleanNewName;
        }
        checkScheduleChanges();
    }).catch((error) => {
        console.error("Gagal menyimpan nama saklar:", error);
        showToast("Gagal menyimpan nama saklar. Periksa koneksi internet Anda.", "error");
    }).finally(() => {
        btnSaveEditName.innerText = 'Simpan Nama';
        checkEditNameChanges();
    });
});

// klik tombol pensil di dalam modal Konfigurasi Saklar
btnEditSwitchName.addEventListener('click', () => {
    bukaModalEditNama(relayJadwalAktif);
});

// shortcut keyboard enter & escape pada input nama saklar
inputSwitchName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (!btnSaveEditName.disabled) {
            btnSaveEditName.click();
        }
    } else if (e.key === 'Escape') {
        editNameModal.style.display = 'none';
    }
});

// jalanin fungsinyaa sekali pas halaman webnyaa pertama kali kebuka
updateConnectionStatus();