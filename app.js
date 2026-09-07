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

// elemen buat ngatur popup jadwal
const scheduleModal = document.getElementById('schedule-modal');
const modalTitle = document.getElementById('modal-title');
const scheduleActive = document.getElementById('schedule-active');
const timeOn = document.getElementById('time-on');
const timeOff = document.getElementById('time-off');
const btnCancelSchedule = document.getElementById('btn-cancel-schedule');
const btnSaveSchedule = document.getElementById('btn-save-schedule');
let relayJadwalAktif = 0;
let isOnline = navigator.onLine;
let waktuDetakTerakhir = 0;

// pantengin terus status loginnyaa trus hilangin atau nampilin kotak login
onAuthStateChanged(auth, (user) => {
    if (user) {
        loginContainer.style.display = 'none';
        dashboardContainer.style.display = 'flex';
        updateConnectionStatus();
    } else {
        loginContainer.style.display = 'flex';
        dashboardContainer.style.display = 'none';
    }
});

// pas tombol login dipencet kita gabungin username yang diinput sama string emailnyaa
btnLogin.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        loginError.innerText = "Mohon lengkapi Username dan Password Anda.";
        loginError.style.display = 'block';
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
        console.error("Code:", error.code);
        console.error("Message:", error.message);
        loginError.innerText = `${error.code}: ${error.message}`;
        loginError.style.display = 'block';
        btnLogin.innerText = "Login";
        btnLogin.disabled = false;
    });
});

// kalau udah beres trus pengen keluar pencet tombol yang ini aja
btnLogout.addEventListener('click', () => {
    signOut(auth);
});

// nah ini fungsi buat ngatur tampilan status koneksinyaa
function updateConnectionStatus() {
    isOnline = navigator.onLine;
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
window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);

// ngecek status koneksi langsung ke firebase pakai jalur khusus connected
const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    isOnline = snap.val() === true && navigator.onLine;
    updateConnectionStatus();
});

// mantau detak jantung esp32 secara realtime
const heartbeatRef = ref(db, "stopkontak/heartbeat");
onValue(heartbeatRef, (snapshot) => {
    if (snapshot.exists()) {
        waktuDetakTerakhir = Date.now();
    }
});

// ngecek status idup matinyaa esp32 tiap tiga detik
setInterval(() => {
    const selisihWaktu = Date.now() - waktuDetakTerakhir;
    if (selisihWaktu > 20000) {
        deviceStatusEl.innerText = "Koneksi Alat: Terputus";
        deviceStatusEl.className = "connection-status status-offline";
    } else {
        deviceStatusEl.innerText = "Koneksi Alat: Terhubung";
        deviceStatusEl.className = "connection-status status-online";
    }
}, 3000);

// ini buat ngehasilin delapan kotak tombol berurutan pakai loop
for (let i = 1; i <= 8; i++) {
    const card = document.createElement('div');
    card.className = 'lamp-card';
    const title = document.createElement('h3');
    title.className = 'lamp-title';
    title.innerText = `Lampu ${i}`;
    const statusText = document.createElement('p');
    statusText.className = 'lamp-status-text';
    statusText.innerText = 'Memuat status...';
    const btnJadwal = document.createElement('button');
    btnJadwal.className = 'btn-schedule';
    btnJadwal.innerText = '⚙️ Atur Jadwal';
    btnJadwal.addEventListener('click', () => {
        bukaModalJadwal(i);
    });
    const btn = document.createElement('button');
    btn.id = `btn-${i}`;
    btn.className = 'btn btn-hidupkan';
    btn.innerText = 'Hidupkan';
    // lempar data ke firebase pas tombol saklarnyaa diklik
    btn.addEventListener('click', () => {
        if (!isOnline) return;
        const statusSekarang = btn.classList.contains('btn-matikan') ? 0 : 1;
        set(ref(db, `stopkontak/relay${i}`), statusSekarang);
    });
    card.appendChild(title);
    card.appendChild(btnJadwal);
    card.appendChild(statusText);
    card.appendChild(btn);
    container.appendChild(card);
    // pantengin terus data dari firebase secara langsung tanpa delay
    const relayRef = ref(db, `stopkontak/relay${i}`);
    onValue(relayRef, (snapshot) => {
        const data = snapshot.val();
        if (data === 1) {
            btn.className = 'btn btn-matikan';
            btn.innerText = 'Matikan';
            statusText.innerText = 'Lampu saat ini sedang hidup';
        } else {
            btn.className = 'btn btn-hidupkan';
            btn.innerText = 'Hidupkan';
            statusText.innerText = 'Lampu saat ini sedang mati';
        }
    });
}

// nampilin modal jadwal trus narik data langsung dari firebase biar akurat
function bukaModalJadwal(relayId) {
    if (!isOnline) {
        alert("Peringatan: Tidak ada koneksi internet. Gagal memuat jadwal.");
        return;
    }
    relayJadwalAktif = relayId;
    modalTitle.innerText = `Atur Jadwal Lampu ${relayId}`;
    scheduleModal.style.display = 'flex';
    scheduleActive.checked = false;
    timeOn.value = '';
    timeOff.value = '';
    for (let i = 0; i <= 6; i++) {
        document.getElementById(`day-${i}`).checked = false;
    }
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
    }).catch((error) => {
        console.log("kesalahan: gagal memuat data jadwal dari server.", error);
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
        alert("Informasi: Jadwal berhasil disimpan.");
        scheduleModal.style.display = 'none';
    }).catch((error) => {
        console.log("kesalahan: gagal menyimpan jadwal ke server.", error);
        alert("gagal nyimpen jadwalnyaa nih, coba buka inspect element trus cek tab console buat liat pesan aslinya!");
    }).finally(() => {
        btnSaveSchedule.innerText = 'Simpan Pengaturan';
        btnSaveSchedule.disabled = false;
    });
});

// jalanin fungsinyaa sekali pas halaman webnyaa pertama kali kebuka
updateConnectionStatus();