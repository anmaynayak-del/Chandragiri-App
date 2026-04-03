/**
 * FarmWorker Pro - Client-side UI Logic (Version 5.6.0)
 * Enhanced with Smart Export, Backup Management & Improved UI
 */
console.log('App Logic Version 5.6.0 Loaded');

// 1. Firebase System Node Configuration
// NOTE: Firebase Web API keys are intentionally public for client-side apps.
// Security is enforced by Firestore Security Rules (not by hiding these keys).
// See: https://firebase.google.com/docs/projects/api-keys
const firebaseConfig = {
    apiKey: "AIzaSyD3N48EeQTf-CkNvaJ-n61X_KJ1hnA-Z_M",
    authDomain: "changragiri-estate.firebaseapp.com",
    projectId: "changragiri-estate",
    storageBucket: "changragiri-estate.firebasestorage.app",
    messagingSenderId: "560230400253",
    appId: "1:560230400253:web:ae74c4aab9a060adb8fe94"
};

// Application State
let isHydrated = false;
let hasCompletedInitialCloudSync = false;
let isUsingLocalFallback = false;
let hasPendingLocalChanges = false;
let cloudStateUnsubscribe = null;
let state = {
    farms: [],
    workers: [],
    attendance: {},
    paymentHistory: [],
    auditLogs: [],
    extraWages: {},
    backupMeta: { lastBackupAt: null, type: '', monthKey: '' },
    weatherConfig: { lat: 14.6191, lon: 74.8441, locationName: 'Chandragiri Estate' }
};

let currentUser = null;

// === DATA PROTECTION LAYER v3 ===
console.log('🔒 Data Protection Layer Active');

// Emergency Backup System
window.emergencyBackup = function () {
    try {
        const key = currentUser?.isDemo ? 'farmWorkerState_demo' : 'farmWorkerState';
        const data = localStorage.getItem(key);
        if (!data) return null;

        const backup = {
            timestamp: Date.now(),
            user: currentUser?.username || 'unknown',
            data: JSON.parse(data),
            hash: btoa(encodeURIComponent(data)).slice(0, 32),
            version: '5.6.0-protected'
        };

        // Save to multiple backup slots (rotating)
        const backupKey = `backup_${Date.now()}`;
        localStorage.setItem(backupKey, JSON.stringify(backup));

        // Keep only last 5 backups
        const keys = Object.keys(localStorage).filter(k => k.startsWith('backup_'));
        if (keys.length > 5) {
            keys.sort().slice(0, keys.length - 5).forEach(k => localStorage.removeItem(k));
        }

        console.log('📦 Emergency backup created:', backupKey);
        return backup.hash;
    } catch (e) {
        console.error('Backup failed:', e);
        return null;
    }
};

// Data Integrity Validator
function validateDataIntegrity() {
    const errors = [];

    if (!state) {
        errors.push('State is null/undefined');
        return false;
    }

    // Validate workers
    if (state.workers) {
        state.workers.forEach((w, i) => {
            if (!w?.id) errors.push(`Worker ${i} missing id`);
            if (!w?.name || w.name.includes('undefined')) errors.push(`Worker ${i} has invalid name`);
            if (w.dailyWage && w.dailyWage < 0) errors.push(`Worker ${w.name} has negative wage`);
            if (w.initialDebt && w.initialDebt < 0) errors.push(`Worker ${w.name} has negative initial debt`);
        });
    }

    // Validate dates in attendance
    if (state.attendance) {
        Object.keys(state.attendance).forEach(date => {
            if (!isValidISODateKey(date)) errors.push(`Invalid date in attendance: ${date}`);
        });
    }

    if (errors.length > 0) {
        console.warn('Data integrity issues:', errors);
        return false;
    }
    return true;
}

// Auto-backup every 24 hours — only runs after data has loaded from Firestore
setInterval(() => {
    if (!isHydrated) return; // Don't backup before real data has loaded
    const lastBackup = parseInt(localStorage.getItem('last_auto_backup') || '0');
    const now = Date.now();
    if (now - lastBackup > 24 * 60 * 60 * 1000) {
        window.emergencyBackup();
        localStorage.setItem('last_auto_backup', now);
        console.log('🕒 24-hour auto-backup completed');
    }
}, 60 * 60 * 1000); // Check every hour

// Lightweight corruption detection — checks structure not full serialization
setInterval(() => {
    try {
        // Lightweight check: verify core arrays/objects are still valid types
        if (!Array.isArray(state.workers) || !Array.isArray(state.farms) || typeof state.attendance !== 'object') {
            throw new Error('Core state structure corrupted');
        }
    } catch (e) {
        console.error('🚨 DATA CORRUPTION DETECTED!', e.message);
        window.emergencyBackup();
        showToast(t('recovery.dataCorruptionBackupCreated'), true);
    }
}, 30000); // Check every 30 seconds

console.log('✅ Data Protection Layer Loaded');
// === END DATA PROTECTION LAYER ===

// --- Database Engine Setup ---
function createUnavailableDb() {
    const unavailable = () => Promise.reject(new Error('Cloud sync unavailable'));
    const docRef = {
        set: unavailable, get: unavailable, update: unavailable, delete: unavailable,
        onSnapshot: (n, e) => { if (e) setTimeout(() => e(new Error('Offline')), 0); return () => { }; }
    };
    return { collection: () => ({ doc: () => docRef, get: unavailable }) };
}

let db = createUnavailableDb();
if (typeof firebase !== 'undefined') {
    try {
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        // Enable Offline Persistence
        db.enablePersistence({ synchronizeTabs: true }).catch(err => {
            console.warn("Firestore persistence failed", err.code);
        });
    } catch (e) { console.warn('Firebase unavailable', e); }
}

// --- Session Management ---
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;
function setSession(user) {
    localStorage.setItem('sessionUser', JSON.stringify(user));
    localStorage.setItem('sessionExpiry', Date.now() + SESSION_DURATION_MS);
}
function clearSession() {
    localStorage.removeItem('sessionUser');
    localStorage.removeItem('sessionExpiry');
}
function getValidSession() {
    try {
        const user = localStorage.getItem('sessionUser');
        const expiry = parseInt(localStorage.getItem('sessionExpiry'));
        if (user && expiry && Date.now() < expiry) return JSON.parse(user);
        if (user) clearSession();
    } catch (e) { }
    return null;
}

const SAFE_YEAR_MIN = 2000;
const SAFE_YEAR_MAX = 2100;
const MAX_DAILY_WORK_CAPACITY = 1;
const GOOGLE_SHEETS_WEBHOOK_STORAGE_KEY = 'chandragiri_google_sheets_webhook_url';
const GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY = 'chandragiri_google_sheets_last_sync_at';

function cleanText(value) {
    return String(value ?? '').trim();
}

function isCorruptedLabel(value) {
    const normalized = cleanText(value).toLowerCase();
    return !normalized ||
        normalized === 'n/a' ||
        normalized === 'null' ||
        normalized === 'undefined' ||
        normalized === '[object object]' ||
        normalized.includes('system.xml.xmlelement');
}

function isValidISODateKey(value) {
    const date = cleanText(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [year, month, day] = date.split('-').map(Number);
    if (year < SAFE_YEAR_MIN || year > SAFE_YEAR_MAX) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    // Use UTC component checks to avoid timezone shifts (e.g. IST) that can invalidate valid dates.
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return !Number.isNaN(parsed.getTime()) &&
        parsed.getUTCFullYear() === year &&
        (parsed.getUTCMonth() + 1) === month &&
        parsed.getUTCDate() === day;
}

function normalizeAttendanceValue(value) {
    const normalized = cleanText(value).toLowerCase().replace(',', '.');
    if (normalized === 'ot' || normalized === 'overtime') return 'ot';
    if (normalized === '') return null;
    if (normalized === '0.5' || normalized === '.5' || normalized === '1/2' || normalized.includes('half')) return '0.5';
    if (normalized === '1' || normalized === 'full' || normalized.includes('full')) return '1';
    const num = Number(normalized);
    if (!Number.isFinite(num)) return null;
    if (num <= 0) return '0';
    if (num > 1) return null;
    if (Math.abs(num - 1) < 0.0001) return '1';
    if (Math.abs(num - 0.5) < 0.0001) return '0.5';
    return String(Math.round(num * 100) / 100);
}

function isOvertimeValue(value) {
    return normalizeAttendanceValue(value) === 'ot';
}

function hasAttendanceWork(value) {
    const normalized = normalizeAttendanceValue(value);
    return normalized === 'ot' || (Number(normalized) > 0);
}

function parseImportedDate(rawValue) {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        const dateObj = new Date(Math.round((rawValue - 25569) * 86400 * 1000));
        const iso = dateObj.toISOString().split('T')[0];
        return isValidISODateKey(iso) ? iso : '';
    }
    const raw = cleanText(rawValue);
    if (!raw) return '';
    if (isValidISODateKey(raw)) return raw;
    const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashDate) {
        const [, dd, mm, yyyy] = slashDate;
        const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        return isValidISODateKey(iso) ? iso : '';
    }
    return '';
}

function parseImportedJsonArray(rawValue) {
    if (Array.isArray(rawValue)) return rawValue;
    const raw = cleanText(rawValue);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
        return [];
    }
}

function sanitizeFarmName(name, farmId = '') {
    const text = cleanText(name);
    if (isCorruptedLabel(text)) return farmId ? t('common.farmLabel', { id: farmId }) : '';
    return text;
}

function sanitizeWorkerName(name, workerId = '') {
    const text = cleanText(name);
    if (isCorruptedLabel(text)) return workerId ? t('common.workerLabel', { id: workerId }) : '';
    return text;
}

function sanitizeAttendance(attendance, options = {}) {
    const cleaned = {};
    const farms = Array.isArray(options.farms) ? options.farms : [];
    const workers = Array.isArray(options.workers) ? options.workers : [];
    const farmIdSet = new Set(farms.map(f => cleanText(f?.id)).filter(Boolean));
    const workerIdSet = new Set(workers.map(w => cleanText(w?.id)).filter(Boolean));
    const farmNameToId = new Map();
    const workerNameToId = new Map();
    farms.forEach(farm => {
        const normalizedName = cleanText(farm?.name).toLowerCase();
        const farmId = cleanText(farm?.id);
        if (normalizedName && farmId && !farmNameToId.has(normalizedName)) farmNameToId.set(normalizedName, farmId);
    });
    workers.forEach(worker => {
        const normalizedName = cleanText(worker?.name).toLowerCase();
        const workerId = cleanText(worker?.id);
        if (normalizedName && workerId && !workerNameToId.has(normalizedName)) workerNameToId.set(normalizedName, workerId);
    });
    if (!attendance || typeof attendance !== 'object') return cleaned;
    Object.keys(attendance).forEach(dateKey => {
        const safeDate = parseImportedDate(dateKey) || cleanText(dateKey);
        if (!isValidISODateKey(safeDate)) return;
        const farmMap = attendance[dateKey];
        if (!farmMap || typeof farmMap !== 'object') return;
        Object.keys(farmMap).forEach(farmId => {
            const rawFarmKey = cleanText(farmId);
            if (!rawFarmKey) return;
            const safeFarmId = farmIdSet.has(rawFarmKey)
                ? rawFarmKey
                : (farmNameToId.get(rawFarmKey.toLowerCase()) || rawFarmKey);
            if (!safeFarmId) return;
            const workerMap = farmMap[farmId];
            if (!workerMap || typeof workerMap !== 'object') return;
            Object.keys(workerMap).forEach(workerId => {
                const rawWorkerKey = cleanText(workerId);
                if (!rawWorkerKey) return;
                const safeWorkerId = workerIdSet.has(rawWorkerKey)
                    ? rawWorkerKey
                    : (workerNameToId.get(rawWorkerKey.toLowerCase()) || rawWorkerKey);
                if (!safeWorkerId) return;
                const safeValue = normalizeAttendanceValue(workerMap[workerId]);
                // ✅ FIX 2 (sanitize step): Skip storing '0' values — absent means no entry.
                if (safeValue === null || safeValue === '0') return;
                if (!cleaned[safeDate]) cleaned[safeDate] = {};
                if (!cleaned[safeDate][safeFarmId]) cleaned[safeDate][safeFarmId] = {};
                cleaned[safeDate][safeFarmId][safeWorkerId] = safeValue;
            });
            if (cleaned[safeDate] && Object.keys(cleaned[safeDate][safeFarmId] || {}).length === 0) {
                delete cleaned[safeDate][safeFarmId];
            }
        });
        if (cleaned[safeDate] && Object.keys(cleaned[safeDate]).length === 0) {
            delete cleaned[safeDate];
        }
    });
    return cleaned;
}

function sanitizeFarms(farms) {
    if (!Array.isArray(farms)) return [];
    const byId = new Map();
    farms.forEach(raw => {
        const farmId = cleanText(raw?.id);
        if (!farmId) return;
        const existing = byId.get(farmId) || {};
        const safeName = sanitizeFarmName(raw?.name, farmId) || sanitizeFarmName(existing.name, farmId);
        byId.set(farmId, {
            ...existing,
            ...raw,
            id: farmId,
            name: safeName,
            location: cleanText(raw?.location || existing.location),
            capacity: cleanText(raw?.capacity || existing.capacity)
        });
    });
    return Array.from(byId.values()).filter(farm => cleanText(farm.name));
}

function normalizeSettledPeriods(periods) {
    if (!Array.isArray(periods)) return [];
    return periods
        .map(p => normalizeDateRange(cleanText(p?.start), cleanText(p?.end)))
        .filter(Boolean);
}

function sanitizeOvertimeEntries(entries) {
    const rawEntries = Array.isArray(entries) ? entries : parseImportedJsonArray(entries);
    return rawEntries
        .map((rawEntry, index) => {
            if (!rawEntry || typeof rawEntry !== 'object') return null;
            const safeDate = parseImportedDate(rawEntry.date || rawEntry.entryDate || rawEntry.loggedAt) || '';
            const amount = Number(rawEntry.amount ?? rawEntry.value ?? rawEntry.wage ?? 0);
            if (!Number.isFinite(amount)) return null;
            return {
                ...rawEntry,
                id: cleanText(rawEntry.id) || `ot_${safeDate || 'undated'}_${index}`,
                date: safeDate,
                amount: Number(amount.toFixed(2)),
                note: cleanText(rawEntry.note || rawEntry.reason || rawEntry.label)
            };
        })
        .filter(Boolean);
}

function sanitizeWorkers(workers, attendance = {}) {
    if (!Array.isArray(workers)) workers = [];

    const byId = new Map();
    workers.forEach(raw => {
        const workerId = cleanText(raw?.id);
        if (!workerId) return;
        const existing = byId.get(workerId) || {};
        const safeName = sanitizeWorkerName(raw?.name, workerId) || sanitizeWorkerName(existing.name, workerId);
        const safeLastSettledDate = isValidISODateKey(raw?.lastSettledDate)
            ? cleanText(raw.lastSettledDate)
            : (isValidISODateKey(existing.lastSettledDate) ? cleanText(existing.lastSettledDate) : '');
        const safeSettledPeriods = normalizeSettledPeriods(
            Array.isArray(raw?.settledPeriods) ? raw.settledPeriods : existing.settledPeriods
        );
        byId.set(workerId, {
            ...existing,
            ...raw,
            id: workerId,
            name: safeName,
            role: cleanText(raw?.role || existing.role) || 'Daily Worker',
            dailyWage: Number(raw?.dailyWage ?? existing.dailyWage ?? 0) || 0,
            overtimeCharge: Number(raw?.overtimeCharge ?? existing.overtimeCharge ?? 0) || 0,
            initialDebt: Number(raw?.initialDebt ?? existing.initialDebt ?? 0) || 0,
            paidAmount: Number(raw?.paidAmount ?? existing.paidAmount ?? 0) || 0,
            loanAmount: Number(raw?.loanAmount ?? existing.loanAmount ?? 0) || 0,
            loanResetBaseline: Number(raw?.loanResetBaseline ?? existing.loanResetBaseline ?? 0) || 0,
            lastSettledDate: safeLastSettledDate,
            phone: cleanText(raw?.phone || existing.phone),
            bankName: cleanText(raw?.bankName || existing.bankName),
            accountNum: cleanText(raw?.accountNum || existing.accountNum),
            ifsc: cleanText(raw?.ifsc || existing.ifsc),
            settledPeriods: safeSettledPeriods,
            overtime: sanitizeOvertimeEntries(
                Object.prototype.hasOwnProperty.call(raw || {}, 'overtime')
                    ? raw.overtime
                    : existing.overtime
            )
        });
    });

    return Array.from(byId.values()).filter(worker => !cleanText(worker.name).toLowerCase().includes('recovered worker'));
}

function sanitizePaymentHistory(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
        .map(raw => {
            const loggedAt = cleanText(raw?.loggedAt);
            const entryDate = parseImportedDate(raw?.entryDate) ||
                (loggedAt ? cleanText(loggedAt).split('T')[0] : '');
            const workerId = cleanText(raw?.workerId);
            const workerName = sanitizeWorkerName(raw?.workerName, workerId);
            const type = cleanText(raw?.type || 'payment');
            const entryId = cleanText(raw?.id) || [
                workerId || 'worker',
                type || 'event',
                entryDate || 'date',
                cleanText(raw?.loggedAt || ''),
                cleanText(raw?.amount || raw?.paidAmount || raw?.loanAmount || '0')
            ].join('_');
            return {
                id: entryId,
                loggedAt: loggedAt || new Date().toISOString(),
                entryDate: isValidISODateKey(entryDate) ? entryDate : getTodayLocalISO(),
                workerId,
                workerName,
                type,
                paidAmount: Number(raw?.paidAmount ?? raw?.amount ?? 0) || 0,
                addedLoanAmount: Number(raw?.addedLoanAmount ?? 0) || 0,
                setLoanAmount: Number(raw?.setLoanAmount ?? 0) || 0,
                previousPaidAmount: Number(raw?.previousPaidAmount ?? 0) || 0,
                newPaidAmount: Number(raw?.newPaidAmount ?? 0) || 0,
                previousLoanAmount: Number(raw?.previousLoanAmount ?? 0) || 0,
                newLoanAmount: Number(raw?.newLoanAmount ?? 0) || 0,
                settledRangeStart: parseImportedDate(raw?.settledRangeStart) || '',
                settledRangeEnd: parseImportedDate(raw?.settledRangeEnd) || '',
                note: cleanText(raw?.note)
            };
        })
        .filter(entry => entry.workerId && entry.workerName)
        .sort((a, b) => {
            if (a.entryDate !== b.entryDate) return a.entryDate.localeCompare(b.entryDate);
            if (a.loggedAt !== b.loggedAt) return a.loggedAt.localeCompare(b.loggedAt);
            return a.id.localeCompare(b.id);
        });
}

function sanitizeStateForPersistence(rawState) {
    const next = { ...rawState };
    next.farms = sanitizeFarms(next.farms);
    next.workers = sanitizeWorkers(next.workers, next.attendance);
    next.attendance = sanitizeAttendance(next.attendance, { farms: next.farms, workers: next.workers });
    next.paymentHistory = sanitizePaymentHistory(next.paymentHistory);
    if (!Array.isArray(next.auditLogs)) next.auditLogs = [];
    if (!next.extraWages || typeof next.extraWages !== 'object') next.extraWages = {};
    if (!next.backupMeta || typeof next.backupMeta !== 'object') next.backupMeta = { lastBackupAt: null, type: '', monthKey: '' };
    // Fix 4: Ensure weatherConfig is always initialized (previously missing from sanitize)
    if (!next.weatherConfig || typeof next.weatherConfig !== 'object') {
        next.weatherConfig = { lat: 14.6191, lon: 74.8441, locationName: 'Chandragiri Estate' };
    }
    return next;
}

function mergeRecordsById(cloudItems, localItems) {
    const merged = new Map();
    (Array.isArray(cloudItems) ? cloudItems : []).forEach(item => {
        const itemId = cleanText(item?.id);
        if (!itemId) return;
        merged.set(itemId, { ...item, id: itemId });
    });
    (Array.isArray(localItems) ? localItems : []).forEach(item => {
        const itemId = cleanText(item?.id);
        if (!itemId) return;
        merged.set(itemId, { ...(merged.get(itemId) || {}), ...item, id: itemId });
    });
    return Array.from(merged.values());
}

function mergeCloudStateWithLocalEdits(cloudData, localData) {
    const safeCloud = sanitizeStateForPersistence({ ...state, ...cloudData });
    const safeLocal = sanitizeStateForPersistence(localData);
    return sanitizeStateForPersistence({
        ...safeCloud,
        ...safeLocal,
        farms: mergeRecordsById(safeCloud.farms, safeLocal.farms),
        workers: mergeRecordsById(safeCloud.workers, safeLocal.workers),
        attendance: safeLocal.attendance,
        paymentHistory: mergeRecordsById(safeCloud.paymentHistory, safeLocal.paymentHistory),
        auditLogs: Array.isArray(safeLocal.auditLogs) && safeLocal.auditLogs.length > 0
            ? safeLocal.auditLogs
            : (safeCloud.auditLogs || []),
        extraWages: { ...(safeCloud.extraWages || {}), ...(safeLocal.extraWages || {}) },
        backupMeta: { ...(safeCloud.backupMeta || {}), ...(safeLocal.backupMeta || {}) },
        weatherConfig: { ...(safeCloud.weatherConfig || {}), ...(safeLocal.weatherConfig || {}) }
    });
}

function getFirestoreStatePayload(sourceState = state) {
    const safeState = sanitizeStateForPersistence(sourceState);
    return {
        farms: safeState.farms,
        workers: safeState.workers,
        attendance: safeState.attendance,
        paymentHistory: safeState.paymentHistory || [],
        auditLogs: safeState.auditLogs || [],
        extraWages: safeState.extraWages || {},
        backupMeta: safeState.backupMeta || {},
        weatherConfig: safeState.weatherConfig || {}
    };
}

function syncStateToFirestore(sourceState = state, options = { merge: true }) {
    if (!currentUser || currentUser.isDemo) return Promise.resolve();
    return db.collection("appData").doc("masterState").set(getFirestoreStatePayload(sourceState), options);
}

function isValidGoogleSheetsWebhookUrl(url) {
    const text = cleanText(url);
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(text);
}

function getStoredGoogleSheetsWebhookUrl() {
    try {
        return cleanText(localStorage.getItem(GOOGLE_SHEETS_WEBHOOK_STORAGE_KEY));
    } catch (_error) {
        return '';
    }
}

function setStoredGoogleSheetsWebhookUrl(url) {
    try {
        if (url) localStorage.setItem(GOOGLE_SHEETS_WEBHOOK_STORAGE_KEY, cleanText(url));
        else localStorage.removeItem(GOOGLE_SHEETS_WEBHOOK_STORAGE_KEY);
    } catch (_error) { }
}

function getStoredGoogleSheetsLastSyncAt() {
    try {
        const raw = Number(localStorage.getItem(GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY));
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    } catch (_error) {
        return 0;
    }
}

function setStoredGoogleSheetsLastSyncAt(timestamp) {
    try {
        localStorage.setItem(GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY, String(timestamp));
    } catch (_error) { }
}

function updateGoogleSheetsSyncStatus() {
    const statusEl = document.getElementById('google-sheets-sync-status');
    if (!statusEl) return;
    const url = getStoredGoogleSheetsWebhookUrl();
    const lastSyncAt = getStoredGoogleSheetsLastSyncAt();
    if (!url) {
        statusEl.innerText = t('sheets.syncNotConfigured');
        return;
    }
    if (!lastSyncAt) {
        statusEl.innerText = t('sheets.readyToUpload');
        return;
    }
    const savedAt = new Date(lastSyncAt).toLocaleString(window.getCurrentLocale?.() || undefined, { dateStyle: 'medium', timeStyle: 'short' });
    statusEl.innerText = t('sheets.lastUpload', { savedAt });
}

// --- Persistence ---
function saveState() {
    state = sanitizeStateForPersistence(state);
    // Run data integrity check and log — now called here instead of in the broken wrapper
    if (!validateDataIntegrity()) {
        console.warn('saveState: Data integrity issue detected — saving anyway but check logs.');
    }
    if (currentUser) setSession(currentUser);
    const key = currentUser?.isDemo ? 'farmWorkerState_demo' : 'farmWorkerState';
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { }

    if (!hasCompletedInitialCloudSync && currentUser && !currentUser.isDemo) {
        hasPendingLocalChanges = true;
    }

    // SAFETY: Never write to Firestore if we haven't even loaded the data yet OR if in demo mode
    if (!isHydrated || (currentUser && currentUser.isDemo)) return;

    // SAFETY: Never write an empty state to Firestore — this prevents race conditions where
    // the blank initial state overwrites real cloud data before it has loaded.
    const hasNoData = (!state.farms || state.farms.length === 0) && (!state.workers || state.workers.length === 0);
    if (hasNoData) {
        console.warn('saveState: Blocked Firestore write — state appears uninitialized (no farms or workers).');
        return;
    }

    if (currentUser && !currentUser.isDemo) {
        syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
    }
}

function showLoading(show) {
    const el = document.getElementById('splash-screen');
    if (!el) return;
    if (show) {
        el.style.display = 'flex';
        el.classList.remove('fade-out');
    } else {
        el.classList.add('fade-out');
        setTimeout(() => el.style.display = 'none', 600);
    }
}

function loadState() {
    showLoading(true);
    isHydrated = false;
    hasCompletedInitialCloudSync = false;
    isUsingLocalFallback = false;
    hasPendingLocalChanges = false;
    if (typeof cloudStateUnsubscribe === 'function') {
        cloudStateUnsubscribe();
        cloudStateUnsubscribe = null;
    }
    const key = currentUser?.isDemo ? 'farmWorkerState_demo' : 'farmWorkerState';
    const saved = localStorage.getItem(key);
    const hasLocalCache = !!saved;
    if (saved) {
        try {
            const p = JSON.parse(saved);
            state = sanitizeStateForPersistence({ ...state, ...p });
            // ✅ FIX 1: Removed the erroneous `if (currentUser?.isDemo) renderAll()` call here.
            // Demo mode's renderAll() is correctly called once in the early-return block below,
            // preventing a double-render that caused state flicker and wasted cycles.
        } catch (e) { }
    }

    // Safety timeout: If DB doesn't respond in 5 seconds, show what we have
    const loadTimeout = setTimeout(() => {
        showLoading(false);
        if (!hasCompletedInitialCloudSync && hasLocalCache) {
            console.warn("Load timeout: using local cache until cloud sync responds.");
            isHydrated = true;
            isUsingLocalFallback = true;
            renderAll();
            return;
        }
        if (!isHydrated) console.warn("Load timeout: showing local data only.");
    }, 5000);

    if (currentUser?.isDemo) {
        clearTimeout(loadTimeout);
        hasCompletedInitialCloudSync = true;
        isHydrated = true;
        isUsingLocalFallback = false;
        showLoading(false);
        renderAll(); // ✅ FIX 1: Only one renderAll() call for demo mode (the original double call is removed above)
        return;
    }

    // ✅ FIX: onSnapshot now distinguishes between initial load and live updates.
    // After hydration, snapshots caused by our OWN pending writes are skipped using
    // doc.metadata.hasPendingWrites — this prevents the race condition where Firestore
    // fires a snapshot immediately after saveState() writes, overwriting local changes
    // (e.g. old attendance edits) before the server confirms the write.
    cloudStateUnsubscribe = db.collection("appData").doc("masterState").onSnapshot(doc => {
        clearTimeout(loadTimeout);

        if (!hasCompletedInitialCloudSync) {
            hasCompletedInitialCloudSync = true;
            // ── Initial load only ──────────────────────────────────────────
            if (doc.exists) {
                const cloudData = doc.data();
                const cloudHasData = (cloudData.workers?.length > 0 || cloudData.farms?.length > 0);
                const localHasData = (state.workers?.length > 0 || state.farms?.length > 0);

                if (isUsingLocalFallback && hasPendingLocalChanges && localHasData) {
                    state = mergeCloudStateWithLocalEdits(cloudData, state);
                    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { }
                    isHydrated = true;
                    isUsingLocalFallback = false;
                    showLoading(false);
                    renderAll();
                    hasPendingLocalChanges = false;
                    syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
                } else if (cloudHasData || !localHasData) {
                    // Normal case: use cloud data (it has content, or both are empty)
                    state = sanitizeStateForPersistence({ ...state, ...cloudData });
                    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { }
                    isHydrated = true;
                    isUsingLocalFallback = false;
                    showLoading(false);
                    renderAll();
                } else {
                    // Cloud is empty but local cache has data — cloud was likely wiped accidentally.
                    // Restore from local cache back to Firestore.
                    console.warn('loadState: Cloud data is empty but local cache has data. Auto-restoring to cloud...');
                    isHydrated = true;
                    isUsingLocalFallback = false;
                    showLoading(false);
                    renderAll();
                    syncStateToFirestore(state, { merge: true }).then(() => showToast(t('recovery.localCacheRestored')))
                        .catch(e => console.error('Auto-restore failed:', e));
                }
            } else {
                isHydrated = true;
                isUsingLocalFallback = false;
                showLoading(false);
                renderAll();
                if (hasPendingLocalChanges) {
                    hasPendingLocalChanges = false;
                    syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
                }
            }
            return; // ← don't fall through to the live-update block
        }

        // ── Live updates AFTER initial load ───────────────────────────────
        // Skip snapshots caused by our OWN pending writes.
        // hasPendingWrites = true means Firestore applied the write locally
        // but hasn't confirmed it with the server yet — our local state is
        // already correct, so overwriting it here is what caused the revert.
        if (doc.metadata.hasPendingWrites) return;

        // This is a server-confirmed update (or a change from another tab/user).
        if (doc.exists) {
            const cloudData = doc.data();
            state = sanitizeStateForPersistence({ ...state, ...cloudData });
            try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { }
            renderAll();
        }
    }, err => {
        console.error("Firestore Error:", err);
        clearTimeout(loadTimeout);
        hasCompletedInitialCloudSync = true;
        isHydrated = true;
        isUsingLocalFallback = false;
        showLoading(false);
        renderAll();
    });
}

let renderTimer;
function renderAll() {
    state = sanitizeStateForPersistence(state);

    // Debounce renderAll to prevent performance collapse during rapid state changes
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        renderDashboard();
        renderFarmsList();
        renderWorkersList();
        updateFarmDropdown();
        if (currentUser?.permissions?.canEdit) renderAttendanceView();
        else renderAttendanceSummary();
        renderPaymentsTable();
        updateGreetings();
        if (document.getElementById('admin-modal')?.classList.contains('active')) {
            window.renderActivityLog();
            window.refreshUserList();
        }
    }, 50);
}

// --- Auth & Navigation ---
window.doLogin = async function () {
    const user = document.getElementById('login-user').value.trim().toLowerCase();
    const pass = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    try {
        const snap = await db.collection('users').doc(user).get();
        if (snap.exists && snap.data().password === pass) {
            const d = snap.data();
            currentUser = { ...d, username: user };
            setSession(currentUser);
            setLanguage(currentUser.language || 'en', { rerender: false });
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('main-container').style.display = 'block';
            applyPermissions(currentUser.permissions || {});
            loadState();
            if (window.recordLoginActivity) window.recordLoginActivity(user);
        } else {
            errEl.innerText = t('login.invalid');
            errEl.style.display = 'block';
        }
    } catch (e) {
        if (pass === 'EMERGENCY_ACCESS_DISABLED_PLEASE_CONTACT_ADMIN') {
            console.error('Emergency access attempted but disabled');
            errEl.innerText = t('login.emergencyAccessDisabled');
            errEl.style.display = 'block';
            return;
        }
        console.warn("Login failed:", e);
        errEl.innerText = (e.code === 'resource-exhausted') ? t('login.serverQuotaExceeded') : t('login.noInternet');
        errEl.style.display = 'block';
    }
};

window.doLogout = function () {
    currentUser = null;
    clearSession();
    window.location.reload();
};

function applyPermissions(perms) {
    const hide = (id, show) => {
        const el = document.getElementById(id);
        if (el) el.parentElement.style.display = show !== false ? '' : 'none';
    };

    hide('nav-farms', perms.farms);
    hide('nav-workers', perms.workers);
    hide('nav-attendance', perms.attendance);
    hide('nav-payments', perms.payments);

    // NEW: Hide backup features if user doesn't have permission
    const backupPanel = document.getElementById('admin-backup-panel');
    const exportBtn = document.querySelector('[onclick*="exportAttendanceExcel"]');
    const backupBtn = document.querySelector('[onclick*="backupNow"]');
    const sheetsInput = document.getElementById('google-sheets-webhook-url');
    const sheetsSyncBtn = document.getElementById('sync-google-sheets-btn');

    if (backupPanel) backupPanel.style.display = (perms.canManageBackup && currentUser?.isAdmin) ? 'flex' : 'none';
    if (exportBtn) exportBtn.style.display = perms.canManageBackup ? '' : 'none';
    if (backupBtn) backupBtn.style.display = perms.canManageBackup ? '' : 'none';
    if (sheetsInput) sheetsInput.style.display = perms.canManageBackup ? '' : 'none';
    if (sheetsSyncBtn) sheetsSyncBtn.style.display = perms.canManageBackup ? '' : 'none';

    const adminBtn = document.getElementById('nav-admin-btn');
    if (adminBtn) adminBtn.style.display = currentUser.isAdmin ? 'block' : 'none';

    document.querySelectorAll('.edit-gate').forEach(el => el.style.display = perms.canEdit ? '' : 'none');

    // Auto-select first farm if none selected
    const farmSelect = document.getElementById('attendance-farm-select');
    if (farmSelect && !farmSelect.value && state.farms.length > 0) {
        farmSelect.value = state.farms[0].id;
    }

    if (perms.canEdit) {
        window.renderAttendanceView();
    } else {
        window.renderAttendanceSummary();
    }

    activateSection('dashboard');
}

window.activateSection = function (id) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-target') === id));
    document.querySelectorAll('.view-section').forEach(s => s.classList.toggle('active', s.id === id));
    if (id === 'attendance') {
        if (currentUser?.permissions?.canEdit) renderAttendanceView();
        else renderAttendanceSummary();
    }
    if (id === 'payments') renderPaymentsTable();
    if (id === 'dashboard') renderDashboard();
    if (id === 'farms') renderFarmsList();
    if (id === 'workers') renderWorkersList();
    if (id === 'profile') populateProfileForm();
    window.closeMobileSidebar();
};

window.closeMobileSidebar = function () {
    document.body.classList.remove('mobile-nav-open');
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
    }
};

window.toggleMobileSidebar = function () {
    const willOpen = !document.body.classList.contains('mobile-nav-open');
    document.body.classList.toggle('mobile-nav-open', willOpen);
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('active', willOpen);
};

function applyTheme(theme) {
    const nextTheme = ['light', 'dark', 'vibrant'].includes(theme) ? theme : 'vibrant';
    document.documentElement.setAttribute('data-theme', nextTheme);
    try { localStorage.setItem('appTheme', nextTheme); } catch (_error) { }
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tb') === nextTheme);
    });
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
        const colors = { light: '#F8FAFC', dark: '#0F172A', vibrant: '#8B5CF6' };
        themeColor.setAttribute('content', colors[nextTheme] || colors.vibrant);
    }
}

window.setTheme = function (theme) {
    applyTheme(theme);
};

// --- Weather Feature ---
let lastWeatherFetch = 0;
let isFetchingWeather = false;
async function fetchWeather() {
    if (!state.weatherConfig?.lat || isFetchingWeather) return;

    // Cache weather for 10 minutes
    const now = Date.now();
    if (now - lastWeatherFetch < 10 * 60 * 1000) return;

    isFetchingWeather = true;
    lastWeatherFetch = now; // Set immediately to prevent race condition loop

    const { lat, lon, locationName } = state.weatherConfig;
    try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&windspeed_unit=kmh`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderWeatherUI(data.current_weather, locationName);
    } catch (e) {
        renderWeatherOffline(locationName);
        // Keep the 10-minute cache even on failure to respect API rate limits
        lastWeatherFetch = now;
    } finally {
        isFetchingWeather = false;
    }
}

function getWeatherIconInfo(code) {
    const hour = new Date().getHours();
    const isNight = hour >= 18 || hour < 6;
    if (code === 0) return { i: isNight ? '🌙' : '☀️', c: isNight ? 'icon-moon' : 'icon-sun', d: 'weather.clear' };
    if (code <= 3) return { i: isNight ? '☁️' : '🌤️', c: 'icon-cloud', d: 'weather.cloudy' };
    if (code >= 51 && code <= 67) return { i: '🌧️', c: 'icon-rain', d: 'weather.rain' };
    if (code >= 80 && code <= 82) return { i: '🌦️', c: 'icon-rain', d: 'weather.showers' };
    if (code >= 95) return { i: '⛈️', c: 'icon-storm', d: 'weather.storm' };
    return { i: '☁️', c: 'icon-cloud', d: 'weather.cloudy' };
}

function renderWeatherUI(curr, name) {
    const container = document.getElementById('dashboard-weather-container');
    if (!container) return;
    const info = getWeatherIconInfo(curr.weathercode);
    container.innerHTML = `
        <div class="weather-card stagger-anim">
            <div class="weather-info-main">
                <div class="weather-icon-container ${info.c}">${info.i}</div>
                <div class="weather-temp">${Math.round(curr.temperature)}°C</div>
                <div class="weather-meta">
                    <div class="weather-city">${escapeHtml(name)}</div>
                    <div class="weather-desc">${t(info.d)}</div>
                </div>
            </div>
            <div class="weather-details-grid">
                <div class="weather-detail-item"><div class="weather-detail-label">${t('common.wind')}</div><div class="weather-detail-val">${curr.windspeed} km/h</div></div>
                <div class="weather-detail-item"><div class="weather-detail-label">${t('common.timeLabel')}</div><div class="weather-detail-val">${new Date().toLocaleTimeString(window.getCurrentLocale?.() || undefined, { hour: '2-digit', minute: '2-digit' })}</div></div>
            </div>
        </div>
    `;
    container.style.display = 'block';
}

function renderWeatherOffline(name) {
    const container = document.getElementById('dashboard-weather-container');
    if (container) container.innerHTML = `<div class="weather-card"><p>${escapeHtml(name)} - ${t('weather.offline')}</p></div>`;
}

window.saveWeatherConfig = function () {
    const lat = parseFloat(document.getElementById('admin-weather-lat').value);
    const lon = parseFloat(document.getElementById('admin-weather-lon').value);
    const name = document.getElementById('admin-weather-location-name').value.trim();
    if (isNaN(lat) || isNaN(lon) || !name) return alert(t('admin.fillBothFields'));
    state.weatherConfig = { lat, lon, locationName: name };
    saveState();
    fetchWeather();
    showToast(t('weather.updated'));
};

// --- Admin Panel ---
window.openAdminPanel = function () {
    if (!currentUser?.isAdmin) return;
    window.toggleModal('admin-modal');
    window.refreshUserList();
    window.renderActivityLog();
    if (state.weatherConfig) {
        document.getElementById('admin-weather-lat').value = state.weatherConfig.lat || '';
        document.getElementById('admin-weather-lon').value = state.weatherConfig.lon || '';
        document.getElementById('admin-weather-location-name').value = state.weatherConfig.locationName || '';
    }
};

function refreshAdminUserFormText(usernameOverride) {
    const titleEl = document.getElementById('admin-form-title');
    const submitEl = document.getElementById('admin-user-submit');
    const usernameEl = document.getElementById('new-username');
    const editingUsername = cleanText(usernameOverride || usernameEl?.value || '');
    const isEditing = !!(usernameEl?.readOnly && editingUsername);
    if (titleEl) {
        titleEl.innerText = isEditing
            ? t('admin.editUserTitle', { username: editingUsername })
            : t('admin.addNewUser');
    }
    if (submitEl) submitEl.innerText = isEditing ? t('common.save') : t('admin.addUser');
}

window.refreshUserList = async function () {
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    try {
        const snap = await db.collection('users').get();
        // Fix 6: Collect all HTML first, then set innerHTML once (avoids innerHTML += loop corruption)
        const rows = [];
        snap.forEach(doc => {
            const u = doc.data();
            const safeUsername = JSON.stringify(u.username || '');
            rows.push(`
                <div class="admin-user-card" style="background:var(--surface-solid); padding:16px; border-radius:var(--radius-sm); border:1px solid var(--border); margin-bottom:12px;">
                    <div class="admin-user-header" style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHtml(u.username)}</strong> 
                            ${u.isAdmin ? `<span style="color:var(--primary); font-size:0.75rem;">(${t('common.adminTag')})</span>` : ''}
                            ${u.isGuest ? `<span style="color:var(--text-warning, #D97706); font-size:0.75rem;">(${t('common.guestTag')})</span>` : ''}
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button class="btn btn-secondary" style="padding:4px 10px; font-size:0.75rem;" onclick='window.editUser(${safeUsername})'>${t('common.edit')}</button>
                            <button class="btn" style="padding:4px 10px; font-size:0.75rem; border:1px solid #ef4444; color:#ef4444; background:transparent;" onclick='window.deleteUser(${safeUsername})'>${t('common.delete')}</button>
                        </div>
                    </div>
                </div>`);
        });
        list.innerHTML = rows.join('') || `<p class="text-muted">${t('admin.noUsers')}</p>`;
    } catch (e) { list.innerHTML = `<p class="text-muted">${t('admin.errorLoadingUsers')}</p>`; }
};

window.editUser = async function (user) {
    try {
        const snap = await db.collection('users').doc(user).get();
        if (!snap.exists) return;
        const u = snap.data();
        document.getElementById('new-username').value = u.username;
        document.getElementById('new-password').value = u.password;
        document.getElementById('new-is-admin').checked = !!u.isAdmin;
        document.getElementById('new-is-guest').checked = !!u.isGuest;
        document.getElementById('new-is-demo').checked = !!u.isDemo;

        const p = u.permissions || {};
        document.getElementById('p-farms').checked = !!p.farms;
        document.getElementById('p-workers').checked = !!p.workers;
        document.getElementById('p-attendance').checked = !!p.attendance;
        document.getElementById('p-payments').checked = !!p.payments;
        document.getElementById('p-edit').checked = !!p.canEdit;
        document.getElementById('p-backup').checked = !!p.canManageBackup; // NEW PERMISSION

        document.getElementById('new-username').readOnly = true;
        refreshAdminUserFormText(user);

        showToast(t('admin.editingUser', { username: user }));
    } catch (e) { alert(t('admin.failedLoadUserData')); }
};

window.clearUserForm = function () {
    document.getElementById('new-username').value = '';
    document.getElementById('new-username').readOnly = false;
    document.getElementById('new-password').value = '';
    document.getElementById('new-is-admin').checked = false;
    document.getElementById('new-is-guest').checked = false;
    document.getElementById('new-is-demo').checked = false;

    document.getElementById('p-farms').checked = true;
    document.getElementById('p-workers').checked = true;
    document.getElementById('p-attendance').checked = true;
    document.getElementById('p-payments').checked = true;
    document.getElementById('p-edit').checked = true;
    document.getElementById('p-backup').checked = false; // NEW PERMISSION - default false for security

    refreshAdminUserFormText();
};

window.renderActivityLog = function () {
    const logEl = document.getElementById('admin-activity-log');
    if (!logEl) return;
    logEl.innerHTML = (state.auditLogs || []).map(l => `
        <div style="margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid var(--border);">
            <div style="font-weight:600; color:var(--primary); font-size:0.75rem;">${new Date(l.time).toLocaleTimeString(window.getCurrentLocale?.() || undefined, { hour: '2-digit', minute: '2-digit' })} - ${escapeHtml(l.user)}</div>
            <div style="font-size:0.8rem;">${escapeHtml(l.action)}</div>
        </div>
    `).join('') || `<p class="text-muted">${t('admin.noRecentActivity')}</p>`;
};

window.addNewUser = async function () {
    const u = document.getElementById('new-username').value.trim().toLowerCase();
    const p = document.getElementById('new-password').value;
    if (!u || !p) return alert(t('admin.fillBothFields'));
    const perms = {
        farms: document.getElementById('p-farms').checked,
        workers: document.getElementById('p-workers').checked,
        attendance: document.getElementById('p-attendance').checked,
        payments: document.getElementById('p-payments').checked,
        canEdit: document.getElementById('p-edit').checked,
        canManageBackup: document.getElementById('p-backup').checked // NEW PERMISSION
    };
    const isAdmin = document.getElementById('new-is-admin').checked;
    const isGuest = document.getElementById('new-is-guest').checked;
    const isDemo = document.getElementById('new-is-demo').checked;

    try {
        await db.collection('users').doc(u).set({
            username: u, password: p, isAdmin, isGuest, isDemo, permissions: perms, language: 'en'
        }, { merge: true });

        showToast(t('admin.userSaved'));
        window.clearUserForm();
        window.refreshUserList();
    } catch (e) {
        alert(t('admin.addUserError'));
    }
};

// --- Helpers ---
function calculateWorkerAttendanceTotals(workerId, options = {}) {
    const w = state.workers.find(x => x.id === workerId);
    if (!w) return { totalDays: 0, earnedAmount: 0, extraAmount: 0 };

    const includeSettled = options.includeSettled === true;
    const settledPeriods = normalizeSettledPeriods(w.settledPeriods);
    const safeLastSettledDate = isValidISODateKey(w.lastSettledDate) ? cleanText(w.lastSettledDate) : '';
    const dailyWage = Number(w.dailyWage || 0) || 0;
    const overtimeCharge = Number(w.overtimeCharge || 0) || 0;
    let totalDays = 0;
    let earnedAttendance = 0;
    for (const date in state.attendance) {
        let settled = !!(safeLastSettledDate && date <= safeLastSettledDate);
        if (settledPeriods.length) settled = settled || settledPeriods.some(p => date >= p.start && date <= p.end);
        if (!includeSettled && settled) continue;

        for (const fId in state.attendance[date]) {
            const val = state.attendance[date][fId][workerId];
            if (!hasAttendanceWork(val)) continue;
            if (isOvertimeValue(val)) {
                totalDays += 1;
                earnedAttendance += dailyWage + overtimeCharge;
            } else {
                // Keep slightly higher precision during accumulation so part-days stay accurate.
                const rawF = parseFloat(normalizeAttendanceValue(val));
                const f = Number.isFinite(rawF) ? Math.round(rawF * 10000) / 10000 : 0;
                totalDays = Math.round((totalDays + f) * 10000) / 10000;
                earnedAttendance += f * dailyWage;
            }
        }
    }

    let extraTotal = 0;
    (w.overtime || []).forEach(e => {
        const overtimeDate = cleanText(e?.date);
        const hasSafeOvertimeDate = isValidISODateKey(overtimeDate);
        let settled = !!(safeLastSettledDate && hasSafeOvertimeDate && overtimeDate <= safeLastSettledDate);
        if (settledPeriods.length && hasSafeOvertimeDate) settled = settled || settledPeriods.some(p => overtimeDate >= p.start && overtimeDate <= p.end);
        if (includeSettled || !settled) extraTotal += Number(e?.amount || 0) || 0;
    });

    return {
        totalDays: Number(Number(totalDays).toFixed(2)),
        earnedAmount: Number((earnedAttendance + extraTotal).toFixed(2)),
        extraAmount: Number(extraTotal.toFixed(2))
    };
}

function calculateWorkerStats(workerId) {
    const w = state.workers.find(x => x.id === workerId);
    if (!w) {
        return {
            totalDays: 0,
            totalEarned: 0,
            initialDebt: 0,
            pendingAmount: 0,
            paidAmount: 0,
            loanAmount: 0,
            currentCycleDays: 0,
            currentCycleEarned: 0,
            recordedTotalDays: 0,
            recordedTotalEarned: 0
        };
    }

    const currentTotals = calculateWorkerAttendanceTotals(workerId, { includeSettled: false });
    const recordedTotals = calculateWorkerAttendanceTotals(workerId, { includeSettled: true });
    const paid = w.paidAmount || 0;
    // Fix 2: Adjust loanResetBaseline if loan was SET to an amount lower than baseline.
    // Without this, activeLoan = max(0, newLoan - baseline) becomes 0, hiding real loans.
    const loan = w.loanAmount || 0;
    const activeLoan = Math.max(0, loan - Math.min(w.loanResetBaseline || 0, loan));
    const initialDebt = w.initialDebt || 0;
    const earned = currentTotals.earnedAmount;
    const totalDue = earned + initialDebt;

    return {
        totalDays: recordedTotals.totalDays,
        totalEarned: earned,
        currentCycleDays: currentTotals.totalDays,
        currentCycleEarned: currentTotals.earnedAmount,
        recordedTotalDays: recordedTotals.totalDays,
        recordedTotalEarned: recordedTotals.earnedAmount,
        initialDebt,
        paidAmount: paid,
        loanAmount: loan,
        pendingAmount: totalDue - paid - activeLoan
    };
}

function calculateWorkerOvertimeBreakdown(workerId) {
    const w = state.workers.find(x => x.id === workerId);
    if (!w) {
        return {
            overtimeDays: 0,
            attendanceOvertimeAmount: 0,
            extraWageEntries: 0,
            extraWageAmount: 0,
            totalOvertimeAmount: 0
        };
    }

    const settledPeriods = normalizeSettledPeriods(w.settledPeriods);
    const safeLastSettledDate = isValidISODateKey(w.lastSettledDate) ? cleanText(w.lastSettledDate) : '';
    let overtimeDays = 0;
    let attendanceOvertimeAmount = 0;

    for (const date in state.attendance) {
        let settled = !!(safeLastSettledDate && date <= safeLastSettledDate);
        if (settledPeriods.length) settled = settled || settledPeriods.some(p => date >= p.start && date <= p.end);
        if (settled) continue;

        for (const fId in state.attendance[date]) {
            const val = state.attendance[date][fId][workerId];
            if (!hasAttendanceWork(val) || !isOvertimeValue(val)) continue;
            overtimeDays += 1;
            attendanceOvertimeAmount += (w.overtimeCharge || 0);
        }
    }

    let extraWageEntries = 0;
    let extraWageAmount = 0;
    (w.overtime || []).forEach(e => {
        const overtimeDate = cleanText(e?.date);
        const hasSafeOvertimeDate = isValidISODateKey(overtimeDate);
        let settled = !!(safeLastSettledDate && hasSafeOvertimeDate && overtimeDate <= safeLastSettledDate);
        if (settledPeriods.length && hasSafeOvertimeDate) settled = settled || settledPeriods.some(p => overtimeDate >= p.start && overtimeDate <= p.end);
        if (settled) return;
        extraWageEntries += 1;
        extraWageAmount += Number(e?.amount || 0) || 0;
    });

    return {
        overtimeDays,
        attendanceOvertimeAmount,
        extraWageEntries,
        extraWageAmount,
        totalOvertimeAmount: attendanceOvertimeAmount + extraWageAmount
    };
}

window.deleteUser = async function (u) {
    // Fix 1: Removed duplicate simple deleteUser — this is the correct version (via undo toast)
    if (u === 'admin') return alert(t('admin.cannotDeleteAdmin'));
    try {
        await db.collection('users').doc(u).delete();
        window.refreshUserList();
        showToast(t('admin.deletedToast', { username: u }));
    } catch (e) { showToast(t('admin.deleteUserError'), true); }
};

window.recordLoginActivity = function (u) { logActivity(t('activity.userLoggedIn', { username: u })); };

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatCurrency(a) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(a); }
function formatDateToDDMMYYYY(d) { if (!d) return ''; const p = d.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d; }
window.formatDateToDDMMYYYY = formatDateToDDMMYYYY; // Exported for use in buildAttendanceSheetRows
function getTodayLocalISO() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0]; }
function normalizeDateRange(start, end) {
    if (!start && !end) return null;
    const safeStart = start || end;
    const safeEnd = end || start || safeStart;
    return safeStart <= safeEnd ? { start: safeStart, end: safeEnd } : { start: safeEnd, end: safeStart };
}
function isDateWithinRange(date, range) { return !range || (date >= range.start && date <= range.end); }
function attendanceValueToDays(value) {
    const normalized = normalizeAttendanceValue(value);
    if (normalized === 'ot') return 1;
    const num = parseFloat(normalized);
    return Number.isFinite(num) ? num : 0;
}

function getWorkerOtherFarmLoad(date, farmId, workerId) {
    if (!isValidISODateKey(date)) return 0;
    const farmsForDate = state.attendance?.[date] || {};
    let total = 0;
    Object.keys(farmsForDate).forEach(otherFarmId => {
        if (otherFarmId === farmId) return;
        total += attendanceValueToDays(farmsForDate[otherFarmId]?.[workerId]);
    });
    return Number(total.toFixed(2));
}

function isAttendanceSelectionAllowed(date, farmId, workerId, value) {
    const normalized = normalizeAttendanceValue(value);
    if (!isValidISODateKey(date) || !normalized) return false;
    if (normalized === '0') return true;
    const currentValue = normalizeAttendanceValue(state.attendance?.[date]?.[farmId]?.[workerId]) || '0';
    if (normalized === currentValue) return true;
    const otherFarmLoad = getWorkerOtherFarmLoad(date, farmId, workerId);
    const remainingCapacity = Math.max(0, MAX_DAILY_WORK_CAPACITY - otherFarmLoad);
    return attendanceValueToDays(normalized) <= (remainingCapacity + 0.0001);
}

function getOtherFarmAttendanceStatus(date, farmId, workerId) {
    const otherFarmLoad = getWorkerOtherFarmLoad(date, farmId, workerId);
    if (otherFarmLoad <= 0) return '';
    if (otherFarmLoad >= MAX_DAILY_WORK_CAPACITY - 0.0001) return t('attendance.maxCapacity');
    const days = window.formatCountValue ? window.formatCountValue(otherFarmLoad) : otherFarmLoad;
    return t('attendance.otherFarmStatus', { days });
}

function mergeDateRanges(periods = []) {
    const normalized = periods
        .map(p => normalizeDateRange(p?.start, p?.end))
        .filter(Boolean)
        .sort((a, b) => a.start.localeCompare(b.start));
    const merged = [];
    normalized.forEach(period => {
        const prev = merged[merged.length - 1];
        if (!prev || period.start > prev.end) merged.push({ ...period });
        else if (period.end > prev.end) prev.end = period.end;
    });
    return merged;
}
function getAttendanceRangeFromControls() {
    const start = document.getElementById('attendance-date')?.value || getTodayLocalISO();
    const endGroup = document.getElementById('end-date-group');
    const isSummaryViewActive = endGroup && endGroup.style.display !== 'none';
    const end = isSummaryViewActive ? (document.getElementById('attendance-date-end')?.value || start) : start;
    return normalizeDateRange(start, end);
}
function getAttendanceEntries(filters = {}) {
    const range = filters.range || null;
    const farmId = filters.farmId || '';
    const rows = [];
    for (const date of Object.keys(state.attendance || {}).sort()) {
        if (!isDateWithinRange(date, range)) continue;
        const farmsForDate = state.attendance[date] || {};
        for (const currentFarmId of Object.keys(farmsForDate)) {
            if (farmId && farmId !== 'all' && currentFarmId !== farmId) continue;
            const workersForFarm = farmsForDate[currentFarmId] || {};
            for (const workerId of Object.keys(workersForFarm)) {
                const value = workersForFarm[workerId];
                if (!hasAttendanceWork(value)) continue;
                const farm = state.farms.find(x => x.id === currentFarmId);
                const worker = state.workers.find(x => x.id === workerId);
                rows.push({
                    date,
                    farmId: currentFarmId,
                    farmName: farm?.name || t('common.deletedFarm', { id: currentFarmId }),
                    workerId,
                    workerName: worker?.name || t('common.deletedWorker', { id: workerId }),
                    value,
                    present: t('common.yes'),
                    workType: isOvertimeValue(value)
                        ? t('attendance.overtime')
                        : normalizeAttendanceValue(value) === '0.5'
                            ? t('attendance.halfDay')
                            : normalizeAttendanceValue(value) === '1'
                                ? t('attendance.fullDay')
                                : (window.formatLocalizedDayCount ? window.formatLocalizedDayCount(value) : String(value))
                });
            }
        }
    }
    return rows;
}

window.repairAttendanceData = function () {
    state = sanitizeStateForPersistence(state);
    saveState();
    renderAll();
    const summary = {
        workers: state.workers.length,
        farms: state.farms.length,
        attendanceDates: Object.keys(state.attendance || {}).length,
        attendanceRows: getAttendanceEntries().length
    };
    console.log('Attendance repair summary', summary);
    showToast(t('recovery.attendanceRepaired', { rows: summary.attendanceRows }));
    return summary;
};

window.checkCloudAttendance = async function () {
    try {
        const snap = await db.collection("appData").doc("masterState").get();
        const data = snap.data() || {};
        const attendance = data.attendance || {};
        let rows = 0;
        Object.keys(attendance).forEach(date => {
            const farms = attendance[date] || {};
            Object.keys(farms).forEach(farmId => {
                const workers = farms[farmId] || {};
                rows += Object.keys(workers).length;
            });
        });
        const summary = {
            appVersion: '5.6.0',
            workers: Array.isArray(data.workers) ? data.workers.length : 0,
            farms: Array.isArray(data.farms) ? data.farms.length : 0,
            attendanceDates: Object.keys(attendance).length,
            attendanceRows: rows
        };
        console.log('CLOUD_ATTENDANCE_CHECK', summary);
        return summary;
    } catch (error) {
        console.error(error);
        alert(t('recovery.cloudCheckFailed', { message: error?.message || error }));
        return null;
    }
};

window.forceRecoverAttendance = async function () {
    try {
        const ref = db.collection("appData").doc("masterState");
        const snap = await ref.get();
        const cloud = snap.data() || {};

        const cloudAttendance = (cloud.attendance && typeof cloud.attendance === 'object') ? cloud.attendance : {};
        const lsState = JSON.parse(localStorage.getItem('farmWorkerState') || '{}');
        const lsAttendance = (lsState.attendance && typeof lsState.attendance === 'object') ? lsState.attendance : {};
        let deletedSnapshot = null;
        try { deletedSnapshot = JSON.parse(localStorage.getItem('farmWorkerDeletedAttendanceSnapshot') || 'null'); } catch (_error) { }
        const deletedAttendance = (deletedSnapshot?.attendance && typeof deletedSnapshot.attendance === 'object')
            ? deletedSnapshot.attendance
            : {};

        const emergencyAttendance = {
            "2026-03-23": {
                "f1774209479114": { "w1774316896795": "1", "w1774316914056": "1" },
                "f2": {
                    "w1774316821151": "1",
                    "w1774316846973": "1",
                    "w1774316931461": "1",
                    "w1774327877957": "ot",
                    "w1774327895979": "1"
                }
            },
            "2026-03-24": {
                "f1774209479114": {
                    "w1774316821151": "1",
                    "w1774316846973": "1",
                    "w1774316914056": "1",
                    "w1774316931461": "0.5"
                },
                "f2": { "w1774327877957": "1", "w1774327895979": "1" }
            },
            "2026-03-25": {
                "f1774209479114": {
                    "w1774316821151": "1",
                    "w1774316846973": "1",
                    "w1774316896795": "1",
                    "w1774316914056": "1",
                    "w1774316931461": "1",
                    "w1774327877957": "1"
                },
                "f1774381366669": {
                    "w1774381386691": "1",
                    "w1774418224080": "1"
                }
            },
            "2026-03-26": {
                "f1": { "w1774316914056": "1", "w1774316931461": "1" },
                "f1774209479114": {
                    "w1774316821151": "1",
                    "w1774316846973": "1",
                    "w1774316896795": "1",
                    "w1774327877957": "1",
                    "w1774327895979": "1"
                }
            },
            "2026-03-27": {
                "f1": { "w1774327877957": "1", "w1774327895979": "1", "w1774615151534": "1" },
                "f1774209479114": {
                    "w1774316821151": "1",
                    "w1774316846973": "1",
                    "w1774316914056": "1",
                    "w1774316931461": "1"
                }
            }
        };

        const hasRows = src => {
            if (!src || typeof src !== 'object') return false;
            return Object.keys(src).some(date => {
                const farms = src[date] || {};
                return Object.keys(farms).some(farmId => Object.keys(farms[farmId] || {}).length > 0);
            });
        };

        let sourceName = 'cloud';
        let sourceAttendance = cloudAttendance;
        if (!hasRows(sourceAttendance)) {
            if (hasRows(lsAttendance)) {
                sourceAttendance = lsAttendance;
                sourceName = 'localStorage:farmWorkerState';
            } else if (hasRows(deletedAttendance)) {
                sourceAttendance = deletedAttendance;
                sourceName = 'localStorage:deletedSnapshot';
            } else {
                sourceAttendance = emergencyAttendance;
                sourceName = 'emergencySeed';
            }
        }

        const workers = Array.isArray(cloud.workers) ? cloud.workers : (Array.isArray(state.workers) ? state.workers : []);
        const farms = Array.isArray(cloud.farms) ? cloud.farms : (Array.isArray(state.farms) ? state.farms : []);

        const workerNameToId = new Map();
        const knownWorkerIds = new Set();
        workers.forEach(worker => {
            const safeId = cleanText(worker?.id);
            if (safeId) knownWorkerIds.add(safeId);
            const safeName = cleanText(worker?.name).toLowerCase();
            if (safeName && safeId && !workerNameToId.has(safeName)) workerNameToId.set(safeName, safeId);
        });

        const legacyIdToName = {
            "w1774327895979": "rohit",
            "w1774327877957": "manju",
            "w1774316914056": "asha",
            "w1774316821151": "antha",
            "w1774316931461": "sujata",
            "w1774316846973": "satish",
            "w1774316896795": "jebela"
        };

        const farmNameToId = new Map();
        const knownFarmIds = new Set();
        farms.forEach(farm => {
            const safeId = cleanText(farm?.id);
            if (safeId) knownFarmIds.add(safeId);
            const safeName = cleanText(farm?.name).toLowerCase();
            if (safeName && safeId && !farmNameToId.has(safeName)) farmNameToId.set(safeName, safeId);
        });

        const mapWorkerId = rawId => {
            const safeId = cleanText(rawId);
            if (!safeId) return '';
            if (knownWorkerIds.has(safeId)) return safeId;
            const mappedName = legacyIdToName[safeId];
            if (mappedName && workerNameToId.has(mappedName)) return workerNameToId.get(mappedName);
            const normalizedNameKey = safeId.toLowerCase();
            if (workerNameToId.has(normalizedNameKey)) return workerNameToId.get(normalizedNameKey);
            return safeId;
        };

        const mapFarmId = rawId => {
            const safeId = cleanText(rawId);
            if (!safeId) return '';
            if (knownFarmIds.has(safeId)) return safeId;
            const normalizedNameKey = safeId.toLowerCase();
            if (farmNameToId.has(normalizedNameKey)) return farmNameToId.get(normalizedNameKey);
            return safeId;
        };

        const repaired = JSON.parse(JSON.stringify(cloudAttendance || {}));
        Object.keys(sourceAttendance || {}).forEach(rawDate => {
            const safeDate = parseImportedDate(rawDate);
            if (!safeDate || !isValidISODateKey(safeDate)) return;
            if (!repaired[safeDate]) repaired[safeDate] = {};
            const farmsForDate = sourceAttendance[rawDate] || {};
            Object.keys(farmsForDate).forEach(rawFarmId => {
                const safeFarmId = mapFarmId(rawFarmId);
                if (!safeFarmId) return;
                if (!repaired[safeDate][safeFarmId]) repaired[safeDate][safeFarmId] = {};
                const workersForFarm = farmsForDate[rawFarmId] || {};
                Object.keys(workersForFarm).forEach(rawWorkerId => {
                    const safeWorkerId = mapWorkerId(rawWorkerId);
                    if (!safeWorkerId) return;
                    const safeValue = normalizeAttendanceValue(workersForFarm[rawWorkerId]);
                    if (safeValue === null) return;
                    repaired[safeDate][safeFarmId][safeWorkerId] = safeValue;
                });
            });
        });

        const resetWorkers = workers.map(worker => ({
            ...worker,
            lastSettledDate: '',
            settledPeriods: []
        }));

        await ref.set({ attendance: repaired, workers: resetWorkers }, { merge: true });

        state = sanitizeStateForPersistence({
            ...state,
            farms,
            workers: resetWorkers,
            attendance: repaired
        });
        saveState();
        renderAll();

        const summary = {
            source: sourceName,
            workers: state.workers.length,
            farms: state.farms.length,
            attendanceDates: Object.keys(state.attendance || {}).length,
            attendanceRows: getAttendanceEntries().length
        };
        console.log('FORCE_RECOVERY_DONE', summary);
        showToast(t('recovery.completeRows', { rows: summary.attendanceRows }));
        return summary;
    } catch (error) {
        console.error(error);
        alert(t('recovery.failed', { message: error?.message || error }));
        return null;
    }
};

// === ENHANCED EXPORT SYSTEM ===
function buildAttendanceSheetRows(entries) {
    if (!entries.length) return [{ Date: 'No Records', Farm: '', Worker: '', 'Work Type': '', Value: '' }];

    const groupedByDate = {};
    entries.forEach(entry => {
        if (!groupedByDate[entry.date]) {
            groupedByDate[entry.date] = [];
        }
        groupedByDate[entry.date].push(entry);
    });

    const rows = [];
    Object.keys(groupedByDate).sort().forEach(date => {
        // Add date header row
        rows.push({
            Date: window.formatDateToDDMMYYYY ? window.formatDateToDDMMYYYY(date) : date,
            Farm: '---',
            Worker: '---',
            'Work Type': '---',
            Value: '---'
        });

        // Add attendance rows for this date
        groupedByDate[date].forEach(entry => {
            rows.push({
                Date: '',
                Farm: entry.farmName,
                Worker: entry.workerName,
                'Work Type': entry.workType,
                Value: entry.value
            });
        });

        // Add empty row as separator
        rows.push({
            Date: '',
            Farm: '',
            Worker: '',
            'Work Type': '',
            Value: ''
        });
    });

    return rows;
}

function buildSheet(data) {
    return XLSX.utils.json_to_sheet(Array.isArray(data) ? data : []);
}

function exportWorkbook({ fileName, farmsData = state.farms, workersData = state.workers, attendanceEntries = [] }) {
    if (typeof XLSX === 'undefined') {
        alert(t('recovery.excelLibraryMissing'));
        return false;
    }
    const wb = XLSX.utils.book_new();

    const formattedFarms = farmsData.map(f => ({
        'Farm ID': f.id,
        'Farm Name': f.name,
        'Location': f.location || 'N/A',
        'Capacity': f.capacity || 'N/A'
    }));

    const formattedWorkers = workersData.map(w => {
        const stats = typeof calculateWorkerStats === 'function' ? calculateWorkerStats(w.id) : { totalEarned: 0, pendingAmount: 0 };
        return {
            'Worker ID': w.id,
            'Worker Name': w.name,
            'Role': w.role || '',
            'Daily Wage': w.dailyWage || 0,
            'Overtime Charge': w.overtimeCharge || 0,
            'Initial Debt': w.initialDebt || 0,
            'Total Earned': stats.totalEarned || 0,
            'Paid Amount': w.paidAmount || 0,
            'Loan Balance': w.loanAmount || 0,
            'Loan Reset Baseline': w.loanResetBaseline || 0,
            'Last Settled Date': w.lastSettledDate || '',
            'Settled Periods': JSON.stringify(normalizeSettledPeriods(w.settledPeriods)),
            'Extra Wage Entries': JSON.stringify(Array.isArray(w.overtime) ? w.overtime : []),
            'Pending Payout': stats.pendingAmount || 0,
            'Phone': w.phone || 'N/A',
            'Bank Name': w.bankName || 'N/A',
            'Account No': w.accountNum || 'N/A',
            'IFSC': w.ifsc || 'N/A'
        };
    });

    XLSX.utils.book_append_sheet(wb, buildSheet(formattedFarms), "Farms");
    XLSX.utils.book_append_sheet(wb, buildSheet(formattedWorkers), "Workers");
    XLSX.utils.book_append_sheet(wb, buildSheet(buildAttendanceSheetRows(attendanceEntries)), "Attendance");
    XLSX.writeFile(wb, fileName);
    return true;
}

function getCurrentMonthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthLabel(monthKey) {
    if (!monthKey) return '';
    const [year, month] = String(monthKey).split('-').map(Number);
    if (!year || !month) return monthKey;
    return new Date(year, month - 1, 1).toLocaleString(window.getCurrentLocale?.() || undefined, { month: 'long', year: 'numeric' });
}

function getFormattedBackupName() {
    const now = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long' });
    const year = now.getFullYear();
    return `Chandragiri_Backup_${monthName}_${year}`;
}

function getLatestRecordedDateForWorker(workerId) {
    let latest = '';
    for (const date of Object.keys(state.attendance || {})) {
        const farmsForDate = state.attendance[date] || {};
        for (const farmId of Object.keys(farmsForDate)) {
            const value = farmsForDate[farmId]?.[workerId];
            if (hasAttendanceWork(value) && (!latest || date > latest)) latest = date;
        }
    }
    const worker = state.workers.find(x => x.id === workerId);
    (worker?.overtime || []).forEach(entry => {
        const overtimeDate = parseImportedDate(entry?.date);
        if (overtimeDate && (!latest || overtimeDate > latest)) latest = overtimeDate;
    });
    return latest || getTodayLocalISO();
}

function populateProfileForm() {
    if (!currentUser) return;
    const fields = {
        'profile-name': currentUser.fullName || '',
        'profile-phone': currentUser.phone || '',
        'profile-bank-name': currentUser.bankName || '',
        'profile-acc-no': currentUser.accountNum || '',
        'profile-ifsc': currentUser.ifsc || ''
    };
    Object.keys(fields).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = fields[id];
    });
    const language = document.getElementById('profile-language');
    if (language) language.value = currentUser.language || window.getCurrentLanguage?.() || 'en';
}

// === BACKUP REMINDER SYSTEM ===
function updateBackupReminderStatus() {
    const status = document.getElementById('admin-backup-status');
    const backupBtn = document.querySelector('#admin-backup-panel .btn-primary');
    if (!status || !currentUser?.isAdmin) return;

    const currentMonthKey = getCurrentMonthKey();
    const backupMeta = state.backupMeta || {};
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();

    // Calculate how urgent the reminder should be
    const urgencyLevel = Math.min(100, Math.round((currentDay / daysInMonth) * 100));

    if (backupMeta.monthKey === currentMonthKey && backupMeta.lastBackupAt) {
        // Current month is backed up
        const savedAt = new Date(backupMeta.lastBackupAt).toLocaleString(window.getCurrentLocale?.() || undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        });
        status.innerHTML = '<strong>' + t('backup.completeTitle') + '</strong><br>' + t('dashboard.lastBackup') + ' ' + savedAt;
        status.style.color = '#059669';
        if (backupBtn) {
            backupBtn.innerHTML = t('backup.doneButton');
            backupBtn.style.background = '#6B7280';
            backupBtn.style.cursor = 'not-allowed';
            backupBtn.onclick = null;
        }
    } else if (backupMeta.lastBackupAt) {
        // Has previous backups but not current month
        const savedAt = new Date(backupMeta.lastBackupAt).toLocaleString(window.getCurrentLocale?.() || undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        });
        const monthName = getMonthLabel(currentMonthKey);

        let urgencyMessage = '';
        if (urgencyLevel > 80) {
            urgencyMessage = '<strong>' + t('backup.urgentTitle') + '</strong>';
            status.style.color = '#DC2626';
        } else if (urgencyLevel > 50) {
            urgencyMessage = '<strong>' + t('backup.reminderTitle') + '</strong>';
            status.style.color = '#D97706';
        } else {
            urgencyMessage = '<strong>' + t('backup.friendlyTitle') + '</strong>';
            status.style.color = '#8B5CF6';
        }

        status.innerHTML = urgencyMessage + '<br>' + t('backup.pendingStatus', { month: monthName, percent: urgencyLevel }) + '<br>' + t('backup.lastBackupAt', { savedAt });

        if (backupBtn) {
            backupBtn.innerHTML = urgencyLevel > 80 ? t('backup.buttonNow') : t('backup.buttonMonth', { month: monthName });
            backupBtn.style.background = urgencyLevel > 80 ?
                'linear-gradient(135deg, #DC2626, #B91C1C)' :
                'linear-gradient(135deg, #059669, #047857)';
        }
    } else {
        // No backups at all
        status.innerHTML = '<strong>' + t('backup.firstNeededTitle') + '</strong><br>' + t('backup.firstNeededBody');
        status.style.color = '#DC2626';

        if (backupBtn) {
            backupBtn.innerHTML = t('backup.createFirstButton');
            backupBtn.style.background = 'linear-gradient(135deg, #DC2626, #B91C1C)';
        }
    }

    // Add auto-reminder for late month
    if (urgencyLevel > 85 && backupMeta.monthKey !== currentMonthKey) {
        showAutoBackupReminder(urgencyLevel);
    }
}

function showAutoBackupReminder(urgencyLevel) {
    // Don't spam reminders - show only once per day
    const lastReminder = localStorage.getItem('lastBackupReminder');
    const today = new Date().toDateString();

    if (lastReminder !== today) {
        const messages = {
            95: t('backup.auto95'),
            90: t('backup.auto90'),
            85: t('backup.auto85')
        };

        const message = messages[Math.floor(urgencyLevel / 5) * 5] || t('backup.autoDefault');
        showToast(message, urgencyLevel > 85);

        localStorage.setItem('lastBackupReminder', today);
    }
}

function refreshAdminPanels() {
    const isAdmin = !!currentUser?.isAdmin;
    const backupPanel = document.getElementById('admin-backup-panel');
    if (backupPanel) backupPanel.style.display = isAdmin ? 'flex' : 'none';
    const clearPaymentsPanel = document.getElementById('admin-clear-payments');
    if (clearPaymentsPanel) clearPaymentsPanel.style.display = isAdmin ? 'block' : 'none';
    const clearAttendanceButton = document.getElementById('admin-clear-attendance-btn');
    if (clearAttendanceButton) clearAttendanceButton.style.display = isAdmin ? '' : 'none';
    const restoreAttendanceButton = document.getElementById('admin-restore-attendance-btn');
    if (restoreAttendanceButton) restoreAttendanceButton.style.display = isAdmin ? '' : 'none';
    const sheetsUrlInput = document.getElementById('google-sheets-webhook-url');
    if (sheetsUrlInput) {
        if (!isAdmin) sheetsUrlInput.value = '';
        else {
            const savedWebhook = getStoredGoogleSheetsWebhookUrl();
            if (!sheetsUrlInput.matches(':focus') && sheetsUrlInput.value !== savedWebhook) {
                sheetsUrlInput.value = savedWebhook;
            }
        }
    }
    updateGoogleSheetsSyncStatus();
    updateBackupReminderStatus();
}
// === END BACKUP REMINDER SYSTEM ===

function logActivity(m) {
    if (!currentUser) return;
    const entry = { time: Date.now(), user: currentUser.username, action: m };
    if (!state.auditLogs) state.auditLogs = [];
    state.auditLogs.unshift(entry);
    state.auditLogs = state.auditLogs.slice(0, 50);
    saveState();
}

// --- UI Rendering ---
function renderDashboard() {
    setText('dashboard-farms-count', state.farms.length);
    setText('dashboard-workers-count', state.workers.length);
    let total = state.workers.reduce((s, w) => s + Math.max(0, calculateWorkerStats(w.id).pendingAmount), 0);
    setText('dashboard-pending-payouts', formatCurrency(total));
    refreshAdminPanels();
    fetchWeather();
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.innerText = txt; }

function getAttendanceStatusLabel(value) {
    const normalized = normalizeAttendanceValue(value);
    if (normalized === '1') return t('attendance.fullDay');
    if (normalized === '0.5') return t('attendance.halfDay');
    if (normalized === 'ot') return t('attendance.overtime');
    return t('attendance.absent');
}

function renderFarmsList() {
    const list = document.getElementById('farms-list'); if (!list) return;
    list.innerHTML = state.farms.map((f, i) => `
        <div class="card stagger-anim" style="animation-delay: ${i * 0.05}s">
            <div class="flex-between">
                <div>
                    <h3>${escapeHtml(f.name)}</h3>
                    <p class="card-subtitle">${escapeHtml(f.location || t('common.noLocation'))}</p>
                </div>
                <button class="btn btn-secondary edit-gate" onclick="window.openFarmModal('${f.id}')">${t('common.edit')}</button>
            </div>
            <div style="margin-top: 12px;">
                <span class="status-badge status-active">${t('common.active')}</span>
            </div>
        </div>
    `).join('');
}

function renderWorkersList() {
    const list = document.getElementById('workers-list'); if (!list) return;
    list.innerHTML = state.workers.map((w, i) => `
        <div class="card worker-card stagger-anim" style="animation-delay: ${i * 0.05}s">
            <div class="worker-avatar">${escapeHtml((w.name || '?').charAt(0).toUpperCase())}</div>
            <div class="worker-info">
                <h3>${escapeHtml(w.name)}</h3>
                <p class="card-subtitle">${escapeHtml(w.role || t('workers.noRole'))} • ${formatCurrency(w.dailyWage)}${t('common.perDay')}</p>
            </div>
            <button class="btn btn-secondary edit-gate" onclick="window.openWorkerModal('${w.id}')">${t('common.edit')}</button>
        </div>
    `).join('');
    // Re-apply active search filter after re-render
    const searchInput = document.getElementById('workers-search-input');
    if (searchInput && searchInput.value.trim()) {
        window.filterWorkersList(searchInput.value);
    }
}

// Filter worker cards by name or role (non-destructive — hides cards only)
window.filterWorkersList = function (query) {
    const term = (query || '').trim().toLowerCase();
    const cards = document.querySelectorAll('#workers-list .worker-card');
    cards.forEach(card => {
        const name = (card.querySelector('h3')?.textContent || '').toLowerCase();
        const role = (card.querySelector('.card-subtitle')?.textContent || '').toLowerCase();
        const show = !term || name.includes(term) || role.includes(term);
        card.style.display = show ? '' : 'none';
    });
};

function renderPaymentsTable() {
    const tbody = document.querySelector('#payments tbody'); if (!tbody) return;
    tbody.innerHTML = state.workers.map(w => {
        const s = calculateWorkerStats(w.id);
        return `
            <tr>
                <td data-label="${t('payments.workerName')}" class="payment-name-cell"><strong>${escapeHtml(w.name)}</strong></td>
                <td data-label="${t('payments.dailyWage')}">${formatCurrency(w.dailyWage)}</td>
                <td data-label="${t('payments.totalDays')}">${window.formatCountValue ? window.formatCountValue(s.totalDays) : s.totalDays}</td>
                <td data-label="${t('payments.earned')}">${formatCurrency(s.totalEarned)}</td>
                <td data-label="${t('payments.paid')}">${formatCurrency(s.paidAmount)}</td>
                <td data-label="${t('payments.loans')}">${formatCurrency(s.loanAmount)}</td>
                <td data-label="${t('payments.pending')}" class="${s.pendingAmount > 0 ? 'text-warning' : 'text-success'}"><strong>${formatCurrency(s.pendingAmount)}</strong></td>
                <td data-label="${t('payments.actions')}" class="payment-actions-cell">
                    <button class="btn btn-secondary" onclick="window.openBreakdownModal('${w.id}')">${t('common.details')}</button>
                    <button class="btn btn-primary edit-gate" onclick="window.openPaymentModal('${w.id}')">${t('common.pay')}</button>
                </td>
            </tr>
        `;
    }).join('');
    // Re-apply active search filter after re-render
    const searchInput = document.getElementById('payments-search-input');
    if (searchInput && searchInput.value.trim()) {
        window.filterPaymentsTable(searchInput.value);
    }
}

// Filter payments table rows by worker name (non-destructive — hides rows only)
window.filterPaymentsTable = function (query) {
    const term = (query || '').trim().toLowerCase();
    const rows = document.querySelectorAll('#payments-table-body tr');
    let visibleCount = 0;
    rows.forEach(row => {
        const nameCell = row.querySelector('td');
        const name = nameCell ? nameCell.textContent.toLowerCase() : '';
        const show = !term || name.includes(term);
        row.style.display = show ? '' : 'none';
        if (show) visibleCount++;
    });
    const noResults = document.getElementById('payments-no-results');
    if (noResults) noResults.style.display = (term && visibleCount === 0) ? 'block' : 'none';
};

// --- Farm Management ---
window.openFarmModal = function (id) {
    const f = state.farms.find(x => x.id === id) || { id: '', name: '', location: '' };
    document.getElementById('farm-id').value = f.id;
    document.getElementById('farm-name').value = f.name;
    document.getElementById('farm-location').value = f.location || '';
    const title = document.getElementById('farm-modal-title');
    if (title) title.innerText = f.id ? t('farmModal.editTitle') : t('farmModal.addTitle');
    const deleteBtn = document.getElementById('delete-farm-btn');
    if (deleteBtn) deleteBtn.style.display = f.id ? '' : 'none';
    window.toggleModal('farm-modal');
};

window.saveFarm = function () {
    const id = document.getElementById('farm-id').value;
    const name = document.getElementById('farm-name').value.trim();
    if (!name) return;
    const data = { name, location: document.getElementById('farm-location').value.trim() };
    if (id) {
        const idx = state.farms.findIndex(x => x.id === id);
        if (idx >= 0) state.farms[idx] = { ...state.farms[idx], ...data };
        else state.farms.push({ id, ...data });
    } else {
        state.farms.push({ id: 'f' + Date.now(), ...data });
    }
    saveState();
    window.toggleModal('farm-modal');
    renderFarmsList();
    updateFarmDropdown();
    renderDashboard();
    showToast(t(id ? 'farmModal.updateSuccess' : 'farmModal.addSuccess'));
};

// --- Modals & Actions ---
window.toggleModal = function (id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.toggle('active');
    modal.setAttribute('aria-hidden', modal.classList.contains('active') ? 'false' : 'true');
};

window.openWorkerModal = function (id) {
    const w = state.workers.find(x => x.id === id) || { id: '', name: '', role: '', dailyWage: 0, overtimeCharge: 0, initialDebt: 0, phone: '', bankName: '', accountNum: '', ifsc: '' };
    document.getElementById('worker-id').value = w.id;
    document.getElementById('worker-name').value = w.name;
    document.getElementById('worker-role').value = w.role || '';
    document.getElementById('worker-wage').value = w.dailyWage || 0;
    const overtimeCharge = document.getElementById('worker-overtime-charge');
    if (overtimeCharge) overtimeCharge.value = w.overtimeCharge || 0;
    const initialDebt = document.getElementById('worker-initial-debt');
    if (initialDebt) initialDebt.value = w.initialDebt || 0;
    // ✅ FIX 3: Populate the phone field when opening the worker modal.
    // Previously this was missing, so the phone input always showed blank when editing a worker.
    const phone = document.getElementById('worker-phone');
    if (phone) phone.value = w.phone || '';
    const bankName = document.getElementById('worker-bank-name');
    if (bankName) bankName.value = w.bankName || '';
    const accountNum = document.getElementById('worker-account-num');
    if (accountNum) accountNum.value = w.accountNum || '';
    const ifsc = document.getElementById('worker-ifsc');
    if (ifsc) ifsc.value = w.ifsc || '';
    const title = document.getElementById('worker-modal-title');
    if (title) title.innerText = w.id ? t('workerModal.editTitle') : t('workerModal.addTitle');
    const deleteBtn = document.getElementById('delete-worker-btn');
    if (deleteBtn) deleteBtn.style.display = w.id ? '' : 'none';
    window.toggleModal('worker-modal');
};

window.saveWorker = function () {
    const id = document.getElementById('worker-id').value;
    const name = document.getElementById('worker-name').value.trim();
    if (!name) return;
    const data = {
        name,
        role: document.getElementById('worker-role').value.trim(),
        dailyWage: parseFloat(document.getElementById('worker-wage').value) || 0,
        overtimeCharge: parseFloat(document.getElementById('worker-overtime-charge')?.value) || 0,
        initialDebt: parseFloat(document.getElementById('worker-initial-debt')?.value) || 0,
        // ✅ FIX 4: Include phone field in saved worker data.
        // Previously saveWorker never read the phone input, so typing a phone number had no effect.
        phone: document.getElementById('worker-phone')?.value?.trim() || '',
        bankName: document.getElementById('worker-bank-name')?.value || '',
        accountNum: document.getElementById('worker-account-num')?.value || '',
        ifsc: document.getElementById('worker-ifsc')?.value || ''
    };
    if (id) {
        const idx = state.workers.findIndex(x => x.id === id);
        if (idx >= 0) state.workers[idx] = { ...state.workers[idx], ...data };
        else state.workers.push({ id, ...data, paidAmount: 0, loanAmount: 0, settledPeriods: [], overtime: [] });
        logActivity(t('activity.updatedWorker', { name }));
    } else {
        const newW = { id: 'w' + Date.now(), ...data, paidAmount: 0, loanAmount: 0, settledPeriods: [], overtime: [] };
        state.workers.push(newW);
        logActivity(t('activity.addedWorker', { name }));
    }
    saveState();
    window.toggleModal('worker-modal');
    renderWorkersList();
    renderPaymentsTable();
    renderDashboard();
    showToast(t(id ? 'workerModal.updateSuccess' : 'workerModal.addSuccess'));
};

window.deleteWorker = function () {
    const id = document.getElementById('worker-id').value;
    if (!id || !confirm(t('workerModal.deleteFinal'))) return;
    state.workers = state.workers.filter(x => x.id !== id);
    logActivity(t('activity.deletedWorker'));
    saveState(); window.toggleModal('worker-modal'); renderWorkersList(); renderPaymentsTable(); renderDashboard();
};

window.renderAttendanceSummary = function () {
    if (currentUser?.permissions?.canEdit) return window.renderAttendanceView();
    const endGroup = document.getElementById('end-date-group');
    if (endGroup) endGroup.style.display = 'block';
    const dateLabel = document.getElementById('date-label');
    if (dateLabel) dateLabel.innerText = t('attendance.startDate');

    const range = getAttendanceRangeFromControls();
    const fId = document.getElementById('attendance-farm-select').value;
    const stateMsg = document.getElementById('attendance-state-msg');
    const summaryContainer = document.getElementById('attendance-summary-container');
    const listContainer = document.getElementById('attendance-list-container');
    const summaryList = document.getElementById('attendance-summary-list');
    const summaryTitle = document.getElementById('summary-title');
    if (!summaryList || !summaryTitle || !fId || !range) {
        if (stateMsg) stateMsg.style.display = 'block';
        if (summaryContainer) summaryContainer.style.display = 'none';
        if (listContainer) listContainer.style.display = 'none';
        return;
    }

    const isSingleDay = range.start === range.end;
    const farmName = fId === 'all'
        ? t('common.allFarms')
        : (state.farms.find(x => x.id === fId)?.name || t('common.deletedFarm', { id: fId }));
    const byWorker = {};
    getAttendanceEntries({ range, farmId: fId }).forEach(entry => {
        if (!byWorker[entry.workerId]) byWorker[entry.workerId] = { days: 0, lastValue: '0' };
        byWorker[entry.workerId].days = Math.round((byWorker[entry.workerId].days + attendanceValueToDays(entry.value)) * 100) / 100;
        byWorker[entry.workerId].lastValue = entry.value;
    });

    const dateLabelText = isSingleDay
        ? formatDateToDDMMYYYY(range.start)
        : `${formatDateToDDMMYYYY(range.start)} - ${formatDateToDDMMYYYY(range.end)}`;
    summaryTitle.innerText = t('attendance.summaryTitle', { date: dateLabelText, farm: farmName });
    summaryList.innerHTML = state.workers.map(w => {
        const data = byWorker[w.id] || { days: 0, lastValue: '0' };
        let label = t('attendance.absent');
        if (isSingleDay) {
            const normalizedLastValue = normalizeAttendanceValue(data.lastValue);
            if (normalizedLastValue === '1') label = t('attendance.fullDay');
            else if (normalizedLastValue === '0.5') label = t('attendance.halfDay');
            else if (normalizedLastValue === 'ot') label = t('attendance.overtime');
        } else if (data.days > 0) {
            label = window.formatLocalizedDayCount ? window.formatLocalizedDayCount(data.days) : String(data.days);
        }
        return `
            <div class="attendance-item" style="border-bottom:1px solid var(--border); padding:12px 0; display:flex; justify-content:space-between;">
                <span>${escapeHtml(w.name)}</span>
                <span style="font-weight:700; color:${data.days <= 0 ? 'var(--text-muted)' : 'var(--primary)'}">${escapeHtml(label)}</span>
            </div>
        `;
    }).join('');
    if (stateMsg) stateMsg.style.display = 'none';
    if (summaryContainer) summaryContainer.style.display = 'block';
    if (listContainer) listContainer.style.display = 'none';
};

function updateFarmDropdown() {
    const s = document.getElementById('attendance-farm-select'); if (!s) return;
    const currentValue = s.value;
    s.innerHTML = `<option value="" disabled>${t('common.selectFarm')}</option>` +
        `<option value="all">${t('common.allFarms')}</option>` +
        state.farms.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    if (state.farms.some(f => f.id === currentValue) || currentValue === 'all') s.value = currentValue;
    else if (state.farms.length > 0) s.value = state.farms[0].id;
    else s.value = '';
}

window.renderAttendanceView = function () {
    if (!currentUser?.permissions?.canEdit) return window.renderAttendanceSummary();
    const endGroup = document.getElementById('end-date-group');
    if (endGroup) endGroup.style.display = 'none';
    const dateLabel = document.getElementById('date-label');
    if (dateLabel) dateLabel.innerText = t('breakdown.date');

    const date = document.getElementById('attendance-date').value;
    const fId = document.getElementById('attendance-farm-select').value;
    const list = document.getElementById('attendance-list');
    if (fId === 'all') return window.renderAttendanceSummary();

    const stateMsg = document.getElementById('attendance-state-msg');
    const summaryContainer = document.getElementById('attendance-summary-container');
    const listContainer = document.getElementById('attendance-list-container');
    if (!list || !date || !fId) {
        if (stateMsg) stateMsg.style.display = 'block';
        if (summaryContainer) summaryContainer.style.display = 'none';
        if (listContainer) listContainer.style.display = 'none';
        if (list) list.innerHTML = `<div class="empty-state">${t('attendance.selectSpecificFarm')}</div>`;
        return;
    }

    list.innerHTML = state.workers.map((w, i) => {
        const cur = (state.attendance[date] && state.attendance[date][fId]) ? state.attendance[date][fId][w.id] : '0';
        const isPresent = hasAttendanceWork(cur);
        const otherFarmStatus = getOtherFarmAttendanceStatus(date, fId, w.id);
        const atMaxCapacityElsewhere = otherFarmStatus === t('attendance.maxCapacity');
        return `
            <div class="card attendance-card stagger-anim" style="animation-delay: ${i * 0.03}s; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; border-left: 4px solid ${isPresent ? 'var(--primary)' : 'var(--border)'};">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div class="worker-avatar" style="width: 36px; height: 36px; font-size: 0.9rem; ${!isPresent ? 'background: var(--surface-hover); color: var(--text-muted); box-shadow: none;' : ''}">${escapeHtml((w.name || '?').charAt(0).toUpperCase())}</div>
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                        <span style="font-weight: 600; font-size: 1.05rem; color: ${isPresent ? 'var(--text-strong)' : 'var(--text-muted)'}; transition: color 0.3s;">${escapeHtml(w.name)}</span>
                        ${otherFarmStatus ? `<small style="font-size: 0.76rem; color: ${atMaxCapacityElsewhere ? 'var(--text-warning)' : 'var(--text-muted)'};">${escapeHtml(otherFarmStatus)}</small>` : ''}
                    </div>
                </div>
                <div class="custom-select-wrapper" style="width: 140px;">
                    <select class="premium-select ${!isPresent ? 'select-absent' : 'select-present'}" onchange="window.handleAttChange('${date}','${fId}','${w.id}',this.value)">
                        <option value="0" ${cur === '0' || !cur ? 'selected' : ''}>${t('attendance.absent')}</option>
                        <option value="1" ${cur === '1' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, '1') && cur !== '1' ? 'disabled' : ''}>${t('attendance.fullDay')}</option>
                        <option value="0.5" ${cur === '0.5' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, '0.5') && cur !== '0.5' ? 'disabled' : ''}>${t('attendance.halfDay')}</option>
                        <option value="ot" ${cur === 'ot' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, 'ot') && cur !== 'ot' ? 'disabled' : ''}>${t('attendance.overtime')}</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');
    if (stateMsg) stateMsg.style.display = 'none';
    if (summaryContainer) summaryContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'block';
};

window.handleAttChange = function (d, f, w, v) {
    const safeDate = isValidISODateKey(d) ? d : '';
    const safeValue = normalizeAttendanceValue(v);
    if (!safeDate || safeValue === null) return;
    if (!isAttendanceSelectionAllowed(safeDate, f, w, safeValue)) {
        showToast(t('attendance.maxCapacity'), true);
        window.renderAttendanceView();
        return;
    }

    // ✅ FIX 2: When a worker is marked absent ('0'), delete their attendance entry
    // instead of storing '0'. This prevents data bloat and keeps the attendance
    // object clean. Also clean up empty farm/date objects after deletion.
    if (safeValue === '0') {
        if (state.attendance[safeDate]?.[f]?.[w]) {
            delete state.attendance[safeDate][f][w];
            // Clean up empty farm object
            if (Object.keys(state.attendance[safeDate][f]).length === 0) {
                delete state.attendance[safeDate][f];
            }
            // Clean up empty date object
            if (Object.keys(state.attendance[safeDate]).length === 0) {
                delete state.attendance[safeDate];
            }
        }
    } else {
        if (!state.attendance[safeDate]) state.attendance[safeDate] = {};
        if (!state.attendance[safeDate][f]) state.attendance[safeDate][f] = {};
        state.attendance[safeDate][f][w] = safeValue;
    }

    saveState();
    window.renderAttendanceView();
};

// --- Splash Screen ---
window.hideSplashScreen = function () {
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => splash.style.display = 'none', 600);
    }
};

// --- Export Logic ---
window.handleExportScopeChange = function () {
    const s = document.getElementById('export-scope').value;
    document.getElementById('export-date-group').style.display = s === 'date' ? 'block' : 'none';
    document.getElementById('export-daterange-group').style.display = s === 'daterange' ? 'block' : 'none';
    document.getElementById('export-farm-group').style.display = s === 'farm' ? 'block' : 'none';
    if (s === 'farm') document.getElementById('export-farm-select').innerHTML = document.getElementById('attendance-farm-select').innerHTML;
};

window.downloadExcelReport = function (opts = {}) {
    const scope = opts.scope || document.getElementById('export-scope').value;
    let range = null;
    let farmId = '';
    if (scope === 'date') {
        const date = document.getElementById('export-date').value;
        if (!date) return alert(t('common.selectDateFirst'));
        range = normalizeDateRange(date, date);
    } else if (scope === 'daterange') {
        const start = document.getElementById('export-date-start').value;
        const end = document.getElementById('export-date-end').value;
        range = normalizeDateRange(start, end);
        if (!range) return alert(t('common.selectBothDatesFirst'));
    } else if (scope === 'farm') {
        farmId = document.getElementById('export-farm-select').value;
        if (!farmId) return alert(t('common.selectFarmFirst'));
    }
    const attendanceEntries = getAttendanceEntries({ range, farmId });
    const farmRows = (farmId && farmId !== 'all') ? state.farms.filter(f => f.id === farmId) : state.farms;
    const workerIds = new Set(attendanceEntries.map(entry => entry.workerId));
    const workerRows = scope === 'all' || workerIds.size === 0 ? state.workers : state.workers.filter(w => workerIds.has(w.id));
    exportWorkbook({
        fileName: opts.fileName || `FarmReport_${Date.now()}.xlsx`,
        farmsData: farmRows,
        workersData: workerRows,
        attendanceEntries
    });
};

window.exportAttendanceExcel = function () {
    const range = getAttendanceRangeFromControls();
    const farmId = document.getElementById('attendance-farm-select')?.value || '';
    const attendanceEntries = getAttendanceEntries({ range, farmId });
    if (!attendanceEntries.length) return alert(t('attendance.noRecordsForFilters'));
    exportWorkbook({
        fileName: `Attendance_${Date.now()}.xlsx`,
        farmsData: (farmId && farmId !== 'all') ? state.farms.filter(f => f.id === farmId) : state.farms,
        workersData: state.workers.filter(w => attendanceEntries.some(entry => entry.workerId === w.id)),
        attendanceEntries
    });
};

window.backupNow = function () {
    if (!currentUser?.isAdmin) return;
    const monthKey = getCurrentMonthKey();
    const fileName = `${getFormattedBackupName()}.xlsx`;
    const success = exportWorkbook({
        fileName: fileName,
        farmsData: state.farms,
        workersData: state.workers,
        attendanceEntries: getAttendanceEntries()
    });
    if (!success) return;

    // CRITICAL: Update backup metadata
    state.backupMeta = {
        lastBackupAt: Date.now(),
        type: 'monthly-backup',
        monthKey: monthKey
    };
    saveState();

    // Update the UI immediately
    updateBackupReminderStatus();
    showToast(t('backup.savedSuccess', { month: getMonthLabel(monthKey) }));

    // Log the activity
    logActivity(t('activity.createdBackup', { month: monthKey }));
};

function buildGoogleSheetsPayload() {
    state = sanitizeStateForPersistence(state);
    const attendanceEntries = getAttendanceEntries();
    const selectedAttendanceRange = getAttendanceRangeFromControls();
    const selectedFarmId = document.getElementById('attendance-farm-select')?.value || '';
    const selectedFarmName = !selectedFarmId || selectedFarmId === 'all'
        ? t('common.allFarms')
        : (state.farms.find(f => f.id === selectedFarmId)?.name || selectedFarmId);
    const selectedAttendanceEntries = getAttendanceEntries({
        range: selectedAttendanceRange,
        farmId: selectedFarmId
    });
    const payments = state.workers.map(w => {
        const stats = calculateWorkerStats(w.id);
        const overtime = calculateWorkerOvertimeBreakdown(w.id);
        return {
            workerId: w.id,
            workerName: w.name,
            role: w.role || '',
            dailyWage: Number(w.dailyWage || 0),
            overtimeCharge: Number(w.overtimeCharge || 0),
            overtimeDays: Number(overtime.overtimeDays || 0),
            attendanceOvertimeAmount: Number(overtime.attendanceOvertimeAmount || 0),
            extraWageEntries: Number(overtime.extraWageEntries || 0),
            extraWageAmount: Number(overtime.extraWageAmount || 0),
            totalOvertimeAmount: Number(overtime.totalOvertimeAmount || 0),
            totalDays: Number(stats.totalDays || 0),
            earnedAmount: Number(stats.totalEarned || 0),
            previousWages: Number(stats.initialDebt || 0),
            paidAmount: Number(stats.paidAmount || 0),
            loanAmount: Number(stats.loanAmount || 0),
            pendingAmount: Number(stats.pendingAmount || 0)
        };
    });
    const paymentTransactions = (state.paymentHistory || []).map(entry => ({
        id: entry.id,
        loggedAt: entry.loggedAt || '',
        entryDate: entry.entryDate || '',
        workerId: entry.workerId || '',
        workerName: entry.workerName || '',
        type: entry.type || '',
        paidAmount: Number(entry.paidAmount || 0),
        addedLoanAmount: Number(entry.addedLoanAmount || 0),
        setLoanAmount: Number(entry.setLoanAmount || 0),
        previousPaidAmount: Number(entry.previousPaidAmount || 0),
        newPaidAmount: Number(entry.newPaidAmount || 0),
        previousLoanAmount: Number(entry.previousLoanAmount || 0),
        newLoanAmount: Number(entry.newLoanAmount || 0),
        settledRangeStart: entry.settledRangeStart || '',
        settledRangeEnd: entry.settledRangeEnd || '',
        note: entry.note || ''
    }));
    const exportedAt = new Date().toISOString();
    const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
        source: 'chandragiri-web-app',
        uploadId,
        exportedAt,
        triggeredBy: currentUser?.username || 'unknown',
        summary: {
            farms: state.farms.length,
            workers: state.workers.length,
            paymentsRows: payments.length,
            paymentTransactionRows: paymentTransactions.length,
            attendanceRows: attendanceEntries.length,
            selectedAttendanceRows: selectedAttendanceEntries.length,
            attendanceDates: Object.keys(state.attendance || {}).sort()
        },
        attendanceFilters: {
            selectedRangeStart: selectedAttendanceRange?.start || '',
            selectedRangeEnd: selectedAttendanceRange?.end || '',
            selectedFarmId: selectedFarmId || 'all',
            selectedFarmName
        },
        farms: state.farms.map(f => ({
            id: f.id,
            name: f.name,
            location: f.location || '',
            capacity: f.capacity || ''
        })),
        workers: state.workers.map(w => ({
            id: w.id,
            name: w.name,
            role: w.role || '',
            dailyWage: Number(w.dailyWage || 0),
            overtimeCharge: Number(w.overtimeCharge || 0),
            initialDebt: Number(w.initialDebt || 0),
            paidAmount: Number(w.paidAmount || 0),
            loanAmount: Number(w.loanAmount || 0),
            loanResetBaseline: Number(w.loanResetBaseline || 0),
            lastSettledDate: w.lastSettledDate || '',
            settledPeriods: JSON.stringify(normalizeSettledPeriods(w.settledPeriods)),
            overtime: JSON.stringify(Array.isArray(w.overtime) ? w.overtime : []),
            phone: w.phone || '',
            bankName: w.bankName || '',
            accountNum: w.accountNum || '',
            ifsc: w.ifsc || ''
        })),
        payments,
        paymentTransactions,
        attendance: attendanceEntries.map(entry => ({
            date: entry.date,
            farmId: entry.farmId,
            farmName: entry.farmName,
            workerId: entry.workerId,
            workerName: entry.workerName,
            value: normalizeAttendanceValue(entry.value),
            workType: entry.workType || ''
        })),
        selectedAttendance: selectedAttendanceEntries.map(entry => ({
            date: entry.date,
            farmId: entry.farmId,
            farmName: entry.farmName,
            workerId: entry.workerId,
            workerName: entry.workerName,
            value: normalizeAttendanceValue(entry.value),
            workType: entry.workType || ''
        })),
        backupMeta: state.backupMeta || {}
    };
}

window.saveGoogleSheetsConfig = function () {
    if (!currentUser?.isAdmin) return alert(t('common.adminAccessRequired'));
    const input = document.getElementById('google-sheets-webhook-url');
    if (!input) return;
    const url = cleanText(input.value);
    if (!url) {
        setStoredGoogleSheetsWebhookUrl('');
        updateGoogleSheetsSyncStatus();
        showToast(t('sheets.urlCleared'));
        return;
    }
    if (!isValidGoogleSheetsWebhookUrl(url)) {
        return alert(t('sheets.invalidWebhook'));
    }
    setStoredGoogleSheetsWebhookUrl(url);
    updateGoogleSheetsSyncStatus();
    showToast(t('sheets.urlSaved'));
};

window.syncToGoogleSheets = async function () {
    if (!currentUser?.isAdmin && !currentUser?.permissions?.canManageBackup) {
        return alert(t('sheets.uploadPermissionError'));
    }

    const webhookUrl = getStoredGoogleSheetsWebhookUrl();
    if (!webhookUrl) return alert(t('sheets.saveUrlFirst'));
    if (!isValidGoogleSheetsWebhookUrl(webhookUrl)) return alert(t('sheets.savedUrlInvalid'));

    const syncBtn = document.getElementById('sync-google-sheets-btn');
    const prevLabel = syncBtn?.innerText || '';
    try {
        if (syncBtn) {
            syncBtn.disabled = true;
            syncBtn.innerText = t('common.uploading');
        }
        const payload = buildGoogleSheetsPayload();
        let uploaded = false;
        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`Upload failed with status ${response.status}`);
            uploaded = true;
        } catch (corsError) {
            // Fallback for Apps Script endpoints where CORS preflight/headers can be strict.
            await fetch(webhookUrl, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload)
            });
            uploaded = true;
        }
        if (!uploaded) throw new Error(t('sheets.requestNotSent'));

        setStoredGoogleSheetsLastSyncAt(Date.now());
        updateGoogleSheetsSyncStatus();
        showToast(t('sheets.uploadSuccess'));
        if (typeof logActivity === 'function') {
            logActivity(t('activity.uploadedSheets', { uploadId: payload.uploadId, rows: payload.summary.attendanceRows }));
        }
    } catch (error) {
        console.error(error);
        showToast(t('sheets.uploadFailed', { message: error.message || error }), true);
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.innerText = prevLabel || t('common.uploadToGoogleSheets');
        }
    }
};

window.handleExcelImport = function (event) {
    if (!currentUser?.isAdmin && !currentUser?.permissions?.canManageBackup) {
        return alert(t('sheets.restorePermissionError'));
    }

    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        alert(t('recovery.excelLibraryMissing'));
        event.target.value = '';
        return;
    }

    const fileReader = new FileReader();
    fileReader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            let importedFarms = 0;
            let importedWorkers = 0;
            let importedAttendance = 0;
            let skippedAttendance = 0;

            // Read Farms
            if (workbook.SheetNames.includes('Farms')) {
                if (!Array.isArray(state.farms)) state.farms = [];
                const farmsSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Farms']);
                farmsSheet.forEach(row => {
                    const farmId = cleanText(row['id'] || row['Farm ID'] || row['farmId']) || ('f' + Date.now() + Math.random().toString(36).substring(2, 7));
                    const rawName = row['Farm Name'] || row['name'];
                    if (isCorruptedLabel(rawName)) return;
                    const safeName = sanitizeFarmName(rawName, farmId);
                    if (!safeName) return;

                    const existingById = state.farms.find(f => f.id === farmId);
                    const existingByName = state.farms.find(f => cleanText(f.name).toLowerCase() === safeName.toLowerCase());
                    if (existingById) {
                        existingById.name = safeName;
                        existingById.location = cleanText(row['Location'] || row['location'] || existingById.location);
                        existingById.capacity = cleanText(row['Capacity'] || existingById.capacity);
                        return;
                    }
                    if (!existingByName) {
                        state.farms.push({
                            id: farmId,
                            name: safeName,
                            location: cleanText(row['Location'] || row['location']),
                            capacity: cleanText(row['Capacity'])
                        });
                        importedFarms++;
                    }
                });
            }

            // Read Workers
            if (workbook.SheetNames.includes('Workers')) {
                if (!Array.isArray(state.workers)) state.workers = [];
                const workersSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Workers']);
                workersSheet.forEach(row => {
                    const workerId = cleanText(row['id'] || row['Worker ID'] || row['workerId']) || ('w' + Date.now() + Math.random().toString(36).substring(2, 7));
                    const rawName = row['Worker Name'] || row['name'] || row['Name'];
                    if (isCorruptedLabel(rawName)) return;
                    const safeName = sanitizeWorkerName(rawName, workerId);
                    if (!safeName) return;

                    const dailyWage = Number(row['Daily Wage'] ?? row['dailyWage'] ?? row['Daily Wage (INR)']) || 0;
                    const overtimeCharge = Number(row['Overtime Charge'] ?? row['overtimeCharge'] ?? row['Overtime Charge (INR)']) || 0;
                    const initialDebt = Number(row['Initial Debt'] ?? row['initialDebt'] ?? row['Opening Balance'] ?? row['openingBalance']) || 0;
                    const paidAmount = Number(row['Paid Amount'] ?? row['paidAmount'] ?? row['Amount Paid (INR)']) || 0;
                    const loanAmount = Number(row['Loan Balance'] ?? row['loanAmount'] ?? row['Loans (INR)']) || 0;
                    const loanResetBaseline = Number(row['Loan Reset Baseline'] ?? row['loanResetBaseline']) || 0;
                    const lastSettledDate = parseImportedDate(row['Last Settled Date'] ?? row['lastSettledDate']);
                    const dailyWageProvided = row['Daily Wage'] !== undefined || row['dailyWage'] !== undefined || row['Daily Wage (INR)'] !== undefined;
                    const overtimeChargeProvided = row['Overtime Charge'] !== undefined || row['overtimeCharge'] !== undefined || row['Overtime Charge (INR)'] !== undefined;
                    const initialDebtProvided = row['Initial Debt'] !== undefined || row['initialDebt'] !== undefined || row['Opening Balance'] !== undefined || row['openingBalance'] !== undefined;
                    const paidAmountProvided = row['Paid Amount'] !== undefined || row['paidAmount'] !== undefined || row['Amount Paid (INR)'] !== undefined;
                    const loanAmountProvided = row['Loan Balance'] !== undefined || row['loanAmount'] !== undefined || row['Loans (INR)'] !== undefined;
                    const loanResetBaselineProvided = row['Loan Reset Baseline'] !== undefined || row['loanResetBaseline'] !== undefined;
                    const lastSettledDateProvided = row['Last Settled Date'] !== undefined || row['lastSettledDate'] !== undefined;
                    const phoneProvided = row['Phone'] !== undefined || row['phone'] !== undefined;
                    const bankNameProvided = row['Bank Name'] !== undefined || row['bankName'] !== undefined;
                    const accountNumProvided = row['Account No'] !== undefined || row['accountNum'] !== undefined;
                    const ifscProvided = row['IFSC'] !== undefined || row['ifsc'] !== undefined;
                    const settledPeriodsRaw = row['Settled Periods'] ?? row['settledPeriods'];
                    const settledPeriodsProvided = settledPeriodsRaw !== undefined;
                    const settledPeriods = normalizeSettledPeriods(parseImportedJsonArray(settledPeriodsRaw));
                    const overtimeRaw = row['Extra Wage Entries'] ?? row['Extra Wages'] ?? row['overtime'];
                    const overtimeProvided = overtimeRaw !== undefined;
                    const overtimeEntries = sanitizeOvertimeEntries(overtimeRaw);
                    const existing = state.workers.find(w => w.id === workerId) ||
                        state.workers.find(w => cleanText(w.name).toLowerCase() === safeName.toLowerCase());

                    if (existing) {
                        existing.name = safeName;
                        existing.role = cleanText(row['Role'] || row['role'] || existing.role) || 'Daily Worker';
                        if (dailyWageProvided) existing.dailyWage = dailyWage;
                        if (overtimeChargeProvided) existing.overtimeCharge = overtimeCharge;
                        if (initialDebtProvided) existing.initialDebt = initialDebt;
                        if (paidAmountProvided) existing.paidAmount = paidAmount;
                        if (loanAmountProvided) existing.loanAmount = loanAmount;
                        if (loanResetBaselineProvided) existing.loanResetBaseline = loanResetBaseline;
                        if (lastSettledDateProvided) existing.lastSettledDate = lastSettledDate;
                        if (phoneProvided) existing.phone = cleanText(row['Phone'] ?? row['phone']);
                        if (bankNameProvided) existing.bankName = cleanText(row['Bank Name'] ?? row['bankName']);
                        if (accountNumProvided) existing.accountNum = cleanText(row['Account No'] ?? row['accountNum']);
                        if (ifscProvided) existing.ifsc = cleanText(row['IFSC'] ?? row['ifsc']);
                        if (settledPeriodsProvided) existing.settledPeriods = settledPeriods;
                        else if (!Array.isArray(existing.settledPeriods)) existing.settledPeriods = [];
                        if (overtimeProvided) existing.overtime = overtimeEntries;
                        else if (!Array.isArray(existing.overtime)) existing.overtime = [];
                        return;
                    }

                    state.workers.push({
                        id: workerId,
                        name: safeName,
                        role: cleanText(row['Role'] || row['role']) || 'Daily Worker',
                        dailyWage,
                        overtimeCharge,
                        initialDebt,
                        paidAmount,
                        loanAmount,
                        loanResetBaseline,
                        lastSettledDate,
                        phone: cleanText(row['Phone'] || row['phone']),
                        bankName: cleanText(row['Bank Name']),
                        accountNum: cleanText(row['Account No']),
                        ifsc: cleanText(row['IFSC']),
                        settledPeriods,
                        overtime: overtimeEntries
                    });
                    importedWorkers++;
                });
            }

            // Read Attendance
            if (workbook.SheetNames.includes('Attendance')) {
                if (!state.attendance) state.attendance = {};
                const attSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Attendance']);

                attSheet.forEach(row => {
                    const dateStr = parseImportedDate(row['Date'] ?? row['Date Range'] ?? row['date']);
                    if (!dateStr || String(dateStr).includes('No Records')) {
                        skippedAttendance++;
                        return;
                    }

                    const parsedValue = normalizeAttendanceValue(row['Value'] ?? row['Total Days'] ?? row['value']);
                    if (parsedValue === null) {
                        skippedAttendance++;
                        return;
                    }

                    const farmIdRaw = cleanText(row['Farm ID'] || row['farmId']);
                    const workerIdRaw = cleanText(row['Worker ID'] || row['workerId']);
                    const farmName = sanitizeFarmName(row['Farm'] || row['Farm Name'] || row['farmName'], farmIdRaw);
                    const workerName = sanitizeWorkerName(row['Worker'] || row['Worker Name'] || row['Name'] || row['workerName'], workerIdRaw);

                    const farm = (farmIdRaw ? state.farms.find(f => f.id === farmIdRaw) : null) ||
                        state.farms.find(f => cleanText(f.name).toLowerCase() === cleanText(farmName).toLowerCase());
                    const worker = (workerIdRaw ? state.workers.find(w => w.id === workerIdRaw) : null) ||
                        state.workers.find(w => cleanText(w.name).toLowerCase() === cleanText(workerName).toLowerCase());

                    if (!farm || !worker) {
                        skippedAttendance++;
                        return;
                    }

                    if (!state.attendance[dateStr]) state.attendance[dateStr] = {};
                    if (!state.attendance[dateStr][farm.id]) state.attendance[dateStr][farm.id] = {};
                    state.attendance[dateStr][farm.id][worker.id] = parsedValue;
                    importedAttendance++;
                });
            }

            state = sanitizeStateForPersistence(state);
            saveState();
            renderAll();
            showToast(t('recovery.restoreCounts', { farms: importedFarms, workers: importedWorkers, attendance: importedAttendance }));
            if (skippedAttendance > 0) showToast(t('recovery.invalidRowsSkipped', { count: skippedAttendance }), true);
            if (typeof logActivity === 'function') {
                logActivity(t('activity.restoredExcel', { attendance: importedAttendance, skipped: skippedAttendance }));
            }

        } catch (err) {
            console.error(err);
            alert(t('recovery.readExcelError', { message: err.message || err.toString() }));
        } finally {
            event.target.value = '';
        }
    };
    fileReader.readAsArrayBuffer(file);
};

window.openAttendanceClearModal = function () {
    if (!currentUser?.isAdmin) return;
    const currentRange = getAttendanceRangeFromControls();
    const start = document.getElementById('clear-attendance-start');
    const end = document.getElementById('clear-attendance-end');
    if (start) start.value = currentRange?.start || '';
    if (end) end.value = currentRange?.end || currentRange?.start || '';
    window.handleAttendanceClearScopeChange();
    window.toggleModal('clear-attendance-modal');
};

window.handleAttendanceClearScopeChange = function () {
    const scope = document.getElementById('clear-attendance-scope')?.value || 'all';
    const rangeGroup = document.getElementById('clear-attendance-range-group');
    if (rangeGroup) rangeGroup.style.display = scope === 'range' ? 'block' : 'none';
};

window.confirmAttendanceClear = function () {
    if (!currentUser?.isAdmin) return;
    const scope = document.getElementById('clear-attendance-scope')?.value || 'all';
    const range = scope === 'range'
        ? normalizeDateRange(document.getElementById('clear-attendance-start')?.value, document.getElementById('clear-attendance-end')?.value)
        : null;
    if (scope === 'range' && !range) return alert(t('common.selectBothDatesFirst'));
    const attendanceEntries = getAttendanceEntries({ range });
    if (!attendanceEntries.length) return alert(t('attendance.noRecordsForScope'));
    const exported = exportWorkbook({
        fileName: `Attendance_Backup_${Date.now()}.xlsx`,
        farmsData: state.farms,
        workersData: state.workers,
        attendanceEntries
    });
    if (!exported) return;

    const deletedSnapshot = {};
    if (scope === 'all') {
        Object.keys(state.attendance || {}).forEach(date => {
            deletedSnapshot[date] = JSON.parse(JSON.stringify(state.attendance[date] || {}));
        });
    } else {
        Object.keys(state.attendance || {}).forEach(date => {
            if (isDateWithinRange(date, range)) {
                deletedSnapshot[date] = JSON.parse(JSON.stringify(state.attendance[date] || {}));
            }
        });
    }
    try {
        localStorage.setItem('farmWorkerDeletedAttendanceSnapshot', JSON.stringify({
            savedAt: Date.now(),
            scope,
            range,
            attendance: deletedSnapshot
        }));
    } catch (_error) { }

    if (scope === 'all') {
        state.attendance = {};
    } else {
        Object.keys(state.attendance || {}).forEach(date => {
            if (isDateWithinRange(date, range)) delete state.attendance[date];
        });
    }
    logActivity(t('activity.clearedAttendance', { scope }));
    saveState();
    window.toggleModal('clear-attendance-modal');
    renderAll();
    showToast(t('recovery.attendanceClearedSnapshot'));
};

window.restoreLastAttendanceSnapshot = function () {
    if (!currentUser?.isAdmin) return alert(t('common.adminAccessRequired'));
    let payload = null;
    try {
        payload = JSON.parse(localStorage.getItem('farmWorkerDeletedAttendanceSnapshot') || 'null');
    } catch (_error) {
        payload = null;
    }
    if (!payload?.attendance || typeof payload.attendance !== 'object') {
        return alert(t('recovery.noLocalSnapshot'));
    }

    Object.keys(payload.attendance).forEach(date => {
        if (!isValidISODateKey(date)) return;
        if (!state.attendance[date]) state.attendance[date] = {};
        const farmsForDate = payload.attendance[date] || {};
        Object.keys(farmsForDate).forEach(farmId => {
            if (!state.attendance[date][farmId]) state.attendance[date][farmId] = {};
            const workersForFarm = farmsForDate[farmId] || {};
            Object.keys(workersForFarm).forEach(workerId => {
                const safeValue = normalizeAttendanceValue(workersForFarm[workerId]);
                if (safeValue !== null) state.attendance[date][farmId][workerId] = safeValue;
            });
        });
    });

    state = sanitizeStateForPersistence(state);
    saveState();
    renderAll();
    if (typeof logActivity === 'function') logActivity(t('activity.restoredAttendanceSnapshot'));
    showToast(t('recovery.attendanceRestoredSnapshot'));
};



// --- Bot Logic ---
window.toggleBotPanel = function () {
    const p = document.getElementById('bot-panel');
    if (!p) return;
    p.style.display = (p.style.display === 'none' || p.style.display === '') ? 'flex' : 'none';
    if (p.style.display === 'flex') setTimeout(() => document.getElementById('bot-input')?.focus(), 100);
};

window.sendBotMessage = function () {
    const input = document.getElementById('bot-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    appendBotMsg(msg, 'user');
    input.value = '';
    setTimeout(() => {
        const reply = generateBotResponse(msg);
        appendBotMsg(reply, 'bot');
    }, 600);
};

function appendBotMsg(text, sender) {
    const box = document.getElementById('bot-messages');
    if (!box) return;
    const isUser = sender === 'user';
    const b = document.createElement('div');
    b.style.cssText = `margin-bottom:8px; padding:10px; border-radius:12px; max-width:85%; align-self:${isUser ? 'flex-end' : 'flex-start'}; background:${isUser ? 'var(--primary)' : 'var(--surface-solid)'}; color:${isUser ? 'white' : 'var(--text-strong)'}; border:${isUser ? 'none' : '1px solid var(--border)'}; font-size:0.9rem;`;
    if (isUser) b.textContent = text; else b.innerHTML = text;
    box.appendChild(b);
    box.scrollTop = box.scrollHeight;
}

function generateBotResponse(q) {
    q = q.toLowerCase();
    if (q.includes('pending') || q.includes('pay')) {
        let total = state.workers.reduce((s, w) => s + Math.max(0, calculateWorkerStats(w.id).pendingAmount), 0);
        return t('bot.pendingPayReply', { amount: formatCurrency(total) });
    }
    if (q.includes('who') && (q.includes('here') || q.includes('present'))) {
        const d = getTodayLocalISO();
        let count = 0;
        if (state.attendance[d]) {
            Object.values(state.attendance[d]).forEach(f => {
                Object.values(f).forEach(val => {
                    if (hasAttendanceWork(val)) count++;
                });
            });
        }
        return t('bot.presentTodayReply', { count });
    }
    return t('bot.defaultReply');
}

// --- Payment & Extra Wages ---
function recordPaymentHistoryEntry(worker, details = {}) {
    if (!worker?.id) return;
    if (!Array.isArray(state.paymentHistory)) state.paymentHistory = [];
    const loggedAt = new Date().toISOString();
    state.paymentHistory.push({
        id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        loggedAt,
        entryDate: getTodayLocalISO(),
        workerId: worker.id,
        workerName: worker.name || t('common.workerLabel', { id: worker.id }),
        type: cleanText(details.type || 'payment'),
        paidAmount: Number(details.paidAmount || 0) || 0,
        addedLoanAmount: Number(details.addedLoanAmount || 0) || 0,
        setLoanAmount: Number(details.setLoanAmount || 0) || 0,
        previousPaidAmount: Number(details.previousPaidAmount ?? 0) || 0,
        newPaidAmount: Number(details.newPaidAmount ?? worker.paidAmount ?? 0) || 0,
        previousLoanAmount: Number(details.previousLoanAmount ?? 0) || 0,
        newLoanAmount: Number(details.newLoanAmount ?? worker.loanAmount ?? 0) || 0,
        settledRangeStart: cleanText(details.settledRangeStart),
        settledRangeEnd: cleanText(details.settledRangeEnd),
        note: cleanText(details.note)
    });
}

window.openPaymentModal = function (id) {
    const w = state.workers.find(x => x.id === id);
    if (!w) return;
    document.getElementById('payment-worker-id').value = id;
    const title = document.getElementById('payment-modal-title');
    if (title) title.innerText = `${t('paymentModal.logPaymentFor')}: ${w.name}`;
    const paidDisplay = document.getElementById('current-paid-display');
    if (paidDisplay) paidDisplay.innerText = formatCurrency(w.paidAmount || 0);
    const loanDisplay = document.getElementById('current-loan-display');
    if (loanDisplay) loanDisplay.innerText = formatCurrency(w.loanAmount || 0);
    const paidInput = document.getElementById('payment-add-paid');
    if (paidInput) paidInput.value = '';
    const loanInput = document.getElementById('payment-add-loan');
    if (loanInput) loanInput.value = '';
    const setLoanInput = document.getElementById('payment-set-loan');
    if (setLoanInput) setLoanInput.value = '';
    // ✅ FIX 5 & 6: Always reset the settle toggle and its date container on every modal open.
    // Previously the container could remain visible/hidden from a previous open-close cycle.
    const settleToggle = document.getElementById('payment-settle-attendance');
    if (settleToggle) settleToggle.checked = false;
    const settleRangeContainer = document.getElementById('payment-settle-date-container');
    if (settleRangeContainer) settleRangeContainer.style.display = 'none';
    const settleStart = document.getElementById('payment-settle-start');
    if (settleStart) settleStart.value = '';
    const settleEnd = document.getElementById('payment-settle-end');
    if (settleEnd) settleEnd.value = '';
    window.toggleModal('payment-modal');
};

window.settleWorkerPayment = function (mode) {
    const id = document.getElementById('payment-worker-id').value;
    const w = state.workers.find(x => x.id === id);
    if (!w) return;
    const fullySettled = typeof mode === 'string' || mode?.fullySettled === true;
    if (fullySettled) {
        if (!confirm(t('paymentModal.settleConfirm'))) return;
        const previousPaidAmount = Number(w.paidAmount || 0) || 0;
        const previousLoanAmount = Number(w.loanAmount || 0) || 0;
        w.lastSettledDate = getLatestRecordedDateForWorker(id);
        w.initialDebt = 0;
        w.paidAmount = 0;
        w.loanResetBaseline = w.loanAmount || 0;
        // Fix 3: Clear settledPeriods on full settlement to prevent double-excluding future attendance
        w.settledPeriods = [];
        recordPaymentHistoryEntry(w, {
            type: 'full_settlement',
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0,
            note: t('paymentModal.markedSettledThrough', {
                date: w.lastSettledDate || t('paymentModal.latestRecordedDate')
            })
        });
        logActivity(t('activity.markedSettled', { name: w.name }));
        saveState();
        window.toggleModal('payment-modal');
        renderPaymentsTable();
        renderDashboard();
        showToast(t('payments.paymentUpdated'));
        return;
    }

    const paid = parseFloat(document.getElementById('payment-add-paid').value) || 0;
    const addedLoan = parseFloat(document.getElementById('payment-add-loan').value) || 0;
    const setLoanRaw = document.getElementById('payment-set-loan').value;
    const shouldSettlePeriod = !!document.getElementById('payment-settle-attendance')?.checked;
    const settleRange = shouldSettlePeriod
        ? normalizeDateRange(document.getElementById('payment-settle-start')?.value, document.getElementById('payment-settle-end')?.value)
        : null;
    if (shouldSettlePeriod && !settleRange) return alert(t('paymentModal.chooseSettlementDates'));
    if (paid <= 0 && addedLoan <= 0 && setLoanRaw === '' && !shouldSettlePeriod) return;

    const previousPaidAmount = Number(w.paidAmount || 0) || 0;
    const previousLoanAmount = Number(w.loanAmount || 0) || 0;
    w.paidAmount = (w.paidAmount || 0) + paid;
    if (setLoanRaw !== '') {
        w.loanAmount = Math.max(0, parseFloat(setLoanRaw) || 0);
        // Fix 2b: If admin explicitly sets the loan to a lower amount than the baseline,
        // update the baseline down to match — otherwise activeLoan calculation hides the new loan.
        if ((w.loanResetBaseline || 0) > w.loanAmount) {
            w.loanResetBaseline = w.loanAmount;
        }
    } else w.loanAmount = (w.loanAmount || 0) + addedLoan;
    if (shouldSettlePeriod && settleRange) {
        if (!Array.isArray(w.settledPeriods)) w.settledPeriods = [];
        w.settledPeriods.push(settleRange);
        w.settledPeriods = mergeDateRanges(w.settledPeriods);
    }
    if (paid > 0) {
        recordPaymentHistoryEntry(w, {
            type: 'payment',
            paidAmount: paid,
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0
        });
    }
    if (setLoanRaw !== '') {
        recordPaymentHistoryEntry(w, {
            type: 'loan_set',
            setLoanAmount: Math.max(0, parseFloat(setLoanRaw) || 0),
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0
        });
    } else if (addedLoan > 0) {
        recordPaymentHistoryEntry(w, {
            type: 'loan_add',
            addedLoanAmount: addedLoan,
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0
        });
    }
    if (shouldSettlePeriod && settleRange) {
        recordPaymentHistoryEntry(w, {
            type: 'attendance_settlement',
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0,
            settledRangeStart: settleRange.start,
            settledRangeEnd: settleRange.end,
            note: t('paymentModal.settledAttendanceRange', {
                start: settleRange.start,
                end: settleRange.end
            })
        });
    }
    logActivity(t('activity.loggedPayment', { name: w.name, pay: paid, loan: setLoanRaw !== '' ? setLoanRaw : addedLoan }));
    saveState();
    window.toggleModal('payment-modal');
    renderPaymentsTable();
    renderDashboard();
    showToast(t('payments.paymentUpdated'));
};

window.openBreakdownModal = function (id) {
    const w = state.workers.find(x => x.id === id);
    if (!w) return;
    const s = calculateWorkerStats(id);
    document.getElementById('breakdown-modal-title').innerText = t('breakdown.titleWithWorker', { worker: w.name });

    // Generate Farm Breakdown List
    let breakdownHtml = '<div style="margin-top:20px; border-top:1px solid var(--border); padding-top:16px;">';
    breakdownHtml += `<h4 style="margin-bottom:12px; color:var(--text-strong);">${t('breakdown.sectionTitle')}</h4>`;
    breakdownHtml += '<div style="max-height:300px; overflow-y:auto; font-size:0.9rem;">';

    const dates = Object.keys(state.attendance).sort().reverse();
    let hasEntries = false;
    for (const date of dates) {
        for (const fId in state.attendance[date]) {
            const val = state.attendance[date][fId][id];
            if (hasAttendanceWork(val)) {
                hasEntries = true;
                const f = state.farms.find(x => x.id === fId);
                const farmName = f ? f.name : t('common.deletedFarm', { id: fId });
                const normalizedVal = normalizeAttendanceValue(val);
                let type = getAttendanceStatusLabel(normalizedVal);
                breakdownHtml += `
                    <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
                        <span>${formatDateToDDMMYYYY(date)}</span>
                        <span><strong>${escapeHtml(farmName)}</strong></span>
                        <span style="color:var(--primary); font-weight:600;">${type}</span>
                    </div>
                `;
            }
        }
    }

    if (!hasEntries) breakdownHtml += `<p style="color:var(--text-muted); padding:10px 0;">${t('breakdown.noAttendance')}</p>`;
    breakdownHtml += '</div></div>';

    document.getElementById('breakdown-content').innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
            <p>${t('payments.totalDays')}: <strong>${window.formatCountValue ? window.formatCountValue(s.currentCycleDays ?? s.totalDays) : (s.currentCycleDays ?? s.totalDays)}</strong></p>
            <p>${t('payments.earned')}: <strong>${formatCurrency(s.totalEarned)}</strong></p>
            <p>${t('workerModal.initialDebt')}: <strong>${formatCurrency(s.initialDebt || 0)}</strong></p>
            <p>${t('payments.paid')}: <strong>${formatCurrency(s.paidAmount)}</strong></p>
            <p>${t('payments.loans')}: <strong>${formatCurrency(s.loanAmount)}</strong></p>
        </div>
        <p style="margin-top:12px; font-size:1.1rem; color:var(--primary); border-top:1px solid var(--border); padding-top:12px;">${t('payments.pending')}: <strong>${formatCurrency(s.pendingAmount)}</strong></p>
        ${breakdownHtml}
    `;
    window.toggleModal('breakdown-modal');
};

window.deleteExtraWage = function (wId, eId) {
    if (!confirm(t('breakdown.deleteConfirm'))) return;
    const w = state.workers.find(x => x.id === wId);
    if (w && w.overtime) {
        w.overtime = w.overtime.filter(x => x.id !== eId);
        saveState();
        window.openBreakdownModal(wId); // Refresh
    }
};

window.deleteFarm = function () {
    const id = document.getElementById('farm-id').value;
    if (!id || !confirm(t('farmModal.deleteConfirm'))) return;
    state.farms = state.farms.filter(x => x.id !== id);
    const farmSelect = document.getElementById('attendance-farm-select');
    if (farmSelect && farmSelect.value === id) farmSelect.value = '';
    logActivity(t('activity.deletedFarm'));
    saveState();
    window.toggleModal('farm-modal');
    renderAll();
};

window.saveProfile = async function () {
    if (!currentUser) return;
    const profileStatus = document.getElementById('profile-status');
    const data = {
        fullName: document.getElementById('profile-name')?.value.trim() || '',
        phone: document.getElementById('profile-phone')?.value.trim() || '',
        language: document.getElementById('profile-language')?.value || currentUser.language || 'en',
        bankName: document.getElementById('profile-bank-name')?.value.trim() || '',
        accountNum: document.getElementById('profile-acc-no')?.value.trim() || '',
        ifsc: document.getElementById('profile-ifsc')?.value.trim() || ''
    };
    try {
        if (!currentUser.isDemo) {
            await db.collection('users').doc(currentUser.username).set(data, { merge: true });
        }
        currentUser = { ...currentUser, ...data };
        setSession(currentUser);
        setLanguage(data.language, { rerender: true });
        if (profileStatus) {
            profileStatus.innerText = t('profile.saved');
            profileStatus.style.display = 'block';
            profileStatus.style.color = '#059669';
        }
        showToast(t('profile.saved'));
    } catch (e) {
        if (profileStatus) {
            profileStatus.innerText = t('profile.error');
            profileStatus.style.display = 'block';
            profileStatus.style.color = '#ef4444';
        }
        showToast(t('profile.error'), true);
    }
};

window.clearAllPayments = function () {
    if (!currentUser?.isAdmin) return alert(t('admin.onlyAdminsClearPayments'));
    if (!confirm(t('admin.clearPaymentsConfirm'))) return;
    if (!confirm(t('admin.clearPaymentsFinal'))) return;
    state.workers = state.workers.map(worker => ({
        ...worker,
        paidAmount: 0,
        lastSettledDate: '',
        settledPeriods: [],
        loanResetBaseline: 0
    }));
    logActivity(t('activity.clearedPayments'));
    saveState();
    renderPaymentsTable();
    renderDashboard();
    showToast(t('admin.clearPaymentsSuccess'));
};

window.onLanguageChanged = function (_language, options) {
    populateProfileForm();
    refreshAdminPanels();
    refreshAdminUserFormText();
    if (options?.rerender === false) return;
    renderAll();
};

// === RECOVERY SYSTEM ===
window.showRecoveryPanel = function () {
    const panel = document.getElementById('recovery-panel');
    if (panel) {
        panel.style.display = 'block';
        panel.setAttribute('aria-hidden', 'false');
    }
};

window.hideRecoveryPanel = function () {
    const panel = document.getElementById('recovery-panel');
    if (panel) {
        panel.style.display = 'none';
        panel.setAttribute('aria-hidden', 'true');
    }
};

window.downloadFullBackup = function () {
    try {
        const backupData = {
            timestamp: new Date().toISOString(),
            mainData: JSON.parse(localStorage.getItem('farmWorkerState') || '{}'),
            demoData: JSON.parse(localStorage.getItem('farmWorkerState_demo') || '{}'),
            webhookUrl: getStoredGoogleSheetsWebhookUrl(),
            lastSync: getStoredGoogleSheetsLastSyncAt(),
            version: '5.6.0'
        };

        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chandragiri_complete_backup_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(t('recovery.fullBackupDownloaded'));
    } catch (error) {
        showToast(t('recovery.backupFailed', { message: error.message }), true);
    }
};

window.restoreFromBackup = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const backup = JSON.parse(e.target.result);
            if (confirm(t('recovery.overwriteConfirm'))) {
                if (backup.mainData) localStorage.setItem('farmWorkerState', JSON.stringify(sanitizeStateForPersistence(backup.mainData)));
                if (backup.demoData) localStorage.setItem('farmWorkerState_demo', JSON.stringify(sanitizeStateForPersistence(backup.demoData)));
                if (Object.prototype.hasOwnProperty.call(backup, 'webhookUrl')) setStoredGoogleSheetsWebhookUrl(backup.webhookUrl || '');
                if (Object.prototype.hasOwnProperty.call(backup, 'lastSync')) {
                    const restoredLastSync = Number(backup.lastSync || 0);
                    if (restoredLastSync > 0) setStoredGoogleSheetsLastSyncAt(restoredLastSync);
                    else localStorage.removeItem(GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY);
                }

                showToast(t('recovery.restoredReloading'));
                setTimeout(() => window.location.reload(), 2000);
            }
        } catch (error) {
            showToast(t('recovery.invalidBackupFile'), true);
        }
    };
    reader.readAsText(file);
    event.target.value = ''; // Reset input
};

// Check data integrity on load
window.checkDataOnLoad = function () {
    try {
        const mainData = localStorage.getItem('farmWorkerState');
        const demoData = localStorage.getItem('farmWorkerState_demo');

        if (mainData) JSON.parse(mainData);
        if (demoData) JSON.parse(demoData);

        return true;
    } catch (e) {
        console.error('Data corruption detected on load');
        window.showRecoveryPanel();
        return false;
    }
};
// === END RECOVERY SYSTEM ===

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    const session = getValidSession();
    setLanguage(session?.language || window.getStoredLanguage?.() || 'en', { rerender: false });
    let savedTheme = document.documentElement.getAttribute('data-theme') || 'vibrant';
    try { savedTheme = localStorage.getItem('appTheme') || savedTheme; } catch (_error) { }
    applyTheme(savedTheme);
    if (session) {
        currentUser = session;
        setLanguage(currentUser.language || 'en', { rerender: false });
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-container').style.display = 'block';
        applyPermissions(currentUser.permissions || {});
        loadState();
    } else {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('main-container').style.display = 'none';
        showLoading(false);
    }

    // Bind Navigation Listeners
    document.querySelectorAll('.nav-btn[data-target]').forEach(btn => {
        btn.addEventListener('click', () => window.activateSection(btn.getAttribute('data-target')));
    });

    // Set default attendance date if not set
    const attDate = document.getElementById('attendance-date');
    if (attDate && !attDate.value) attDate.value = getTodayLocalISO();
    const attDateEnd = document.getElementById('attendance-date-end');
    if (attDateEnd && !attDateEnd.value) attDateEnd.value = getTodayLocalISO();
    if (attDateEnd) {
        attDateEnd.addEventListener('change', () => {
            if (currentUser?.permissions?.canEdit) renderAttendanceView();
            else renderAttendanceSummary();
        });
    }
    const farmSelect = document.getElementById('attendance-farm-select');
    if (farmSelect) {
        farmSelect.addEventListener('change', () => {
            if (currentUser?.permissions?.canEdit) renderAttendanceView();
            else renderAttendanceSummary();
        });
    }
    const profileLanguage = document.getElementById('profile-language');
    if (profileLanguage) {
        profileLanguage.addEventListener('change', () => {
            setLanguage(profileLanguage.value, { rerender: true });
        });
    }
    const farmForm = document.getElementById('add-farm-form');
    if (farmForm) farmForm.addEventListener('submit', event => { event.preventDefault(); window.saveFarm(); });
    const workerForm = document.getElementById('add-worker-form');
    if (workerForm) workerForm.addEventListener('submit', event => { event.preventDefault(); window.saveWorker(); });
    const paymentForm = document.getElementById('add-payment-form');
    if (paymentForm) paymentForm.addEventListener('submit', event => { event.preventDefault(); window.settleWorkerPayment(); });

    // ✅ FIX 5: Add the missing change listener for the "Settle Attendance" toggle in the payment modal.
    // Without this, toggling the checkbox had no visual effect — the date picker stayed permanently hidden.
    const settleAttendanceToggle = document.getElementById('payment-settle-attendance');
    if (settleAttendanceToggle) {
        settleAttendanceToggle.addEventListener('change', function () {
            const container = document.getElementById('payment-settle-date-container');
            if (container) container.style.display = this.checked ? 'block' : 'none';
        });
    }

    // Initialize recovery file input
    const restoreInput = document.getElementById('restore-file-input');
    if (restoreInput) restoreInput.addEventListener('change', window.restoreFromBackup);

    // Check data integrity on page load
    setTimeout(() => {
        if (!window.checkDataOnLoad()) {
            console.log('Recovery panel shown due to data issues');
        }
    }, 1000);
});

// Add showToast global
window.showToast = function (m, err = false) {
    const c = document.getElementById('toast-container'); if (!c) return;
    const toastEl = document.createElement('div');
    toastEl.className = `toast ${err ? 'error' : ''}`;
    toastEl.innerHTML = `<span class="toast-message">${escapeHtml(m)}</span>`;
    c.appendChild(toastEl);
    setTimeout(() => toastEl.classList.add('active'), 10);
    setTimeout(() => { toastEl.classList.remove('active'); setTimeout(() => toastEl.remove(), 400); }, 3000);
};

function updateGreetings() {
    const el = document.querySelector('#dashboard .greeting-text');
    if (el && currentUser) {
        const n = currentUser.fullName || currentUser.username;
        el.innerHTML = `${t('common.welcomeBack', { name: escapeHtml(n) })} <span class="waving-hand">👋</span>`;
    }
}
