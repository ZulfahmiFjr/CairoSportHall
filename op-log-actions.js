import { getApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import {
    getDatabase,
    ref,
    remove,
    get,
    onValue,
    query,
    orderByChild,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";

const app = getApp();
const db = getDatabase(app);
const activityLogTableBody = document.getElementById('activity-log-table-body');
const activityLogPanel = activityLogTableBody?.closest('.op-table-panel');
const activityLogTable = activityLogTableBody?.closest('table');
const activityLogHeader = activityLogPanel?.querySelector('.op-panel-header');

let orderedLogIds = [];
let syncingLogActions = false;
let clearLogsButton = null;
let clearLogsModal = null;
let clearLogsConfirmButton = null;
let clearLogsCancelButton = null;

function escapeAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function ensureLogActionColumn() {
    if (!activityLogTable) return;
    const headerRow = activityLogTable.querySelector('thead tr');
    if (headerRow && !headerRow.querySelector('[data-log-action-header]')) {
        headerRow.insertAdjacentHTML('beforeend', '<th data-log-action-header>Aksi</th>');
    }

    activityLogTableBody?.querySelectorAll('.op-empty-cell').forEach((cell) => {
        cell.colSpan = 7;
    });
}

function ensureClearLogsButton() {
    if (!activityLogHeader || clearLogsButton) return;
    clearLogsButton = document.createElement('button');
    clearLogsButton.type = 'button';
    clearLogsButton.id = 'btn-clear-activity-logs';
    clearLogsButton.className = 'op-action-btn';
    clearLogsButton.textContent = 'Hapus Semua';
    clearLogsButton.disabled = true;
    activityLogHeader.appendChild(clearLogsButton);
}

function ensureClearLogsModal() {
    if (clearLogsModal) return;
    clearLogsModal = document.createElement('div');
    clearLogsModal.id = 'delete-logs-modal';
    clearLogsModal.className = 'modal-container';
    clearLogsModal.style.display = 'none';
    clearLogsModal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h2>Hapus Semua Log</h2>
                <p class="modal-desc">apakah ingin menghapus semua log</p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-hidupkan" id="btn-cancel-clear-logs" type="button">Batal</button>
                <button class="btn btn-matikan" id="btn-confirm-clear-logs" type="button">Hapus Semua</button>
            </div>
        </div>
    `;
    document.body.appendChild(clearLogsModal);
    clearLogsConfirmButton = clearLogsModal.querySelector('#btn-confirm-clear-logs');
    clearLogsCancelButton = clearLogsModal.querySelector('#btn-cancel-clear-logs');

    clearLogsCancelButton?.addEventListener('click', closeClearLogsModal);
    clearLogsModal.addEventListener('click', (event) => {
        if (event.target === clearLogsModal) closeClearLogsModal();
    });
    clearLogsConfirmButton?.addEventListener('click', clearAllActivityLogs);
}

function openClearLogsModal() {
    ensureClearLogsModal();
    if (!orderedLogIds.length || !clearLogsModal) return;
    clearLogsModal.style.display = 'flex';
}

function closeClearLogsModal() {
    if (!clearLogsModal) return;
    clearLogsModal.style.display = 'none';
    if (clearLogsConfirmButton) {
        clearLogsConfirmButton.disabled = false;
        clearLogsConfirmButton.textContent = 'Hapus Semua';
    }
}

function syncLogActionButtons() {
    if (!activityLogTableBody || syncingLogActions) return;
    syncingLogActions = true;
    ensureLogActionColumn();
    ensureClearLogsButton();

    const rows = Array.from(activityLogTableBody.querySelectorAll('tr'));
    rows.forEach((row, index) => {
        const emptyCell = row.querySelector('.op-empty-cell');
        if (emptyCell) {
            emptyCell.colSpan = 7;
            return;
        }

        const logId = orderedLogIds[index];
        if (!logId) return;

        let actionCell = row.querySelector('[data-log-action-cell]');
        if (!actionCell) {
            actionCell = document.createElement('td');
            actionCell.dataset.logActionCell = 'true';
            row.appendChild(actionCell);
        }

        const currentButton = actionCell.querySelector('.op-log-delete-btn');
        if (currentButton?.dataset.logId === logId) return;
        actionCell.innerHTML = `<button class="op-action-btn op-log-delete-btn" type="button" data-log-id="${escapeAttribute(logId)}">Hapus</button>`;
    });

    if (clearLogsButton) clearLogsButton.disabled = orderedLogIds.length === 0;
    syncingLogActions = false;
}

function deleteActivityLog(logId, button) {
    if (!logId) return;
    if (button) {
        button.disabled = true;
        button.textContent = 'Menghapus...';
    }

    remove(ref(db, `activity_logs/${logId}`)).catch((error) => {
        console.error('Gagal menghapus log aktivitas:', error);
        if (button) {
            button.disabled = false;
            button.textContent = 'Hapus';
        }
    });
}

function clearAllActivityLogs() {
    if (!clearLogsConfirmButton) return;
    clearLogsConfirmButton.disabled = true;
    clearLogsConfirmButton.textContent = 'Menghapus...';

    get(ref(db, 'activity_logs')).then((snapshot) => {
        const logs = snapshot.val() || {};
        const logIds = Object.keys(logs);
        if (!logIds.length) return Promise.resolve();
        return Promise.all(logIds.map((logId) => remove(ref(db, `activity_logs/${logId}`))));
    }).then(() => {
        closeClearLogsModal();
    }).catch((error) => {
        console.error('Gagal menghapus semua log aktivitas:', error);
        if (clearLogsConfirmButton) {
            clearLogsConfirmButton.disabled = false;
            clearLogsConfirmButton.textContent = 'Hapus Semua';
        }
    });
}

if (activityLogTableBody) {
    ensureLogActionColumn();
    ensureClearLogsButton();
    ensureClearLogsModal();

    const activityQuery = query(ref(db, 'activity_logs'), orderByChild('createdAt'), limitToLast(80));
    onValue(activityQuery, (snapshot) => {
        orderedLogIds = Object.entries(snapshot.val() || {})
            .map(([id, value]) => ({ id, ...value }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .map((log) => log.id);
        syncLogActionButtons();
    }, (error) => {
        console.error('Gagal memuat daftar aksi log:', error);
    });

    const observer = new MutationObserver(syncLogActionButtons);
    observer.observe(activityLogTableBody, { childList: true });

    activityLogTableBody.addEventListener('click', (event) => {
        const button = event.target.closest('.op-log-delete-btn');
        if (!button) return;
        deleteActivityLog(button.dataset.logId, button);
    });

    clearLogsButton?.addEventListener('click', openClearLogsModal);
    syncLogActionButtons();
}
