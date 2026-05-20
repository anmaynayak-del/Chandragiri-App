/**
 * FarmWorker Pro - Client-side UI Logic (Version 6.1.0)
 * Weekly Payment Cycle System, Smart Export, Backup Management & Improved UI
 */
const APP_VERSION = '6.1.0';


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
    weatherConfig: { lat: 14.6191, lon: 74.8441, locationName: 'Chandragiri Estate' },
    googleSheetsConfig: { webhookUrl: '', lastSyncAt: 0, updatedAt: 0 },
    syncMeta: { updatedAt: 0, updatedBy: '', appVersion: APP_VERSION }
};

let currentUser = null;
const USER_DELETE_UNDO_MS = 10000;
const pendingUserDeletes = new Map();
const AUTO_BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const CORRUPTION_CHECK_INTERVAL_MS = 30000;
const FIRESTORE_SYNC_DEBOUNCE_MS = 2500;
const SPLASH_FADE_DURATION_MS = 650;
const LOAD_TIMEOUT_MS = 2500;
const RENDER_DEBOUNCE_MS = 50;
const PAYMENT_VALIDATION_DELAY_MS = 50;
const GUEST_ACCESS_HOUR_MS = 60 * 60 * 1000;
const GUEST_ACCESS_DAY_MS = 24 * 60 * 60 * 1000;

// === DATA PROTECTION LAYER v3 ===


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
            version: `${APP_VERSION}-protected`
        };

        // Save to multiple backup slots (rotating)
        const backupKey = `backup_${Date.now()}`;
        localStorage.setItem(backupKey, JSON.stringify(backup));

        // Keep only last 5 backups
        const keys = Object.keys(localStorage).filter(k => k.startsWith('backup_'));
        if (keys.length > 5) {
            keys.sort().slice(0, keys.length - 5).forEach(k => localStorage.removeItem(k));
        }

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

// Auto-backup every 24 hours; only runs after data has loaded from Firestore.
let autoBackupInterval = setInterval(() => {
    if (!isHydrated) return; // Don't backup before real data has loaded
    const lastBackup = parseInt(localStorage.getItem('last_auto_backup') || '0');
    const now = Date.now();
    if (now - lastBackup > AUTO_BACKUP_STALE_MS) {
        window.emergencyBackup();
        localStorage.setItem('last_auto_backup', now);
    }
}, AUTO_BACKUP_INTERVAL_MS);

// Lightweight corruption detection; checks structure, not full serialization.
let corruptionCheckInterval = setInterval(() => {
    if (!isHydrated) return; // FIX 5: Skip corruption check before data loads
    try {
        // Lightweight check: verify core arrays/objects are still valid types
        if (!Array.isArray(state.workers) || !Array.isArray(state.farms) || typeof state.attendance !== 'object') {
            throw new Error('Core state structure corrupted');
        }
    } catch (e) {
        console.error('DATA CORRUPTION DETECTED!', e.message);
        window.emergencyBackup();
        showToast(t('recovery.dataCorruptionBackupCreated'), true);
    }
}, CORRUPTION_CHECK_INTERVAL_MS);


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
        // Firestore persistent caching is disabled so the app loads fresh network data.
        // Persistent Firestore caching is intentionally disabled so the app loads
        // fresh network data instead of keeping IndexedDB cache state between runs.
    } catch (e) { console.warn('Firebase unavailable', e); }
}

// --- Session Management ---
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;
function setSession(user) {
    localStorage.setItem('sessionUser', JSON.stringify(sanitizeUserForSession(user)));
    localStorage.setItem('sessionExpiry', Date.now() + SESSION_DURATION_MS);
}
function clearSession() {
    localStorage.removeItem('sessionUser');
    localStorage.removeItem('sessionExpiry');
}
function getValidSession() {
    try {
        const userStr = localStorage.getItem('sessionUser');
        const expiry = parseInt(localStorage.getItem('sessionExpiry'));
        if (userStr && expiry && Date.now() < expiry) {
            const user = sanitizeUserForSession(JSON.parse(userStr));
            if (user.accessExpiry && Date.now() > user.accessExpiry) {
                clearSession();
                return null;
            }
            localStorage.setItem('sessionUser', JSON.stringify(user));
            return user;
        }
        if (userStr) clearSession();
    } catch (e) {
        console.warn('Stored session could not be restored; clearing session.', e);
        clearSession();
    }
    return null;
}

const SAFE_YEAR_MIN = 2000;
const SAFE_YEAR_MAX = 2100;
const MAX_DAILY_WORK_CAPACITY = 1;
const GOOGLE_SHEETS_WEBHOOK_STORAGE_KEY = 'chandragiri_google_sheets_webhook_url';
const GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY = 'chandragiri_google_sheets_last_sync_at';
const DEFAULT_GOOGLE_SHEETS_CONFIG = Object.freeze({ webhookUrl: '', lastSyncAt: 0, updatedAt: 0 });
const DEFAULT_THEME_MODES = Object.freeze(['light', 'dark', 'vibrant', 'comfort']);
const THEME_LABEL_KEYS = Object.freeze({
    light: 'menu.lightMode',
    dark: 'menu.darkMode',
    vibrant: 'menu.vibrantMode',
    comfort: 'menu.comfortMode'
});

function getAllowedThemes(user = currentUser) {
    if (!user) return [...DEFAULT_THEME_MODES];
    if (user.isAdmin) return [...DEFAULT_THEME_MODES];

    const storedThemes = Array.isArray(user.allowedThemes)
        ? user.allowedThemes
        : [...DEFAULT_THEME_MODES];
    const normalizedThemes = DEFAULT_THEME_MODES.filter(theme => storedThemes.includes(theme));

    return normalizedThemes.length ? normalizedThemes : ['light'];
}

function renderThemeSelectOptions(selectEl, user = currentUser) {
    if (!selectEl) return;

    const allowedThemes = getAllowedThemes(user);
    let currentTheme = user?.theme || '';
    if (!currentTheme) {
        try {
            currentTheme = localStorage.getItem('appTheme') || '';
        } catch (_error) {
            currentTheme = '';
        }
    }

    selectEl.innerHTML = allowedThemes.map(theme => (
        `<option value="${theme}" data-i18n="${THEME_LABEL_KEYS[theme]}">${t(THEME_LABEL_KEYS[theme])}</option>`
    )).join('');
    selectEl.value = allowedThemes.includes(currentTheme) ? currentTheme : allowedThemes[0];
}

function syncAdminShortcuts() {
    const isAdmin = !!currentUser?.isAdmin;
    ['dashboard-admin-shortcut'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isAdmin ? '' : 'none';
    });
}


// --- Utility Functions ---

function getWorkerSettlementMeta(worker) {
    const meta = { settledRanges: [] };
    if (!worker) return meta;

    // Legacy support
    if (worker.lastSettledDate) {
        meta.settledRanges.push({
            start: '1970-01-01',
            end: worker.lastSettledDate
        });
    }

    // Modern support
    if (Array.isArray(worker.settledPeriods)) {
        worker.settledPeriods.forEach(period => {
            if (period && period.start && period.end) {
                meta.settledRanges.push({
                    start: period.start,
                    end: period.end
                });
            }
        });
    }

    return meta;
}

function isWorkerDateSettled(worker, date, settlementMeta) {
    if (!date) return false;
    const meta = settlementMeta || getWorkerSettlementMeta(worker);
    const checkDate = new Date(date).getTime();

    for (const range of meta.settledRanges) {
        const start = new Date(range.start).getTime();
        const end = new Date(range.end).getTime();
        if (checkDate >= start && checkDate <= end) {
            return true;
        }
    }
    return false;
}

window.formatCountValue = function (number) {
    const num = Number(number);
    if (!Number.isFinite(num)) return '0';
    return num % 1 === 0 ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
};

window.formatLocalizedDayCount = function (value) {
    const num = Number(value || 0);
    const countStr = window.formatCountValue(num);
    // Use the translation function t() if it exists
    const suffix = Math.abs(num - 1) < 0.001
        ? (typeof t === 'function' ? t('common.daySingular') : 'Day')
        : (typeof t === 'function' ? t('common.dayPlural') : 'Days');
    return `${countStr} ${suffix}`;
};

// Bug 1 fix: window.getCurrentLocale is defined correctly in i18n.js.
// The override that was here read from localStorage keys ('appLocale', 'language')
// that are never set anywhere in the codebase, causing locale-dependent formatting
// (dates, numbers) to always fall back to the browser locale and ignore the user's
// chosen in-app language. The correct implementation in i18n.js uses
// window.LANGUAGE_LOCALES[window.appLanguage] and must not be overridden.

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

function buildValidatedISODate(year, month, day) {
    const yyyy = Number(year);
    const mm = Number(month);
    const dd = Number(day);
    if (!Number.isInteger(yyyy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return '';
    const iso = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    return isValidISODateKey(iso) ? iso : '';
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
        return buildValidatedISODate(yyyy, mm, dd);
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
                // FIX 2: Skip storing '0' values; absent means no entry.
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
        byId.set(workerId, {
            ...existing,
            ...raw,           // preserve all extra fields
            id: workerId,
            name: safeName,
            role: cleanText(raw?.role || existing?.role) || 'Daily Worker',
            dailyWage: Number(raw?.dailyWage ?? existing?.dailyWage ?? 0) || 0,
            overtimeCharge: Number(raw?.overtimeCharge ?? existing?.overtimeCharge ?? 0) || 0,
            initialDebt: Number(raw?.initialDebt ?? existing?.initialDebt ?? 0) || 0,
            paidAmount: Number(raw?.paidAmount ?? existing?.paidAmount ?? 0) || 0,
            loanAmount: Math.max(0, Number(raw?.loanAmount ?? existing?.loanAmount ?? 0) || 0),
            phone: cleanText(raw?.phone || existing?.phone),
            bankName: cleanText(raw?.bankName || existing?.bankName),
            accountNum: cleanText(raw?.accountNum || existing?.accountNum),
            ifsc: cleanText(raw?.ifsc || existing?.ifsc),
            settledPeriods: Array.isArray(raw?.settledPeriods) ? raw.settledPeriods : (Array.isArray(existing?.settledPeriods) ? existing.settledPeriods : []),
            overtime: Array.isArray(raw?.overtime) ? raw.overtime : (Array.isArray(existing?.overtime) ? existing.overtime : []),
            loanResetBaseline: Number(raw?.loanResetBaseline ?? existing?.loanResetBaseline ?? 0) || 0,
            lastSettledDate: cleanText(raw?.lastSettledDate || existing?.lastSettledDate),
            createdBy: cleanText(raw?.createdBy || existing?.createdBy)
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
    next.googleSheetsConfig = sanitizeGoogleSheetsConfig(next.googleSheetsConfig, getLegacyGoogleSheetsConfig());
    next.syncMeta = sanitizeSyncMeta(next.syncMeta);
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
    const safeCloudSheets = sanitizeGoogleSheetsConfig(safeCloud.googleSheetsConfig);
    const safeLocalSheets = sanitizeGoogleSheetsConfig(safeLocal.googleSheetsConfig);
    return sanitizeStateForPersistence({
        ...safeCloud,
        ...safeLocal,
        farms: mergeRecordsById(safeCloud.farms, safeLocal.farms),
        workers: mergeRecordsById(safeCloud.workers, safeLocal.workers),
        attendance: safeLocal.attendance,
        paymentHistory: mergeRecordsById(safeCloud.paymentHistory, safeLocal.paymentHistory),
        paymentCycles: mergeRecordsById(safeCloud.paymentCycles, safeLocal.paymentCycles),
        auditLogs: Array.isArray(safeLocal.auditLogs) && safeLocal.auditLogs.length > 0
            ? safeLocal.auditLogs
            : (safeCloud.auditLogs || []),
        extraWages: { ...(safeCloud.extraWages || {}), ...(safeLocal.extraWages || {}) },
        backupMeta: { ...(safeCloud.backupMeta || {}), ...(safeLocal.backupMeta || {}) },
        weatherConfig: { ...(safeCloud.weatherConfig || {}), ...(safeLocal.weatherConfig || {}) },
        googleSheetsConfig: safeLocalSheets.updatedAt >= safeCloudSheets.updatedAt ? safeLocalSheets : safeCloudSheets,
        syncMeta: getStateUpdatedAt(safeLocal) >= getStateUpdatedAt(safeCloud) ? safeLocal.syncMeta : safeCloud.syncMeta,
        currentPaymentCycleId: cleanText(safeLocal.currentPaymentCycleId || safeCloud.currentPaymentCycleId),
        currentCycleStartDate: parseImportedDate(safeLocal.currentCycleStartDate || safeCloud.currentCycleStartDate) || ''
    });
}

function getFirestoreStatePayload(sourceState = state) {
    const safeState = sanitizeStateForPersistence(sourceState);
    return {
        farms: safeState.farms,
        workers: safeState.workers,
        attendance: safeState.attendance,
        paymentHistory: safeState.paymentHistory || [],
        paymentCycles: safeState.paymentCycles || [],
        currentPaymentCycleId: safeState.currentPaymentCycleId || '',
        currentCycleStartDate: safeState.currentCycleStartDate || '',
        auditLogs: safeState.auditLogs || [],
        extraWages: safeState.extraWages || {},
        backupMeta: safeState.backupMeta || {},
        weatherConfig: safeState.weatherConfig || {},
        googleSheetsConfig: safeState.googleSheetsConfig || DEFAULT_GOOGLE_SHEETS_CONFIG,
        syncMeta: safeState.syncMeta || sanitizeSyncMeta()
    };
}

function syncStateToFirestore(sourceState = state, options = { merge: true }) {
    if (!currentUser || currentUser.isDemo) return Promise.resolve();
    return db.collection("appData").doc("masterState").set(getFirestoreStatePayload(sourceState), options);
}

function getFirestoreFieldPath(...segments) {
    if (typeof firebase !== 'undefined' && firebase.firestore?.FieldPath) {
        return new firebase.firestore.FieldPath(...segments);
    }
    return segments.join('.');
}

function getFirestoreDeleteFieldValue() {
    if (typeof firebase !== 'undefined' && firebase.firestore?.FieldValue?.delete) {
        return firebase.firestore.FieldValue.delete();
    }
    return null;
}

function persistAttendanceFarmToFirestore(selectedDate, selectedFarm, sourceState = state) {
    const safeDate = isValidISODateKey(selectedDate) ? selectedDate : '';
    const safeFarm = cleanText(selectedFarm);
    if (!safeDate || !safeFarm || !isHydrated || !currentUser || currentUser.isDemo) {
        return Promise.resolve();
    }

    const safeState = sanitizeStateForPersistence(sourceState);
    const dayEntries = safeState.attendance?.[safeDate] || {};
    const farmEntries = dayEntries[safeFarm] || {};
    const ref = db.collection("appData").doc("masterState");
    const farmPath = getFirestoreFieldPath('attendance', safeDate, safeFarm);
    const syncMeta = safeState.syncMeta || sanitizeSyncMeta();
    const hasFarmAttendance = Object.keys(farmEntries).length > 0;

    if (hasFarmAttendance) {
        return ref.update(farmPath, farmEntries, 'syncMeta', syncMeta)
            .catch(e => {
                console.error('Attendance date/farm sync failed; retrying full state sync:', e);
                return syncStateToFirestore(safeState, { merge: false });
            });
    }

    const deleteField = getFirestoreDeleteFieldValue();
    if (!deleteField) {
        return syncStateToFirestore(safeState, { merge: false });
    }

    const hasOtherFarmAttendance = Object.keys(dayEntries).length > 0;
    const deletePath = hasOtherFarmAttendance
        ? farmPath
        : getFirestoreFieldPath('attendance', safeDate);

    return ref.update(deletePath, deleteField, 'syncMeta', syncMeta)
        .catch(e => {
            console.error('Attendance deletion sync failed; retrying full state sync:', e);
            return syncStateToFirestore(safeState, { merge: false });
        });
}

function isValidGoogleSheetsWebhookUrl(url) {
    const text = cleanText(url);
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(text);
}

function sanitizeGoogleSheetsConfig(rawConfig, legacyConfig = {}) {
    const fallback = legacyConfig && typeof legacyConfig === 'object' ? legacyConfig : {};
    const rawWebhookUrl = cleanText(
        rawConfig?.webhookUrl ??
        rawConfig?.url ??
        fallback.webhookUrl ??
        DEFAULT_GOOGLE_SHEETS_CONFIG.webhookUrl
    );
    const rawLastSyncAt = Number(
        rawConfig?.lastSyncAt ??
        rawConfig?.lastUploadedAt ??
        fallback.lastSyncAt ??
        DEFAULT_GOOGLE_SHEETS_CONFIG.lastSyncAt
    );
    const rawUpdatedAt = Number(
        rawConfig?.updatedAt ??
        fallback.updatedAt ??
        rawLastSyncAt ??
        DEFAULT_GOOGLE_SHEETS_CONFIG.updatedAt
    );
    return {
        webhookUrl: isValidGoogleSheetsWebhookUrl(rawWebhookUrl) ? rawWebhookUrl : '',
        lastSyncAt: Number.isFinite(rawLastSyncAt) && rawLastSyncAt > 0 ? rawLastSyncAt : 0,
        updatedAt: Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0 ? rawUpdatedAt : 0
    };
}

function sanitizeSyncMeta(rawMeta) {
    const updatedAt = Number(rawMeta?.updatedAt ?? 0);
    return {
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
        updatedBy: cleanText(rawMeta?.updatedBy),
        appVersion: cleanText(rawMeta?.appVersion) || APP_VERSION
    };
}

function getStateUpdatedAt(rawState) {
    const updatedAt = Number(rawState?.syncMeta?.updatedAt ?? 0);
    return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
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
    } catch (_error) {
        console.warn('Unable to update stored Google Sheets webhook URL.', _error);
    }
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
    } catch (_error) {
        console.warn('Unable to update stored Google Sheets sync timestamp.', _error);
    }
}

function clearStoredGoogleSheetsLastSyncAt() {
    try {
        localStorage.removeItem(GOOGLE_SHEETS_LAST_SYNC_STORAGE_KEY);
    } catch (_error) {
        console.warn('Unable to clear stored Google Sheets sync timestamp.', _error);
    }
}

function getLegacyGoogleSheetsConfig() {
    return sanitizeGoogleSheetsConfig({
        webhookUrl: getStoredGoogleSheetsWebhookUrl(),
        lastSyncAt: getStoredGoogleSheetsLastSyncAt()
    });
}

function getGoogleSheetsConfig() {
    return sanitizeGoogleSheetsConfig(state.googleSheetsConfig, getLegacyGoogleSheetsConfig());
}

function syncLegacyGoogleSheetsStorage(rawConfig = state.googleSheetsConfig) {
    const safeConfig = sanitizeGoogleSheetsConfig(rawConfig);
    if (safeConfig.webhookUrl) setStoredGoogleSheetsWebhookUrl(safeConfig.webhookUrl);
    else setStoredGoogleSheetsWebhookUrl('');
    if (safeConfig.lastSyncAt > 0) setStoredGoogleSheetsLastSyncAt(safeConfig.lastSyncAt);
    else clearStoredGoogleSheetsLastSyncAt();
    return safeConfig;
}

function updateGoogleSheetsSyncStatus() {
    const statusEl = document.getElementById('google-sheets-sync-status');
    if (!statusEl) return;
    const { webhookUrl, lastSyncAt } = syncLegacyGoogleSheetsStorage(getGoogleSheetsConfig());
    if (!webhookUrl) {
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
let firestoreSyncTimer; // FIX 7: Module-level variable for debouncing Firestore writes
function saveState() {
    state.googleSheetsConfig = syncLegacyGoogleSheetsStorage(getGoogleSheetsConfig());
    state.syncMeta = {
        ...sanitizeSyncMeta(state.syncMeta),
        updatedAt: Date.now(),
        updatedBy: cleanText(currentUser?.username || state.syncMeta?.updatedBy),
        appVersion: APP_VERSION
    };
    state = sanitizeStateForPersistence(state);
    // Run data integrity check here instead of in the broken wrapper.
    if (!validateDataIntegrity()) {
        console.warn('saveState: Data integrity issue detected; saving anyway but check logs.');
    }
    if (currentUser) setSession(currentUser);
    const key = currentUser?.isDemo ? 'farmWorkerState_demo' : 'farmWorkerState';
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {
        console.warn('Local state save failed.', e);
    }

    if (!hasCompletedInitialCloudSync && currentUser && !currentUser.isDemo) {
        hasPendingLocalChanges = true;
    }

    // SAFETY: Never write to Firestore if we haven't even loaded the data yet OR if in demo mode
    if (!isHydrated || (currentUser && currentUser.isDemo)) return;

    // SAFETY: Never write an empty state to Firestore; this prevents race conditions where
    // the blank initial state overwrites real cloud data before it has loaded.
    const hasNoData = (!state.farms || state.farms.length === 0) && (!state.workers || state.workers.length === 0);
    if (hasNoData) {
        console.warn('saveState: Blocked Firestore write; state appears uninitialized (no farms or workers).');
        return;
    }

    if (currentUser && !currentUser.isDemo) {
        clearTimeout(firestoreSyncTimer); // FIX 7: Clear previously queued syncs to prevent API hammering
        firestoreSyncTimer = setTimeout(() => { // FIX 7: Debounce Firestore writes
            syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
        }, FIRESTORE_SYNC_DEBOUNCE_MS);
    }
}

let _loadingHideTimer = null;
function showLoading(show) {
    const el = document.getElementById('splash-screen');
    if (!el) return;
    if (show) {
        clearTimeout(_loadingHideTimer);
        el.style.display = 'flex';
        el.classList.remove('fade-out');
    } else {
        if (el.classList.contains('fade-out')) return; // Already hiding
        el.classList.add('fade-out');
        _loadingHideTimer = setTimeout(() => {
            el.style.display = 'none';
        }, SPLASH_FADE_DURATION_MS);
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
            // FIX 1: Removed the erroneous `if (currentUser?.isDemo) renderAll()` call here.
            // Demo mode's renderAll() is correctly called once in the early-return block below,
            // preventing a double-render that caused state flicker and wasted cycles.
        } catch (e) {
            console.warn('Saved local state could not be parsed; continuing with defaults.', e);
        }
    }
    syncLegacyGoogleSheetsStorage(getGoogleSheetsConfig());

    let pendingInitialSnapshot = null;
    let hasServerInitialFetchSettled = false;
    const isNavigatorOnline = () => typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const persistHydratedState = nextState => {
        state = sanitizeStateForPersistence(nextState);
        state.googleSheetsConfig = syncLegacyGoogleSheetsStorage(getGoogleSheetsConfig());
        try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {
            console.warn('Hydrated state could not be saved locally.', e);
        }
    };
    const analyzeInitialSources = cloudData => {
        const safeLocal = sanitizeStateForPersistence(state);
        const safeCloud = sanitizeStateForPersistence({ ...safeLocal, ...(cloudData || {}) });
        const localHasData = (safeLocal.workers?.length > 0 || safeLocal.farms?.length > 0);
        const cloudHasData = (safeCloud.workers?.length > 0 || safeCloud.farms?.length > 0);
        const localUpdatedAt = getStateUpdatedAt(safeLocal);
        const cloudUpdatedAt = getStateUpdatedAt(safeCloud);
        return {
            safeLocal,
            safeCloud,
            localHasData,
            cloudHasData,
            preferLocal: localHasData && localUpdatedAt > cloudUpdatedAt
        };
    };
    const finalizeHydration = (nextState, options = {}) => {
        const { usingLocalFallback = false, syncBackToCloud = false, force = false } = options;
        if (isHydrated && !force) return; // Guard against stale hydration unless forced by server data.

        persistHydratedState(nextState);
        isHydrated = true;
        isUsingLocalFallback = usingLocalFallback;
        showLoading(false);

        // Auto-repair: remove cross-farm duplicate attendance from historical data.
        // If any are found, immediately sync the cleaned state to Firestore.
        const crossFarmFixed = fixCrossFarmDuplicates();
        if (crossFarmFixed > 0 && currentUser && !currentUser.isDemo) {
            console.warn('Cross-farm duplicates fixed on load. Syncing clean data to Firestore...');
            syncStateToFirestore(state, { merge: false }).catch(e => console.error('Sync after cross-farm fix failed:', e));
        }
        renderAll();

        if (syncBackToCloud && currentUser && !currentUser.isDemo) {
            hasPendingLocalChanges = false;
            syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
        }
    };

    // Safety timeout: if Firestore is slow, rely on the local hydration we already did.
    const loadTimeout = setTimeout(() => {
        showLoading(false);
        if (!hasCompletedInitialCloudSync) {
            if (pendingInitialSnapshot?.exists) {
                const { safeLocal, safeCloud, localHasData, cloudHasData } = analyzeInitialSources(pendingInitialSnapshot.data());
                const fallbackState = (!localHasData && cloudHasData) || getStateUpdatedAt(safeCloud) > getStateUpdatedAt(safeLocal)
                    ? safeCloud
                    : safeLocal;
                console.warn("Load timeout: using cached state until Firestore confirms the latest data.");
                finalizeHydration(fallbackState, { usingLocalFallback: true });
                return;
            }
            if (hasLocalCache) {
                console.warn("Load timeout: using local cache until cloud sync responds.");
                finalizeHydration(state, { usingLocalFallback: true });
                return;
            }
            if (!isHydrated) {
                console.warn("Load timeout: showing local data only.");
                finalizeHydration(state, { usingLocalFallback: true });
            }
            return;
        }
    }, LOAD_TIMEOUT_MS); // Hard refresh re-downloads all JS from network; needs more time

    if (currentUser?.isDemo) {
        clearTimeout(loadTimeout);
        hasCompletedInitialCloudSync = true;
        isHydrated = true;
        isUsingLocalFallback = false;
        showLoading(false);
        renderAll();
        return;
    }

    // --- INSTANT HYDRATION ---
    // If we have local data, show it immediately so the app feels instant
    if (hasLocalCache) {

        finalizeHydration(state, { usingLocalFallback: true });
    }

    // Initial hydration prefers the explicit server fetch. onSnapshot still handles
    // live updates and offline fallback after the server request settles.
    db.collection("appData").doc("masterState").get({ source: 'server' }).then(doc => {
        hasServerInitialFetchSettled = true;
        clearTimeout(loadTimeout);
        hasCompletedInitialCloudSync = true;
        if (doc.exists) {
            const cloudData = doc.data();
            const { safeLocal, safeCloud, localHasData, cloudHasData, preferLocal } = analyzeInitialSources(cloudData);
            if (isUsingLocalFallback && hasPendingLocalChanges && localHasData) {
                state = mergeCloudStateWithLocalEdits(cloudData, state);
                finalizeHydration(state, { usingLocalFallback: false, syncBackToCloud: true, force: true });
            } else if (preferLocal) {
                finalizeHydration(state, { usingLocalFallback: false, syncBackToCloud: true, force: true });
            } else if (cloudHasData || !localHasData) {
                finalizeHydration(safeCloud, { usingLocalFallback: false, force: true });
            } else {
                finalizeHydration(safeLocal, { usingLocalFallback: false, force: true });
            }
        } else {
            finalizeHydration(state, { usingLocalFallback: false, force: true });
            if (hasPendingLocalChanges) {
                hasPendingLocalChanges = false;
                syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
            }
        }
    }).catch(e => {
        hasServerInitialFetchSettled = true;
        // Server fetch failed (offline) - onSnapshot or the timeout will handle it
        console.warn('Server fetch failed, falling back to onSnapshot/cache:', e.message);
    });

    cloudStateUnsubscribe = db.collection("appData").doc("masterState").onSnapshot({ includeMetadataChanges: true }, doc => {
        if (!hasCompletedInitialCloudSync && !hasServerInitialFetchSettled) {
            if (!doc.metadata.hasPendingWrites) pendingInitialSnapshot = doc;
            return;
        }

        clearTimeout(loadTimeout);

        if (!hasCompletedInitialCloudSync) {
            hasCompletedInitialCloudSync = true;
            // Initial load only.
            if (doc.exists) {
                const cloudData = doc.data();
                const { safeLocal, safeCloud, localHasData, cloudHasData, preferLocal } = analyzeInitialSources(cloudData);
                if (isUsingLocalFallback && hasPendingLocalChanges && localHasData) {
                    state = mergeCloudStateWithLocalEdits(cloudData, state);
                    finalizeHydration(state, { usingLocalFallback: false, syncBackToCloud: true, force: true });
                    return;
                }
                if (preferLocal) {
                    console.warn('loadState: Local data is newer than cloud snapshot. Restoring local state to Firestore.');
                    finalizeHydration(state, { usingLocalFallback: false, syncBackToCloud: true, force: true });
                    return;
                }
                if (cloudHasData || !localHasData) {
                    finalizeHydration(safeCloud, { usingLocalFallback: false, force: true });
                    return;
                }
                console.warn('loadState: Cloud data is empty but local cache has data. Auto-restoring to cloud...');
                finalizeHydration(safeLocal, { usingLocalFallback: false, force: true });
                syncStateToFirestore(state, { merge: true }).then(() => showToast(t('recovery.localCacheRestored')))
                    .catch(e => console.error('Auto-restore failed:', e));
                return;
            } else {
                finalizeHydration(state, { usingLocalFallback: false, force: true });
                if (hasPendingLocalChanges) {
                    hasPendingLocalChanges = false;
                    syncStateToFirestore(state, { merge: true }).catch(e => console.error("Sync Error", e));
                }
                return;
            }
            return; // Do not fall through to the live-update block.
        }

        // Live updates after initial load.
        // Skip snapshots caused by our OWN pending writes.
        // hasPendingWrites = true means Firestore applied the write locally
        // but has not confirmed it with the server yet; our local state is
        // already correct, so overwriting it here is what caused the revert.
        if (doc.metadata.hasPendingWrites) return;
        if (doc.metadata.fromCache && isNavigatorOnline()) return;

        // This is a server-confirmed update (or a change from another tab/user).
        if (doc.exists) {
            const cloudData = doc.data();
            persistHydratedState({ ...state, ...cloudData });
            renderAll();
            return;
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
let workerStatsCache = new Map();

function renderAll() {
    state = sanitizeStateForPersistence(state);

    // Debounce renderAll to prevent performance collapse during rapid state changes
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        workerStatsCache.clear();
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
        if (typeof window.repairMojibakeText === 'function') {
            window.repairMojibakeText(document.getElementById('main-container') || document.body);
        }
    }, RENDER_DEBOUNCE_MS); // Problem 5 fix: was 200, reduced to 50ms
}

// --- Auth & Navigation ---
// Async helper that hashes a plaintext string with SHA-256 and returns a hex string.
async function hashPassword(str) {
    const msgBuffer = new TextEncoder().encode(str); // FIX 1: Encode the string as UTF-8 bytes
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); // FIX 1: SHA-256 hash
    const hashArray = Array.from(new Uint8Array(hashBuffer)); // FIX 1: Convert buffer to byte array
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // FIX 1: Convert to hex string
}

function isSha256Hash(value) {
    return /^[a-f0-9]{64}$/i.test(cleanText(value));
}

function sanitizeUserForSession(user) {
    const safeUser = { ...(user || {}) };
    delete safeUser.password;
    delete safeUser.passwordHash;
    return safeUser;
}

async function verifyUserPassword(userData, plaintextPassword) {
    const passwordHash = await hashPassword(plaintextPassword);
    const storedHash = cleanText(userData?.passwordHash);
    if (isSha256Hash(storedHash)) {
        return { ok: storedHash.toLowerCase() === passwordHash, passwordHash, shouldUpgrade: false };
    }

    const legacyPassword = cleanText(userData?.password);
    if (isSha256Hash(legacyPassword)) {
        return { ok: legacyPassword.toLowerCase() === passwordHash, passwordHash, shouldUpgrade: true };
    }

    return {
        ok: legacyPassword === plaintextPassword,
        passwordHash,
        shouldUpgrade: legacyPassword === plaintextPassword
    };
}

function initializeLoginPasswordToggle() {
    const passwordInput = document.getElementById('login-pass');
    const toggleButton = passwordInput?.parentElement?.querySelector('button[type="button"]');
    if (!passwordInput || !toggleButton || toggleButton.dataset.passwordToggleBound === 'true') return;

    toggleButton.removeAttribute('onclick');
    toggleButton.dataset.passwordToggleBound = 'true';
    toggleButton.textContent = passwordInput.type === 'password' ? 'Show' : 'Hide';
    toggleButton.style.fontSize = '0.8rem';
    toggleButton.style.fontWeight = '700';
    toggleButton.style.color = '#64748B';
    toggleButton.addEventListener('click', () => {
        const showingPassword = passwordInput.type === 'password';
        passwordInput.type = showingPassword ? 'text' : 'password';
        toggleButton.textContent = showingPassword ? 'Hide' : 'Show';
    });
}

function sanitizeStaticUiText() {
    const signInLabel = document.querySelector('#login-screen [data-i18n="login.signIn"]');
    if (signInLabel) signInLabel.textContent = t('login.signIn') || 'Sign In';

    const signInIcon = signInLabel?.nextElementSibling;
    if (signInIcon) {
        signInIcon.textContent = '->';
        signInIcon.setAttribute('aria-hidden', 'true');
    }

    const loginError = document.getElementById('login-error');
    if (loginError && loginError.style.display !== 'block') {
        loginError.textContent = t('login.invalid') || 'Incorrect username or password.';
    }

    const logoutIcon = document.querySelector('#nav-logout .logout-icon-text');
    if (logoutIcon) logoutIcon.remove();

    const profileLanguage = document.getElementById('profile-language');
    if (profileLanguage instanceof HTMLSelectElement) {
        Array.from(profileLanguage.options).forEach(option => {
            if (option.value === 'kn') option.textContent = 'Kannada';
            if (option.value === 'hi') option.textContent = 'Hindi';
        });
    }

    const dashboardPending = document.getElementById('dashboard-pending-payouts');
    if (dashboardPending && /[\u00C3\u00C2\u00E2\u00E0\u00F0]/.test(dashboardPending.textContent || '')) {
        dashboardPending.textContent = '\u20B90';
    }

    ['current-paid-display', 'current-loan-display'].forEach(id => {
        const el = document.getElementById(id);
        if (el && /[\u00C3\u00C2\u00E2\u00E0\u00F0]/.test(el.textContent || '')) {
            el.textContent = '\u20B90';
        }
    });

    ['#workers-search-input', '#payments-search-input'].forEach(selector => {
        const input = document.querySelector(selector);
        const icon = input?.previousElementSibling;
        if (icon) icon.textContent = '\u{1F50D}';
    });

    ['workers-no-results', 'payments-no-results'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;

        const label = el.querySelector('[data-i18n]');
        if (label) {
            el.textContent = '';
            el.append('\u{1F50D} ', label);
        }
    });

    const bankDetailsIcon = document.querySelector('#worker-modal h3 span[aria-hidden="true"]');
    if (bankDetailsIcon) bankDetailsIcon.remove();
}

function normalizeEnglishUiCopies() {
    if (!window.I18N?.en) return;

    Object.assign(window.I18N.en, {
        'login.signIn': 'Sign In',
        'nav.adminPanel': 'Admin Panel',
        'dashboard.clearAllPayments': 'Clear All Payments (Admin Only)',
        'workerModal.dailyWage': 'Daily Wage (Rs.)',
        'workerModal.overtimeCharge': 'Overtime Charge (Rs.)',
        'workerModal.bankDetails': 'Bank Details (for Money Transfer)',
        'paymentModal.payAmount': '+ Pay Amount (Rs.)',
        'paymentModal.giveLoan': '+ Give Loan (Rs.)',
        'paymentModal.fullySettled': 'Mark as Fully Settled (Reset Balance)',
        'breakdown.viewDates': 'View Specific Dates',
        'breakdown.exportLog': 'Export Log',
        'breakdown.amount': 'Amount (Rs.)',
        'admin.title': 'Admin Panel'
    });
}

window.doLogin = async function () {
    const user = document.getElementById('login-user').value.trim().toLowerCase();
    const pass = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');

    if (!user || !pass) {
        errEl.innerText = t('login.invalid') || 'Please enter both username and password.';
        errEl.style.display = 'block';
        return;
    }

    try {
        const snap = await db.collection('users').doc(user).get();
        const d = snap.exists ? snap.data() : null;
        const passwordCheck = d ? await verifyUserPassword(d, pass) : { ok: false };
        if (snap.exists && passwordCheck.ok) {

            // Check guest expiration
            if (d.accessExpiry && Date.now() > d.accessExpiry) {
                errEl.innerText = t('login.accessExpired') || 'Temporary access has expired.';
                errEl.style.display = 'block';
                return;
            }

            if (passwordCheck.shouldUpgrade) {
                const payload = { passwordHash: passwordCheck.passwordHash };
                const deleteField = getFirestoreDeleteFieldValue();
                if (deleteField) payload.password = deleteField;
                db.collection('users').doc(user).update(payload)
                    .catch(e => console.warn('Password hash upgrade failed:', e));
            }

            currentUser = sanitizeUserForSession({ ...d, username: user });
            setSession(currentUser);

            const allowedT = getAllowedThemes(currentUser);
            let activeTheme = currentUser.theme || localStorage.getItem('appTheme') || 'light';
            if (!allowedT.includes(activeTheme)) activeTheme = allowedT[0] || 'light';
            applyTheme(activeTheme);

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
        console.warn("Login failed:", e);
        const errorCode = e?.code || '';
        const errorMessage = String(e?.message || '');
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

        if (errorCode === 'resource-exhausted') {
            errEl.innerText = t('login.serverQuotaExceeded');
        } else if (isOffline) {
            errEl.innerText = t('login.noInternet');
        } else if (errorCode === 'permission-denied') {
            errEl.innerText = 'Cloud database access is blocked. Check Firestore rules and deployment settings.';
        } else if (errorCode === 'unavailable' || /cloud sync unavailable|firebase/i.test(errorMessage)) {
            errEl.innerText = 'Cloud login is temporarily unavailable. Refresh and try again.';
        } else {
            errEl.innerText = 'Login failed. Please refresh and try again.';
        }

        errEl.style.display = 'block';
    }
};

window.doLogout = function () {
    clearRuntimeTimers();
    currentUser = null;
    clearSession();
    window.location.reload();
};

function clearRuntimeTimers() {
    clearTimeout(firestoreSyncTimer);
    clearTimeout(renderTimer);
    clearTimeout(_loadingHideTimer);
    if (autoBackupInterval) {
        clearInterval(autoBackupInterval);
        autoBackupInterval = null;
    }
    if (corruptionCheckInterval) {
        clearInterval(corruptionCheckInterval);
        corruptionCheckInterval = null;
    }
    pendingUserDeletes.forEach(entry => {
        clearTimeout(entry.timeoutId);
        clearInterval(entry.intervalId);
    });
    pendingUserDeletes.clear();
}

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

    syncAdminShortcuts();

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

function updateBodyScrollState() {
    const shouldLockBody =
        document.body.classList.contains('mobile-nav-open') ||
        !!document.querySelector('.modal-overlay.active');
    document.body.classList.toggle('ui-lock-scroll', shouldLockBody);
}

window.closeMobileSidebar = function () {
    document.body.classList.remove('mobile-nav-open');
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
    }
    updateBodyScrollState();
};

window.toggleMobileSidebar = function () {
    const willOpen = !document.body.classList.contains('mobile-nav-open');
    document.body.classList.toggle('mobile-nav-open', willOpen);
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('active', willOpen);
    updateBodyScrollState();
};

function applyTheme(theme) {
    const nextTheme = DEFAULT_THEME_MODES.includes(theme) ? theme : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    try { localStorage.setItem('appTheme', nextTheme); } catch (_error) {
        console.warn('Unable to persist selected theme.', _error);
    }
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tb') === nextTheme);
    });
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
        const colors = { light: '#F8FAFC', dark: '#0F172A', vibrant: '#8B5CF6', comfort: '#FDF5E6' };
        themeColor.setAttribute('content', colors[nextTheme] || colors.dark);
    }
    const themeSel = document.getElementById('profile-theme');
    if (themeSel && themeSel.value !== nextTheme) themeSel.value = nextTheme;
}

window.setTheme = function (theme) {
    const allowedT = getAllowedThemes(currentUser);
    const themeToApply = allowedT.includes(theme) ? theme : (allowedT[0] || 'light');
    applyTheme(themeToApply);
};

// --- Weather Feature ---
let lastWeatherFetch = 0;
let isFetchingWeather = false;
const WEATHER_CACHE_MS = 2 * 60 * 1000;

window.refreshWeatherWidget = function () {
    console.log('[Weather] Manual refresh button clicked');
    fetchWeather({ force: true, reason: 'manual-refresh' });
};

async function fetchWeather(options = {}) {
    const { force = false, reason = 'dashboard-render' } = options;
    const config = state.weatherConfig;
    console.log('[Weather] fetchWeather called', {
        reason,
        force,
        isFetchingWeather,
        lastWeatherFetch,
        weatherConfig: config
    });

    if (!config?.lat || !config?.lon) {
        console.error('[Weather] Missing weather coordinates', config);
        lastWeatherFetch = 0;
        renderWeatherOffline(config?.locationName || 'Location not configured', 'Location not configured');
        return;
    }

    if (isFetchingWeather) {
        console.log('[Weather] Fetch skipped because a request is already in progress');
        return;
    }

    const now = Date.now();
    const cacheAge = now - lastWeatherFetch;
    if (!force && lastWeatherFetch && cacheAge < WEATHER_CACHE_MS) {
        console.log('[Weather] Fetch skipped because cached weather is still fresh', {
            cacheAge,
            cacheMs: WEATHER_CACHE_MS
        });
        return;
    }

    const { lat, lon, locationName } = config;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&windspeed_unit=kmh`;

    isFetchingWeather = true;
    console.log('[Weather] Fetching weather from Open-Meteo', { url, lat, lon, locationName });

    try {
        const res = await fetch(url, { cache: 'no-store' });
        console.log('[Weather] API response received', {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText
        });

        if (!res.ok) {
            throw new Error(`Weather API HTTP ${res.status} ${res.statusText}`.trim());
        }

        const data = await res.json();
        console.log('[Weather] Parsed weather payload', data);

        const normalizedCurrent = data?.current_weather || (data?.current ? {
            temperature: data.current.temperature_2m,
            weathercode: data.current.weather_code,
            windspeed: data.current.wind_speed_10m,
            time: data.current.time
        } : null);

        if (!normalizedCurrent) {
            throw new Error('Weather response did not include current weather data');
        }

        lastWeatherFetch = Date.now();
        renderWeatherUI(normalizedCurrent, locationName);
        console.log('[Weather] Weather UI rendered successfully', {
            locationName,
            temperature: normalizedCurrent.temperature,
            weathercode: normalizedCurrent.weathercode,
            windspeed: normalizedCurrent.windspeed
        });
    } catch (error) {
        console.error('[Weather] Weather fetch failed', error);
        lastWeatherFetch = 0;
        renderWeatherOffline(locationName, error?.message || 'Weather failed to load');
    } finally {
        isFetchingWeather = false;
        console.log('[Weather] Fetch cycle finished', {
            isFetchingWeather,
            lastWeatherFetch
        });
    }
}

function getWeatherIconInfo(code) {
    const hour = new Date().getHours();
    const isNight = hour >= 18 || hour < 6;
    if (code === 0) return { i: isNight ? '\u{1F319}' : '\u2600\uFE0F', c: isNight ? 'icon-moon' : 'icon-sun', d: 'weather.clear' };
    if (code <= 3) return { i: isNight ? '\u2601\uFE0F' : '\u26C5', c: 'icon-cloud', d: 'weather.cloudy' };
    if (code >= 51 && code <= 67) return { i: '\u{1F327}\uFE0F', c: 'icon-rain', d: 'weather.rain' };
    if (code >= 80 && code <= 82) return { i: '\u{1F326}\uFE0F', c: 'icon-rain', d: 'weather.showers' };
    if (code >= 95) return { i: '\u26C8\uFE0F', c: 'icon-storm', d: 'weather.storm' };
    return { i: '\u2601\uFE0F', c: 'icon-cloud', d: 'weather.cloudy' };
}

function renderWeatherUI(curr, name) {
    console.log('[Weather] renderWeatherUI called', { current: curr, locationName: name });

    const legacyContainer = document.getElementById('dashboard-weather-container');
    if (!legacyContainer) {
        console.error('[Weather] dashboard-weather-container not found in DOM');
        return;
    }

    const weatherInfo = getWeatherIconInfo(curr.weathercode);
    const currentTime = curr?.time
        ? new Date(curr.time).toLocaleTimeString(window.getCurrentLocale?.() || undefined, { hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleTimeString(window.getCurrentLocale?.() || undefined, { hour: '2-digit', minute: '2-digit' });
    const temperature = Number.isFinite(Number(curr?.temperature)) ? Math.round(Number(curr.temperature)) : '--';
    const windspeed = Number.isFinite(Number(curr?.windspeed)) ? `${Math.round(Number(curr.windspeed))} km/h` : t('common.notAvailable');

    legacyContainer.innerHTML = `
        <div class="weather-card stagger-anim">
            <div class="weather-info-main">
                <div class="weather-icon-container ${weatherInfo.c}">${weatherInfo.i}</div>
                <div class="weather-temp">${temperature}&deg;C</div>
                <div class="weather-meta">
                    <div class="weather-city">${escapeHtml(name)}</div>
                    <div class="weather-desc">${t(weatherInfo.d)}</div>
                </div>
            </div>
            <div class="weather-details-grid">
                <div class="weather-detail-item"><div class="weather-detail-label">${t('common.wind')}</div><div class="weather-detail-val">${windspeed}</div></div>
                <div class="weather-detail-item"><div class="weather-detail-label">${t('common.timeLabel')}</div><div class="weather-detail-val">${currentTime}</div></div>
                <div class="weather-detail-item">
                    <button
                        type="button"
                        class="btn"
                        onclick="window.refreshWeatherWidget()"
                        style="background: rgba(255,255,255,0.16); color: #fff; border: 1px solid rgba(255,255,255,0.32); min-width: 120px;"
                    >${escapeHtml(t('weather.refresh'))}</button>
                </div>
            </div>
        </div>
    `;
    legacyContainer.style.display = 'block';
    console.log('[Weather] Weather markup inserted', {
        exists: !!legacyContainer,
        display: legacyContainer.style.display,
        htmlLength: legacyContainer.innerHTML.length
    });

}
function renderWeatherOffline(name, message) {
    console.warn('[Weather] renderWeatherOffline called', { locationName: name, message });
    const legacyContainer = document.getElementById('dashboard-weather-container');
    if (!legacyContainer) {
        console.error('[Weather] Cannot render offline state because dashboard-weather-container is missing');
        return;
    }

    legacyContainer.innerHTML = `
        <div class="weather-card">
            <div class="weather-info-main">
                <div class="weather-icon-container icon-cloud">☁️</div>
                <div class="weather-meta">
                    <div class="weather-city">${escapeHtml(name)}</div>
                    <div class="weather-desc">${escapeHtml(t('weather.failedToLoad'))}</div>
                    <div class="weather-desc">${escapeHtml(message || t('weather.offline'))}</div>
                </div>
            </div>
            <div class="weather-details-grid">
                <div class="weather-detail-item"><div class="weather-detail-label">${t('common.timeLabel')}</div><div class="weather-detail-val">${new Date().toLocaleTimeString(window.getCurrentLocale?.() || undefined, { hour: '2-digit', minute: '2-digit' })}</div></div>
                <div class="weather-detail-item">
                    <button
                        type="button"
                        class="btn"
                        onclick="window.refreshWeatherWidget()"
                        style="background: rgba(255,255,255,0.16); color: #fff; border: 1px solid rgba(255,255,255,0.32); min-width: 120px;"
                    >${escapeHtml(t('weather.refresh'))}</button>
                </div>
            </div>
        </div>
    `;
    legacyContainer.style.display = 'block';
    console.log('[Weather] Offline weather markup inserted', {
        exists: !!legacyContainer,
        display: legacyContainer.style.display,
        htmlLength: legacyContainer.innerHTML.length
    });

}

window.saveWeatherConfig = function () {
    const lat = parseFloat(document.getElementById('admin-weather-lat').value);
    const lon = parseFloat(document.getElementById('admin-weather-lon').value);
    const name = document.getElementById('admin-weather-location-name').value.trim();
    if (isNaN(lat) || isNaN(lon) || !name) return showToast(t('weather.fillAllFields', true));
    state.weatherConfig = { lat, lon, locationName: name };
    saveState();
    lastWeatherFetch = 0;
    isFetchingWeather = false;
    fetchWeather();
    showToast(t('weather.updated'));
};

// --- Admin Panel ---
window.openAdminPanel = function () {
    if (!currentUser?.isAdmin) return;
    window.closeMobileSidebar();
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

function getPendingUserDeleteSecondsRemaining(username) {
    const entry = pendingUserDeletes.get(username);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
}

function updateUserDeleteToastStackState() {
    const stack = document.getElementById('user-delete-toast-stack');
    if (stack) stack.classList.toggle('active', stack.childElementCount > 0);
}

function findUserDeleteToast(username) {
    const stack = document.getElementById('user-delete-toast-stack');
    if (!stack) return { stack: null, toast: null };
    const toast = Array.from(stack.children).find(node => node.dataset.username === username) || null;
    return { stack, toast };
}

function removeUserDeleteToast(username) {
    const { stack, toast } = findUserDeleteToast(username);
    if (toast) toast.remove();
    if (stack) updateUserDeleteToastStackState();
}

function renderUserDeleteToast(username) {
    const { stack, toast: existingToast } = findUserDeleteToast(username);
    if (!stack) return;

    const seconds = getPendingUserDeleteSecondsRemaining(username);
    if (seconds <= 0) {
        removeUserDeleteToast(username);
        return;
    }

    const toast = existingToast || document.createElement('div');
    toast.className = 'undo-toast';
    toast.dataset.username = username;

    const copy = document.createElement('div');
    copy.className = 'undo-toast-copy';

    const title = document.createElement('div');
    title.className = 'undo-toast-title';
    title.textContent = t('admin.deletedToast', { username });

    const note = document.createElement('div');
    note.className = 'undo-toast-note';
    note.textContent = t('admin.undoAvailable', { seconds });

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'undo-toast-btn';
    undoBtn.textContent = t('common.undo');
    undoBtn.addEventListener('click', () => window.undoPendingUserDelete(username));

    copy.append(title, note);
    toast.replaceChildren(copy, undoBtn);

    if (!existingToast) stack.appendChild(toast);
    updateUserDeleteToastStackState();
}

function clearPendingUserDelete(username, options = {}) {
    const entry = pendingUserDeletes.get(username);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    clearInterval(entry.intervalId);
    pendingUserDeletes.delete(username);
    removeUserDeleteToast(username);
    if (options.refreshList !== false) window.refreshUserList();
}

async function finalizePendingUserDelete(username) {
    const entry = pendingUserDeletes.get(username);
    if (!entry) return;

    clearTimeout(entry.timeoutId);
    clearInterval(entry.intervalId);
    pendingUserDeletes.delete(username);
    removeUserDeleteToast(username);

    try {
        await db.collection('users').doc(username).delete();
        window.refreshUserList();
        showToast(t('admin.deletedToast', { username }));
    } catch (_error) {
        window.refreshUserList();
        showToast(t('admin.deleteUserError'), true);
    }
}

window.undoPendingUserDelete = function (username) {
    const safeUsername = cleanText(username).toLowerCase();
    if (!pendingUserDeletes.has(safeUsername)) return;
    clearPendingUserDelete(safeUsername);
    showToast(t('common.undo'));
};

window.refreshUserList = async function () {
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    try {
        const snap = await db.collection('users').get();
        // Fix 6: Collect all HTML first, then set innerHTML once (avoids innerHTML += loop corruption)
        const rows = [];
        snap.forEach(doc => {
            const u = doc.data();
            const username = cleanText(u.username || doc.id).toLowerCase();
            const isPendingDelete = pendingUserDeletes.has(username);
            const pendingNote = isPendingDelete
                ? `<div style="color:var(--text-muted); font-size:0.75rem; margin-top:4px;">${escapeHtml(t('admin.undoAvailable', { seconds: getPendingUserDeleteSecondsRemaining(username) }))}</div>`
                : '';
            // FIX 4: Use data-username attribute instead of inline onclick with JSON.stringify to prevent XSS
            const editButton = `
                <button
                    class="btn btn-secondary user-edit-btn"
                    data-username="${escapeHtml(username)}"
                    style="padding:4px 10px; font-size:0.75rem;${isPendingDelete ? ' opacity:0.6; cursor:not-allowed;' : ''}"
                    ${isPendingDelete ? 'disabled' : ''}
                >${escapeHtml(t('common.edit'))}</button>
            `; // FIX 4
            // FIX 4: Use data-username attribute instead of inline onclick with JSON.stringify to prevent XSS
            const deleteButton = isPendingDelete
                ? `<button class="btn user-undo-btn" data-username="${escapeHtml(username)}" style="padding:4px 10px; font-size:0.75rem; border:1px solid var(--primary); color:var(--primary); background:transparent;">${escapeHtml(t('common.undo'))}</button>` // FIX 4
                : `<button class="btn user-delete-btn" data-username="${escapeHtml(username)}" style="padding:4px 10px; font-size:0.75rem; border:1px solid #ef4444; color:#ef4444; background:transparent;">${escapeHtml(t('common.delete'))}</button>`; // FIX 4
            rows.push(`
                <div class="admin-user-card" style="background:var(--surface-solid); padding:16px; border-radius:var(--radius-sm); border:1px solid var(--border); margin-bottom:12px;">
                    <div class="admin-user-header" style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHtml(username)}</strong>
                            ${u.isAdmin ? `<span style="color:var(--primary); font-size:0.75rem;">(${t('common.adminTag')})</span>` : ''}
                            ${u.isGuest ? `<span style="color:var(--text-warning, #D97706); font-size:0.75rem;">(${t('common.guestTag')})</span>` : ''}
                            ${(u.accessExpiry && Date.now() > u.accessExpiry) ? `<span style="color:#ef4444; font-size:0.75rem; font-weight:bold;">(Expired)</span>` : ''}
                            ${pendingNote}
                        </div>
                        <div style="display:flex; gap:8px;">
                            ${editButton}
                            ${deleteButton}
                        </div>
                    </div>
                </div>`);
        });
        list.innerHTML = rows.join('') || `<p class="text-muted">${t('admin.noUsers')}</p>`;
        // FIX 4: Attach event listeners after innerHTML is set, reading username safely from data-username attribute
        list.querySelectorAll('.user-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => window.editUser(btn.dataset.username)); // FIX 4
        });
        list.querySelectorAll('.user-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => window.deleteUser(btn.dataset.username)); // FIX 4
        });
        list.querySelectorAll('.user-undo-btn').forEach(btn => {
            btn.addEventListener('click', () => window.undoPendingUserDelete(btn.dataset.username)); // FIX 4
        });
    } catch (e) { list.innerHTML = `<p class="text-muted">${t('admin.errorLoadingUsers')}</p>`; }
};

window.editUser = async function (user) {
    const safeUser = cleanText(user).toLowerCase();
    if (pendingUserDeletes.has(safeUser)) {
        showToast(t('admin.pendingDeleteWait'), true);
        return;
    }
    try {
        const snap = await db.collection('users').doc(safeUser).get();
        if (!snap.exists) return;
        const u = snap.data();
        document.getElementById('new-username').value = u.username;
        const passwordInput = document.getElementById('new-password');
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.placeholder = t('admin.newPasswordPlaceholder') || 'New password (leave blank to keep current)';
        }
        document.getElementById('new-is-admin').checked = !!u.isAdmin;
        document.getElementById('new-is-guest').checked = !!u.isGuest;
        document.getElementById('guest-duration-config').style.display = u.isGuest ? 'flex' : 'none';
        document.getElementById('guest-duration-val').value = '5';
        document.getElementById('guest-duration-unit').value = 'hours';
        document.getElementById('guest-global-access').checked = !!u.globalAccess;

        const allowed = u.allowedThemes || ['light', 'dark', 'vibrant', 'comfort'];
        document.getElementById('allow-theme-light').checked = allowed.includes('light');
        document.getElementById('allow-theme-dark').checked = allowed.includes('dark');
        document.getElementById('allow-theme-vibrant').checked = allowed.includes('vibrant');
        document.getElementById('allow-theme-comfort').checked = allowed.includes('comfort');

        document.getElementById('new-is-demo').checked = !!u.isDemo;

        const p = u.permissions || {};
        document.getElementById('p-farms').checked = !!p.farms;
        document.getElementById('p-workers').checked = !!p.workers;
        document.getElementById('p-attendance').checked = !!p.attendance;
        document.getElementById('p-payments').checked = !!p.payments;
        document.getElementById('p-edit').checked = !!p.canEdit;
        document.getElementById('p-backup').checked = !!p.canManageBackup; // NEW PERMISSION

        document.getElementById('new-username').readOnly = true;
        refreshAdminUserFormText(safeUser);

        showToast(t('admin.editingUser', { username: safeUser }));
    } catch (e) { showToast(t('admin.failedLoadUserData', true)); }
};

window.clearUserForm = function () {
    document.getElementById('new-username').value = '';
    document.getElementById('new-username').readOnly = false;
    const passwordInput = document.getElementById('new-password');
    if (passwordInput) {
        passwordInput.value = '';
        passwordInput.placeholder = t('admin.passwordPlaceholder') || 'Password';
    }
    document.getElementById('new-is-admin').checked = false;
    document.getElementById('new-is-guest').checked = false;
    document.getElementById('guest-duration-config').style.display = 'none';
    document.getElementById('guest-duration-val').value = '5';
    document.getElementById('guest-duration-unit').value = 'hours';
    document.getElementById('guest-global-access').checked = false;
    document.getElementById('allow-theme-light').checked = true;
    document.getElementById('allow-theme-dark').checked = true;
    document.getElementById('allow-theme-vibrant').checked = false;
    document.getElementById('allow-theme-comfort').checked = true;
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
            <div style="font-weight:600; color:var(--primary); font-size:0.75rem;">${new Date(l.time).toLocaleString(window.getCurrentLocale?.() || undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} - ${escapeHtml(l.user)}</div>
            <div style="font-size:0.8rem;">${escapeHtml(l.action)}</div>
        </div>
    `).join('') || `<p class="text-muted">${t('admin.noRecentActivity')}</p>`;
};

window.addNewUser = async function () {
    const u = document.getElementById('new-username').value.trim().toLowerCase();
    const p = document.getElementById('new-password').value;
    const isEditingUser = !!document.getElementById('new-username').readOnly;
    if (!u || (!isEditingUser && !p)) return showToast(t('admin.fillBothFields', true));
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

    let accessExpiry = null;
    let globalAccess = false;

    const allowedThemes = [];
    if (document.getElementById('allow-theme-light').checked) allowedThemes.push('light');
    if (document.getElementById('allow-theme-dark').checked) allowedThemes.push('dark');
    if (document.getElementById('allow-theme-vibrant').checked) allowedThemes.push('vibrant');
    if (document.getElementById('allow-theme-comfort').checked) allowedThemes.push('comfort');

    // Enforce max 3 themes (skip for admin)
    if (!isAdmin && allowedThemes.length > 3) {
        return showToast(t('admin.maxThemesError', true) || 'Maximum 3 themes allowed per user.');
    }
    if (allowedThemes.length === 0) allowedThemes.push('light');

    if (isGuest) {
        const val = parseInt(document.getElementById('guest-duration-val').value) || 5;
        const unit = document.getElementById('guest-duration-unit').value;
        const msDuration = val * (unit === 'days' ? GUEST_ACCESS_DAY_MS : GUEST_ACCESS_HOUR_MS);
        accessExpiry = Date.now() + msDuration;
        globalAccess = document.getElementById('guest-global-access').checked;
    }

    try {
        const userPayload = {
            username: u,
            isAdmin,
            isGuest,
            isDemo,
            permissions: perms,
            language: 'en',
            accessExpiry,
            globalAccess,
            allowedThemes
        };
        if (p) {
            userPayload.passwordHash = await hashPassword(p);
            const deleteField = getFirestoreDeleteFieldValue();
            if (deleteField) userPayload.password = deleteField;
        }

        await db.collection('users').doc(u).set(userPayload, { merge: true });

        showToast(t('admin.userSaved'));
        window.clearUserForm();
        window.refreshUserList();
    } catch (e) {
        showToast(t('admin.addUserError', true));
    }
};
// --- Helpers ---
function roundCurrency(value) {
    return Number(Number(value || 0).toFixed(2)) || 0;
}

function getWorkerLoanBalance(worker) {
    const loan = Number(worker?.loanAmount || 0);
    if (!Number.isFinite(loan)) return 0;
    if (loan < 0) {
        console.warn('Worker loan balance was negative and has been clamped to zero:', worker?.id || worker?.name || 'unknown');
        return 0;
    }
    return roundCurrency(loan);
}

function roundDayValue(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}



function calculateWorkerAttendanceTotals(workerId) {
    const w = state.workers.find(x => x.id === workerId);
    if (!w) return { totalDays: 0, earnedAmount: 0, extraAmount: 0 };

    const dailyWage = Number(w.dailyWage || 0) || 0;
    const overtimeCharge = Number(w.overtimeCharge || 0) || 0;
    let totalDays = 0;
    let earnedAttendance = 0;

    for (const date in state.attendance) {
        for (const fId in state.attendance[date]) {
            const val = state.attendance[date][fId][workerId];
            if (!hasAttendanceWork(val)) continue;
            if (isOvertimeValue(val)) {
                totalDays += 1;
                earnedAttendance += dailyWage + overtimeCharge;
            } else {
                const rawF = parseFloat(normalizeAttendanceValue(val));
                const f = Number.isFinite(rawF) ? Math.round(rawF * 10000) / 10000 : 0;
                totalDays = Math.round((totalDays + f) * 10000) / 10000;
                earnedAttendance += f * dailyWage;
            }
        }
    }

    return {
        totalDays: Number(Number(totalDays).toFixed(2)),
        earnedAmount: Number(earnedAttendance.toFixed(2))
    };
}

function buildWorkerOutstandingLineItems(workerId) {
    const worker = state.workers.find(x => x.id === workerId);
    if (!worker) return [];

    const settlementMeta = getWorkerSettlementMeta(worker);
    const dailyWage = Number(worker.dailyWage || 0) || 0;
    const overtimeCharge = Number(worker.overtimeCharge || 0) || 0;
    const items = [];

    Object.keys(state.attendance || {}).sort().forEach(date => {
        if (isWorkerDateSettled(worker, date, settlementMeta)) return;
        const farmsForDate = state.attendance[date] || {};
        Object.keys(farmsForDate).sort().forEach(farmId => {
            const value = farmsForDate[farmId]?.[workerId];
            if (!hasAttendanceWork(value)) return;

            const normalizedValue = normalizeAttendanceValue(value);
            const days = isOvertimeValue(value) ? 1 : attendanceValueToDays(normalizedValue);
            const amount = isOvertimeValue(value)
                ? (dailyWage + overtimeCharge)
                : (days * dailyWage);
            const farm = state.farms.find(x => x.id === farmId);

            items.push({
                id: `attendance_${date}_${farmId}_${workerId}`,
                kind: 'attendance',
                date,
                farmId,
                farmName: farm?.name || t('common.deletedFarm', { id: farmId }),
                label: getAttendanceStatusLabel(normalizedValue),
                value: normalizedValue,
                days: roundDayValue(days),
                amount: roundCurrency(amount)
            });
        });
    });

    (worker.overtime || []).forEach((entry, index) => {
        const entryDate = parseImportedDate(entry?.date) || '';
        if (entryDate && isWorkerDateSettled(worker, entryDate, settlementMeta)) return;
        const amount = roundCurrency(entry?.amount);
        if (amount <= 0) return;
        items.push({
            id: cleanText(entry?.id) || `extra_${entryDate || 'undated'}_${index}`,
            kind: 'extra',
            date: entryDate,
            farmId: '',
            farmName: '',
            label: cleanText(entry?.note) || t('breakdown.extraWages'),
            note: cleanText(entry?.note),
            value: '',
            days: 0,
            amount
        });
    });

    return items.sort((a, b) => {
        const safeDateA = a.date || '9999-12-31';
        const safeDateB = b.date || '9999-12-31';
        if (safeDateA !== safeDateB) return safeDateA.localeCompare(safeDateB);
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        if (a.farmId !== b.farmId) return a.farmId.localeCompare(b.farmId);
        return a.id.localeCompare(b.id);
    });
}

function allocateCreditAcrossWorkerItems(items, creditAmount = 0) {
    let remainingCredit = Math.max(0, roundCurrency(creditAmount));
    return items.map(item => {
        const amount = roundCurrency(item.amount);
        const appliedAmount = roundCurrency(Math.min(remainingCredit, amount));
        remainingCredit = roundCurrency(remainingCredit - appliedAmount);
        const remainingAmount = roundCurrency(amount - appliedAmount);
        return {
            ...item,
            appliedAmount,
            remainingAmount,
            remainingDays: roundDayValue(item.days * (remainingAmount / (amount || 1)))
        };
    });
}

function toBreakdownDomKey(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function calculateWorkerStats(workerId) {
    if (workerStatsCache.has(workerId)) return workerStatsCache.get(workerId);

    const w = state.workers.find(x => x.id === workerId);
    if (!w) {
        return {
            totalDays: 0,
            totalEarned: 0,
            unpaidDays: 0,
            unpaidEarnings: 0,
            initialDebt: 0,
            pendingAmount: 0,
            paidAmount: 0,
            loanAmount: 0,
            farmBreakdown: []
        };
    }

    const paid = Number(w.paidAmount || 0) || 0;
    const loan = Number(w.loanAmount || 0) || 0;
    const initialDebt = Number(w.initialDebt || 0) || 0;

    const lineItems = buildWorkerOutstandingLineItems(workerId);
    const earnedAmount = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const totalDays = lineItems
        .filter(item => item.kind === 'attendance')
        .reduce((sum, item) => sum + item.days, 0);
    const creditApplied = Math.min(paid, earnedAmount);
    const unpaidEarnings = Math.max(0, earnedAmount - creditApplied);
    let unpaidDays = 0;
    if (earnedAmount > 0) {
        unpaidDays = roundDayValue(totalDays * (unpaidEarnings / earnedAmount));
    }

    const pendingAmount = roundCurrency(earnedAmount + initialDebt - paid - loan);
    const ratio = earnedAmount > 0 ? unpaidEarnings / earnedAmount : 0;

    // Simple Farm Breakdown for UI details (rebuilt from outstanding line items only)
    const farmMap = new Map();
    lineItems.forEach(item => {
        if (item.kind !== 'attendance') return;
        const fId = item.farmId;
        const current = farmMap.get(fId) || { farmId: fId, farmName: item.farmName, totalDays: 0, pendingAmount: 0, entries: [] };
        current.totalDays = roundDayValue(current.totalDays + (item.days || 0));
        current.pendingAmount = roundCurrency(current.pendingAmount + (item.amount || 0));
        current.entries.push({ date: item.date, amount: item.amount, days: item.days, label: item.value });
        farmMap.set(fId, current);
    });

    const farmBreakdown = Array.from(farmMap.values()).map(farmSummary => ({
        ...farmSummary,
        displayDays: roundDayValue(farmSummary.totalDays * ratio),
        displayAmount: roundCurrency(farmSummary.pendingAmount * ratio)
    }));

    const result = {
        totalDays: totalDays,
        totalEarned: roundCurrency(earnedAmount),
        unpaidDays,
        unpaidEarnings: roundCurrency(unpaidEarnings),
        initialDebt,
        pendingAmount: pendingAmount,
        paidAmount: paid,
        loanAmount: loan,
        farmBreakdown
    };

    workerStatsCache.set(workerId, result);
    return result;
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

    const settlementMeta = getWorkerSettlementMeta(w);
    let overtimeDays = 0;
    let attendanceOvertimeAmount = 0;

    for (const date in state.attendance) {
        if (isWorkerDateSettled(w, date, settlementMeta)) continue;

        for (const fId in state.attendance[date]) {
            const val = state.attendance[date][fId][workerId];
            if (!hasAttendanceWork(val) || !isOvertimeValue(val)) continue;
            overtimeDays += 1;
            attendanceOvertimeAmount += (w.overtimeCharge || 0);
        }
    }

    let extraWageEntries = 0;
    let extraWageAmount = 0;
    (w.overtime || []).forEach(entry => {
        const overtimeDate = cleanText(entry?.date);
        if (overtimeDate && isWorkerDateSettled(w, overtimeDate, settlementMeta)) return;
        extraWageEntries += 1;
        extraWageAmount += Number(entry?.amount || 0) || 0;
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
    const username = cleanText(u).toLowerCase();
    if (!username) return;
    if (username === 'admin') return showToast(t('admin.cannotDeleteAdmin', true));
    if (username === currentUser?.username?.toLowerCase()) return showToast('You cannot delete your own account while logged in.', true); // FIX 6
    if (pendingUserDeletes.has(username)) {
        showToast(t('admin.pendingDeleteWait'), true);
        return;
    }
    if (!confirm(t('admin.deleteConfirm', { username }))) return;

    const entry = {
        expiresAt: Date.now() + USER_DELETE_UNDO_MS,
        timeoutId: null,
        intervalId: null
    };

    entry.timeoutId = setTimeout(() => {
        finalizePendingUserDelete(username);
    }, USER_DELETE_UNDO_MS);
    entry.intervalId = setInterval(() => {
        if (!pendingUserDeletes.has(username)) return;
        renderUserDeleteToast(username);
    }, 1000);

    pendingUserDeletes.set(username, entry);
    renderUserDeleteToast(username);
    window.refreshUserList();
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

/**
 * Scans all attendance data and removes cross-farm over-capacity entries.
 * A worker cannot work more than MAX_DAILY_WORK_CAPACITY (1 day) across all farms
 * on the same date. Attendance rows do not store edit timestamps, so conflicts are
 * resolved deterministically: larger day values are kept first, then farm name/id.
 * Returns the number of conflicting entries removed.
 */
function fixCrossFarmDuplicates() {
    const attendance = state.attendance || {};
    let removedCount = 0;

    Object.keys(attendance).forEach(date => {
        if (!isValidISODateKey(date)) return;
        const dayData = attendance[date] || {};
        const farmIds = Object.keys(dayData);
        if (farmIds.length < 2) return; // Only one farm; no conflict possible.

        const entriesByWorker = new Map();
        farmIds.forEach(farmId => {
            const farmWorkers = dayData[farmId] || {};
            Object.keys(farmWorkers).forEach(workerId => {
                const val = normalizeAttendanceValue(farmWorkers[workerId]);
                if (!val || val === '0') return;
                const days = attendanceValueToDays(val);
                if (days <= 0) return;
                const farmName = cleanText(state.farms.find(f => f.id === farmId)?.name || farmId).toLowerCase();
                const workerEntries = entriesByWorker.get(workerId) || [];
                workerEntries.push({ farmId, workerId, days, farmName });
                entriesByWorker.set(workerId, workerEntries);
            });
        });

        entriesByWorker.forEach(workerEntries => {
            if (workerEntries.length < 2) return;
            let total = 0;
            workerEntries
                .sort((a, b) => {
                    if (b.days !== a.days) return b.days - a.days;
                    if (a.farmName !== b.farmName) return a.farmName.localeCompare(b.farmName);
                    return a.farmId.localeCompare(b.farmId);
                })
                .forEach(entry => {
                    if (total + entry.days <= MAX_DAILY_WORK_CAPACITY + 0.0001) {
                        total = roundDayValue(total + entry.days);
                        return;
                    }

                    if (dayData[entry.farmId]?.[entry.workerId] !== undefined) {
                        delete dayData[entry.farmId][entry.workerId];
                        removedCount++;
                    }
                });
        });

        farmIds.forEach(farmId => {
            if (dayData[farmId] && Object.keys(dayData[farmId]).length === 0) delete dayData[farmId];
        });
        if (Object.keys(dayData).length === 0) delete attendance[date];
    });

    if (removedCount > 0) {
        console.warn('[fixCrossFarmDuplicates] Removed ' + removedCount + ' cross-farm duplicate attendance entries.');
        workerStatsCache.clear();
    }
    return removedCount;
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
                // Skip entries for deleted farms or workers
                if (!farm || !worker) continue;
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
            appVersion: APP_VERSION,
            workers: Array.isArray(data.workers) ? data.workers.length : 0,
            farms: Array.isArray(data.farms) ? data.farms.length : 0,
            attendanceDates: Object.keys(attendance).length,
            attendanceRows: rows
        };

        return summary;
    } catch (error) {
        console.error(error);
        showToast(t('recovery.cloudCheckFailed', { message: error?.message || error }, true));
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
        try { deletedSnapshot = JSON.parse(localStorage.getItem('farmWorkerDeletedAttendanceSnapshot') || 'null'); } catch (_error) {
            console.warn('Deleted attendance snapshot could not be parsed.', _error);
        }
        const deletedAttendance = (deletedSnapshot?.attendance && typeof deletedSnapshot.attendance === 'object')
            ? deletedSnapshot.attendance
            : {};

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
                throw new Error('No attendance source data found in cloud or local backups.');
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

        showToast(t('recovery.completeRows', { rows: summary.attendanceRows }));
        return summary;
    } catch (error) {
        console.error(error);
        showToast(t('recovery.failed', { message: error?.message || error }, true));
        return null;
    }
};

// === ENHANCED EXPORT SYSTEM ===
function buildAttendanceSheetRows(entries) {
    if (!entries.length) {
        return [{
            Date: 'No Records',
            Farm: '',
            Worker: '',
            'Work Type': '',
            'Daily Wage': '',
            'Total Earned': ''
        }];
    }

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
            'Daily Wage': '---',
            'Total Earned': '---'
        });

        // Add attendance rows for this date
        groupedByDate[date].forEach(entry => {
            const worker = state.workers.find(x => x.id === entry.workerId);
            const dailyWage = Number(worker?.dailyWage || 0) || 0;
            const days = attendanceValueToDays(entry.value);
            rows.push({
                Date: '',
                Farm: entry.farmName || '',
                Worker: entry.workerName || '',
                'Work Type': isOvertimeValue(entry.value) ? 'OT' : entry.value,
                'Daily Wage': dailyWage,
                'Total Earned': Number((days * dailyWage).toFixed(2))
            });
        });

        // Add empty row as separator
        rows.push({
            Date: '',
            Farm: '',
            Worker: '',
            'Work Type': '',
            'Daily Wage': '',
            'Total Earned': '',
            'Payment Cycle ID': '',
            'Payment Status': ''
        });
    });

    return rows;
}

function buildSheet(data) {
    return XLSX.utils.json_to_sheet(Array.isArray(data) ? data : []);
}

function exportWorkbook({ fileName, farmsData = state.farms, workersData = state.workers, attendanceEntries = [], isDateExport = false }) {
    if (typeof XLSX === 'undefined') {
        showToast(t('recovery.excelLibraryMissing', true));
        return false;
    }
    const wb = XLSX.utils.book_new();

    const formattedFarms = farmsData.map(f => ({
        'Farm ID': f.id,
        'Farm Name': f.name,
        'Location': f.location || 'N/A',
        'Capacity': f.capacity || 'N/A'
    }));

    const formattedWorkers = workersData.map(w => ({
        'Worker ID': w.id,
        'Worker Name': w.name,
        'Role': w.role || '',
        'Daily Wage': w.dailyWage || 0,
        'Overtime Charge': w.overtimeCharge || 0,
        'Phone': w.phone || 'N/A',
        'Bank Name': w.bankName || 'N/A',
        'Account No': w.accountNum || 'N/A',
        'IFSC': w.ifsc || 'N/A'
    }));

    const formattedPayments = workersData.map(w => {
        const stats = typeof calculateWorkerStats === 'function' ? calculateWorkerStats(w.id) : { totalEarned: 0, pendingAmount: 0, totalDays: 0, paidAmount: 0, loanAmount: 0 };

        if (isDateExport) {
            const workerEntries = attendanceEntries.filter(e => e.workerId === w.id);
            let earnedForRange = 0;
            workerEntries.forEach(e => {
                let amount = 0;
                if (e.value === '1') amount = w.dailyWage || 0;
                else if (e.value === '0.5') amount = (w.dailyWage || 0) / 2;
                else if (e.value === 'ot') amount = w.overtimeCharge || 0;
                earnedForRange += amount;
            });
            return {
                'Worker Name': w.name,
                'Earned': earnedForRange,
                'Loan Remaining': stats.loanAmount || 0,
                'Pending Amount': stats.pendingAmount || 0
            };
        } else {
            return {
                'Worker Name': w.name,
                'Daily Wage': w.dailyWage || 0,
                'Total Days Worked': stats.totalDays || 0,
                'Total Earned': stats.totalEarned || 0,
                'Paid Amount': stats.paidAmount || 0,
                'Loan Balance': stats.loanAmount || 0,
                'Pending Payout': stats.pendingAmount || 0
            };
        }
    });

    XLSX.utils.book_append_sheet(wb, buildSheet(formattedFarms), "Farms");
    XLSX.utils.book_append_sheet(wb, buildSheet(formattedWorkers), "Workers");
    XLSX.utils.book_append_sheet(wb, buildSheet(formattedPayments), "Payment");
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
    if (language) language.value = window.getCurrentLanguage?.() || currentUser.language || 'en';

    const themeSel = document.getElementById('profile-theme');
    if (themeSel) {
        renderThemeSelectOptions(themeSel, currentUser);
    }
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
            const savedWebhook = getGoogleSheetsConfig().webhookUrl;
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
    const visibleFarms = window.getVisibleFarms();
    const visibleWorkers = window.getVisibleWorkers();

    setText('dashboard-farms-count', visibleFarms.length);
    setText('dashboard-workers-count', visibleWorkers.length);
    const total = calculateVisiblePendingPayoutTotal();
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

window.getVisibleFarms = function () {
    if (currentUser?.isGuest && !currentUser?.globalAccess) {
        return state.farms.filter(f => f.createdBy === currentUser.username);
    }
    return state.farms;
};

function renderFarmsList() {
    const list = document.getElementById('farms-list'); if (!list) return;
    const visibleFarms = window.getVisibleFarms();

    if (!visibleFarms.length) {
        list.innerHTML = `<div class="empty-state">No farms yet. Click "${escapeHtml(t('farms.add'))}" to get started.</div>`;
        return;
    }

    list.innerHTML = visibleFarms.map((f, i) => {
        const farmName = cleanText(f?.name) || t('common.farmLabel', { id: f?.id || i + 1 });
        const location = cleanText(f?.location) || t('common.noLocation');

        return `
            <div class="card stagger-anim" style="animation-delay: ${i * 0.05}s">
                <div class="flex-between" style="align-items: flex-start; gap: 12px;">
                    <div style="min-width: 0;">
                        <h3>${escapeHtml(farmName)}</h3>
                        <p class="card-subtitle">${t('farms.location')}: ${escapeHtml(location)}</p>
                    </div>
                    <button class="btn btn-secondary edit-gate farm-edit-btn" data-farm-id="${escapeHtml(f.id)}">${t('common.edit')}</button>
                </div>
                <div style="margin-top: 12px;">
                    <span class="status-badge status-active">${t('common.active')}</span>
                </div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.farm-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => window.openFarmModal(btn.dataset.farmId));
    });
}

window.getVisibleWorkers = function () {
    if (currentUser?.isGuest && !currentUser?.globalAccess) {
        return state.workers.filter(w => w.createdBy === currentUser.username);
    }
    return state.workers;
};

function calculateVisiblePendingPayoutTotal() {
    return roundCurrency(window.getVisibleWorkers().reduce((sum, worker) => {
        const pendingAmount = Number(calculateWorkerStats(worker.id)?.pendingAmount || 0);
        return sum + pendingAmount;
    }, 0));
}

function renderWorkersList() {
    const list = document.getElementById('workers-list'); if (!list) return;
    list.innerHTML = window.getVisibleWorkers().map((w, i) => `
        <div class="card worker-card stagger-anim" style="animation-delay: ${i * 0.05}s">
            <div class="worker-avatar">${escapeHtml((w.name || '?').charAt(0).toUpperCase())}</div>
            <div class="worker-info">
                <h3 style="color: var(--text-strong);">${escapeHtml(w.name)}</h3>
                <p class="card-subtitle">${escapeHtml(w.role || t('workers.noRole'))} &bull; ${formatCurrency(w.dailyWage)}${t('common.perDay')}</p>
            </div>
            <button class="btn btn-secondary edit-gate worker-edit-btn" data-worker-id="${escapeHtml(w.id)}">${t('common.edit')}</button>
        </div>
    `).join('');

    list.querySelectorAll('.worker-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => window.openWorkerModal(btn.dataset.workerId));
    });

    // Re-apply active search filter after re-render
    const searchInput = document.getElementById('workers-search-input');
    if (searchInput && searchInput.value.trim()) {
        window.filterWorkersList(searchInput.value);
    }
}

// Filter worker cards by name or role (non-destructive; hides cards only)
window.filterWorkersList = function (query) {
    const term = (query || '').trim().toLowerCase();
    const cards = document.querySelectorAll('#workers-list .worker-card');
    let visibleCount = 0;
    cards.forEach(card => {
        const name = (card.querySelector('h3')?.textContent || '').toLowerCase();
        const role = (card.querySelector('.card-subtitle')?.textContent || '').toLowerCase();
        const show = !term || name.includes(term) || role.includes(term);
        card.style.display = show ? '' : 'none';
        if (show) visibleCount++;
    });
    const noResults = document.getElementById('workers-no-results');
    if (noResults) noResults.style.display = (term && visibleCount === 0) ? 'block' : 'none';
};

function renderPaymentsTable() {
    const tbody = document.getElementById('payments-table-body');
    const headerRow = document.querySelector('#payments-table thead tr');
    if (!tbody || !headerRow) return;

    const searchWrapper = document.getElementById('payments-search-wrapper');
    const searchInput = document.getElementById('payments-search-input');

    const noResults = document.getElementById('payments-no-results');
    if (noResults) noResults.style.display = 'none';
    if (searchWrapper) searchWrapper.style.display = '';

    headerRow.innerHTML = `
        <th data-i18n="payments.workerName">${escapeHtml(t('payments.workerName'))}</th>
        <th data-i18n="payments.unpaidDays">${escapeHtml(t('payments.unpaidDays'))}</th>
        <th data-i18n="payments.earned">${escapeHtml(t('payments.earned'))}</th>
        <th data-i18n="payments.paid">${escapeHtml(t('payments.paid'))}</th>
        <th data-i18n="payments.loans">${escapeHtml(t('payments.loans'))}</th>
        <th data-i18n="payments.pending">${escapeHtml(t('payments.pending'))}</th>
        <th class="actions-col" data-i18n="payments.actions">${escapeHtml(t('payments.actions'))}</th>
    `;

    const filteredWorkers = window.getVisibleWorkers();

    if (!filteredWorkers.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:24px;">${escapeHtml(t('payments.unpaidEmpty'))}</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredWorkers.map(worker => {
        const stats = calculateWorkerStats(worker.id);
        stats.loanAmount = Math.max(0, Number(stats.loanAmount || 0));
        const pendingAmount = Number(stats.pendingAmount || 0);
        const displayDays = stats.unpaidDays;
        const displayEarned = stats.unpaidEarnings;

        return `
            <tr>
                <td data-label="${escapeHtml(t('payments.workerName'))}" class="payment-name-cell">
                    <strong style="color: var(--text-strong);">${escapeHtml(worker.name)}</strong>
                </td>
                <td data-label="${escapeHtml(t('payments.unpaidDays'))}">${window.formatCountValue ? window.formatCountValue(displayDays) : displayDays}</td>
                <td data-label="${escapeHtml(t('payments.earned'))}">${formatCurrency(displayEarned)}</td>
                <td data-label="${escapeHtml(t('payments.paid'))}">${formatCurrency(stats.paidAmount)}</td>
                <td data-label="${escapeHtml(t('payments.loans'))}">${formatCurrency(stats.loanAmount)}</td>
                <td data-label="${escapeHtml(t('payments.pending'))}" class="${pendingAmount > 0 ? 'text-warning' : 'text-success'}"><strong>${formatCurrency(pendingAmount)}</strong></td>
                <td data-label="${escapeHtml(t('payments.actions'))}" class="payment-actions-cell">
                    <button class="btn btn-secondary" onclick="window.openBreakdownModal('${worker.id}')">${escapeHtml(t('common.details'))}</button>
                    <button class="btn btn-primary edit-gate" onclick="window.openPaymentModal('${worker.id}')">${escapeHtml(t('common.pay'))}</button>
                </td>
            </tr>
        `;
    }).join('');

    if (searchInput && searchInput.value.trim()) {
        window.filterPaymentsTable(searchInput.value);
    }
}

// Filter payments table rows by worker name (non-destructive; hides rows only)
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

    if (currentUser?.isGuest && !currentUser?.globalAccess && f.id && f.createdBy !== currentUser.username) {
        showToast(t('common.accessDenied') || "Access Denied", true);
        return;
    }

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
        else state.farms.push({ id, ...data, createdBy: currentUser?.username || 'unknown' });
    } else {
        state.farms.push({ id: 'f' + Date.now(), ...data, createdBy: currentUser?.username || 'unknown' });
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
    updateBodyScrollState();
};

window.openWorkerModal = function (id) {
    const w = state.workers.find(x => x.id === id) || { id: '', name: '', role: '', dailyWage: 0, overtimeCharge: 0, initialDebt: 0, phone: '', bankName: '', accountNum: '', ifsc: '' };

    // Security Guard: Prevent guests from opening workers they didn't create
    if (currentUser?.isGuest && w.id && w.createdBy !== currentUser.username) {
        showToast(t('common.accessDenied') || "Access Denied", true);
        return;
    }

    document.getElementById('worker-id').value = w.id;
    document.getElementById('worker-name').value = w.name;
    document.getElementById('worker-role').value = w.role || '';
    document.getElementById('worker-wage').value = w.dailyWage || 0;
    const overtimeCharge = document.getElementById('worker-overtime-charge');
    if (overtimeCharge) overtimeCharge.value = w.overtimeCharge || 0;
    const initialDebt = document.getElementById('worker-initial-debt');
    if (initialDebt) initialDebt.value = w.initialDebt || 0;
    // FIX 3: Populate the phone field when opening the worker modal.
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
    let workerId = id;
    const data = {
        name,
        role: document.getElementById('worker-role').value.trim(),
        dailyWage: parseFloat(document.getElementById('worker-wage').value) || 0,
        overtimeCharge: parseFloat(document.getElementById('worker-overtime-charge')?.value) || 0,
        initialDebt: parseFloat(document.getElementById('worker-initial-debt')?.value) || 0,
        // FIX 4: Include phone field in saved worker data.
        // Previously saveWorker never read the phone input, so typing a phone number had no effect.
        phone: document.getElementById('worker-phone')?.value?.trim() || '',
        bankName: document.getElementById('worker-bank-name')?.value || '',
        accountNum: document.getElementById('worker-account-num')?.value || '',
        ifsc: document.getElementById('worker-ifsc')?.value || ''
    };
    if (id) {
        const idx = state.workers.findIndex(x => x.id === id);
        if (idx >= 0) state.workers[idx] = { ...state.workers[idx], ...data };
        else state.workers.push({ id, ...data, paidAmount: 0, loanAmount: 0, settledPeriods: [], overtime: [], createdBy: currentUser?.username || 'unknown' });
        logActivity(t('activity.updatedWorker', { name }));
    } else {
        const newW = { id: 'w' + Date.now(), ...data, paidAmount: 0, loanAmount: 0, settledPeriods: [], overtime: [], createdBy: currentUser?.username || 'unknown' };
        workerId = newW.id;
        state.workers.push(newW);
        logActivity(t('activity.addedWorker', { name }));
    }
    saveState();
    window.toggleModal('worker-modal');
    renderWorkersList();
    if (workerId) workerStatsCache.delete(workerId);
    renderPaymentsTable();
    renderDashboard();
    showToast(t(id ? 'workerModal.updateSuccess' : 'workerModal.addSuccess'));
};

window.deleteWorker = function () {
    const id = document.getElementById('worker-id').value;
    const worker = state.workers.find(x => x.id === id);
    const workerName = worker?.name || t('common.workerLabel', { id });
    if (!id || !confirm(t('workerModal.deleteConfirm', { worker: workerName })) || !confirm(t('workerModal.deleteFinal'))) return;
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
    summaryList.innerHTML = window.getVisibleWorkers().map(w => {
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
                <span style="font-weight: 600; color: var(--text-strong);">${escapeHtml(w.name)}</span>
                <span style="font-weight:700; color:${data.days <= 0 ? 'var(--text-body)' : 'var(--primary)'}">${escapeHtml(label)}</span>
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
    const visibleFarms = window.getVisibleFarms();
    s.innerHTML = `<option value="" disabled>${t('common.selectFarm')}</option>` +
        `<option value="all">${t('common.allFarms')}</option>` +
        visibleFarms.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    if (visibleFarms.some(f => f.id === currentValue) || currentValue === 'all') s.value = currentValue;
    else if (visibleFarms.length > 0) s.value = visibleFarms[0].id;
    else s.value = '';
}

function setAttendanceFarmEntries(selectedDate, selectedFarm, farmEntries = {}) {
    const safeDate = isValidISODateKey(selectedDate) ? selectedDate : '';
    const safeFarm = cleanText(selectedFarm);
    if (!safeDate || !safeFarm) return;

    const nextAttendance = { ...(state.attendance || {}) };
    const nextDateEntries = { ...(nextAttendance[safeDate] || {}) };
    const nextFarmEntries = { ...farmEntries };

    if (Object.keys(nextFarmEntries).length > 0) {
        nextDateEntries[safeFarm] = nextFarmEntries;
        nextAttendance[safeDate] = nextDateEntries;
    } else {
        delete nextDateEntries[safeFarm];
        if (Object.keys(nextDateEntries).length > 0) nextAttendance[safeDate] = nextDateEntries;
        else delete nextAttendance[safeDate];
    }

    state.attendance = nextAttendance;
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

    list.innerHTML = window.getVisibleWorkers().map((w, i) => {
        const cur = (state.attendance[date] && state.attendance[date][fId]) ? state.attendance[date][fId][w.id] : '0';
        const isPresent = hasAttendanceWork(cur);
        const otherFarmStatus = getOtherFarmAttendanceStatus(date, fId, w.id);
        const atMaxCapacityElsewhere = otherFarmStatus === t('attendance.maxCapacity');
        return `
            <div class="card attendance-card stagger-anim" style="animation-delay: ${i * 0.03}s; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; border-left: 4px solid ${isPresent ? 'var(--primary)' : 'var(--border)'};">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div class="worker-avatar" style="width: 36px; height: 36px; font-size: 0.9rem; ${!isPresent ? 'background: var(--surface-hover); color: var(--text-body); box-shadow: none;' : ''}">${escapeHtml((w.name || '?').charAt(0).toUpperCase())}</div>
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                        <span style="font-weight: 600; font-size: 1.05rem; color: var(--text-strong); transition: color 0.3s;">${escapeHtml(w.name)}</span>
                        ${otherFarmStatus ? `<small style="font-size: 0.76rem; color: ${atMaxCapacityElsewhere ? 'var(--text-warning)' : 'var(--text-body)'};">${escapeHtml(otherFarmStatus)}</small>` : ''}
                    </div>
                </div>
                <div class="custom-select-wrapper" style="width: 140px;">
                    <select class="premium-select att-select ${!isPresent ? 'select-absent' : 'select-present'}" data-date="${escapeHtml(date)}" data-farm-id="${escapeHtml(fId)}" data-worker-id="${escapeHtml(w.id)}">
                        <option value="0" ${cur === '0' || !cur ? 'selected' : ''}>${t('attendance.absent')}</option>
                        <option value="1" ${cur === '1' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, '1') && cur !== '1' ? 'disabled' : ''}>${t('attendance.fullDay')}</option>
                        <option value="0.5" ${cur === '0.5' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, '0.5') && cur !== '0.5' ? 'disabled' : ''}>${t('attendance.halfDay')}</option>
                        <option value="ot" ${cur === 'ot' ? 'selected' : ''} ${!isAttendanceSelectionAllowed(date, fId, w.id, 'ot') && cur !== 'ot' ? 'disabled' : ''}>${t('attendance.overtime')}</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.att-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const { date, farmId, workerId } = e.target.dataset;
            window.handleAttChange(date, farmId, workerId, e.target.value);
        });
    });
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

    const nextFarmEntries = { ...(state.attendance?.[safeDate]?.[f] || {}) };
    if (safeValue === '0') delete nextFarmEntries[w];
    else nextFarmEntries[w] = safeValue;
    setAttendanceFarmEntries(safeDate, f, nextFarmEntries);
    workerStatsCache.delete(w);

    saveState();
    persistAttendanceFarmToFirestore(safeDate, f)
        .catch(e => console.error('Attendance sync failed:', e));
    window.renderAttendanceView();
};

// --- Splash Screen ---
window.hideSplashScreen = function () {
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => splash.style.display = 'none', SPLASH_FADE_DURATION_MS);
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
        if (!date) return showToast(t('common.selectDateFirst', true));
        range = normalizeDateRange(date, date);
    } else if (scope === 'daterange') {
        const start = document.getElementById('export-date-start').value;
        const end = document.getElementById('export-date-end').value;
        range = normalizeDateRange(start, end);
        if (!range) return showToast(t('common.selectBothDatesFirst', true));
    } else if (scope === 'farm') {
        farmId = document.getElementById('export-farm-select').value;
        if (!farmId) return showToast(t('common.selectFarmFirst', true));
    }
    const attendanceEntries = getAttendanceEntries({ range, farmId });
    const visibleFarms = window.getVisibleFarms();
    const visibleWorkers = window.getVisibleWorkers();

    const farmRows = (farmId && farmId !== 'all') ? visibleFarms.filter(f => f.id === farmId) : visibleFarms;
    const workerIds = new Set(attendanceEntries.map(entry => entry.workerId));
    const workerRows = scope === 'all' || workerIds.size === 0 ? visibleWorkers : visibleWorkers.filter(w => workerIds.has(w.id));

    exportWorkbook({
        fileName: opts.fileName || `FarmReport_${Date.now()}.xlsx`,
        farmsData: farmRows,
        workersData: workerRows,
        attendanceEntries,
        isDateExport: scope !== 'all'
    });
};

window.exportAttendanceExcel = function () {
    const range = getAttendanceRangeFromControls();
    const farmId = document.getElementById('attendance-farm-select')?.value || '';
    const attendanceEntries = getAttendanceEntries({ range, farmId });
    if (!attendanceEntries.length) return showToast(t('attendance.noRecordsForFilters', true));

    const visibleFarms = window.getVisibleFarms();
    const visibleWorkers = window.getVisibleWorkers();

    exportWorkbook({
        fileName: `Attendance_${Date.now()}.xlsx`,
        farmsData: (farmId && farmId !== 'all') ? visibleFarms.filter(f => f.id === farmId) : visibleFarms,
        workersData: visibleWorkers.filter(w => attendanceEntries.some(entry => entry.workerId === w.id)),
        attendanceEntries,
        isDateExport: true
    });
};

window.backupNow = function () {
    if (!currentUser?.isAdmin) return;
    const monthKey = getCurrentMonthKey();
    const fileName = `${getFormattedBackupName()}.xlsx`;
    const success = exportWorkbook({
        fileName: fileName,
        farmsData: window.getVisibleFarms(),
        workersData: window.getVisibleWorkers(),
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
    const exportedAt = new Date().toISOString();
    const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const formattedFarms = state.farms.map(f => ({
        'Farm ID': f.id,
        'Farm Name': f.name,
        'Location': f.location || 'N/A',
        'Capacity': f.capacity || 'N/A'
    }));

    const formattedWorkers = state.workers.map(w => ({
        'Worker ID': w.id,
        'Worker Name': w.name,
        'Role': w.role || '',
        'Daily Wage': w.dailyWage || 0,
        'Overtime Charge': w.overtimeCharge || 0,
        'Phone': w.phone || 'N/A',
        'Bank Name': w.bankName || 'N/A',
        'Account No': w.accountNum || 'N/A',
        'IFSC': w.ifsc || 'N/A'
    }));

    const formattedPayments = state.workers.map(w => {
        const stats = typeof calculateWorkerStats === 'function' ? calculateWorkerStats(w.id) : { totalEarned: 0, pendingAmount: 0, totalDays: 0, paidAmount: 0, loanAmount: 0 };
        return {
            'Worker Name': w.name,
            'Daily Wage': w.dailyWage || 0,
            'Total Days Worked': stats.totalDays || 0,
            'Total Earned': stats.totalEarned || 0,
            'Paid Amount': stats.paidAmount || 0,
            'Loan Balance': stats.loanAmount || 0,
            'Pending Payout': stats.pendingAmount || 0
        };
    });

    const formattedAttendance = typeof buildAttendanceSheetRows === 'function' ? buildAttendanceSheetRows(attendanceEntries) : attendanceEntries;

    const exportDateObj = new Date();
    const ds = typeof formatDateToDDMMYYYY === 'function' ? formatDateToDDMMYYYY(exportDateObj.toISOString().split('T')[0]) : exportDateObj.toISOString().split('T')[0];
    const ts = exportDateObj.toLocaleTimeString('en-US', { hour12: true });

    const formattedUploadInfo = [{
        'Upload Date': ds,
        'Upload Time': ts,
        'Triggered By': currentUser?.username || 'unknown',
        'Upload ID': uploadId,
        'Farms Count': formattedFarms.length,
        'Workers Count': formattedWorkers.length,
        'Attendance Rows': attendanceEntries.length
    }];

    return {
        source: 'chandragiri-web-app',
        uploadId,
        exportedAt,
        triggeredBy: currentUser?.username || 'unknown',
        summary: {
            farms: state.farms.length,
            workers: state.workers.length,
            attendanceRows: attendanceEntries.length
        },
        sheets: {
            'Farms': formattedFarms,
            'Workers': formattedWorkers,
            'Payment': formattedPayments,
            'Attendance': formattedAttendance,
            'Upload Date and Time': formattedUploadInfo
        }
    };
}

window.saveGoogleSheetsConfig = function () {
    if (!currentUser?.isAdmin) return showToast(t('common.adminAccessRequired', true));
    const input = document.getElementById('google-sheets-webhook-url');
    if (!input) return;
    const url = cleanText(input.value);
    if (!url) {
        state.googleSheetsConfig = {
            ...getGoogleSheetsConfig(),
            webhookUrl: '',
            updatedAt: Date.now()
        };
        saveState();
        updateGoogleSheetsSyncStatus();
        showToast(t('sheets.urlCleared'));
        return;
    }
    if (!isValidGoogleSheetsWebhookUrl(url)) {
        return showToast(t('sheets.invalidWebhook', true));
    }
    state.googleSheetsConfig = {
        ...getGoogleSheetsConfig(),
        webhookUrl: url,
        updatedAt: Date.now()
    };
    saveState();
    updateGoogleSheetsSyncStatus();
    showToast(t('sheets.urlSaved'));
};

window.syncToGoogleSheets = async function () {
    if (!currentUser?.isAdmin && !currentUser?.permissions?.canManageBackup) {
        return showToast(t('sheets.uploadPermissionError', true));
    }

    const webhookUrl = getGoogleSheetsConfig().webhookUrl;
    if (!webhookUrl) return showToast(t('sheets.saveUrlFirst', true));
    if (!isValidGoogleSheetsWebhookUrl(webhookUrl)) return showToast(t('sheets.savedUrlInvalid', true));

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

        state.googleSheetsConfig = {
            ...getGoogleSheetsConfig(),
            lastSyncAt: Date.now(),
            updatedAt: Date.now()
        };
        saveState();
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
        return showToast(t('sheets.restorePermissionError', true));
    }

    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        showToast(t('recovery.excelLibraryMissing', true));
        event.target.value = '';
        return;
    }

    const fileReader = new FileReader();
    fileReader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            // Bug 6 fix: use a monotonically-incrementing counter for generated IDs.
            // Date.now() returns the same millisecond value for all iterations in a
            // synchronous forEach, making collisions possible during bulk imports.
            let importIdCounter = Date.now();
            const generateImportId = (prefix) => prefix + (importIdCounter++) + '_' + Math.random().toString(36).substr(2, 4);
            let importedFarms = 0;
            let importedWorkers = 0;
            let importedAttendance = 0;
            let skippedAttendance = 0;

            // Read Farms
            if (workbook.SheetNames.includes('Farms')) {
                if (!Array.isArray(state.farms)) state.farms = [];
                const farmsSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Farms']);
                farmsSheet.forEach(row => {
                    const farmId = cleanText(row['id'] || row['Farm ID'] || row['farmId']) || generateImportId('f');
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
                    const workerId = cleanText(row['id'] || row['Worker ID'] || row['workerId']) || generateImportId('w');
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
            showToast(t('recovery.readExcelError', { message: err.message || err.toString() }), true);
        } finally {
            event.target.value = '';
        }
    };
    fileReader.readAsArrayBuffer(file);
};

window.openAttendanceClearModal = function () {
    if (!currentUser?.isAdmin) return;
    const selectedDate = document.getElementById('attendance-date')?.value;
    const selectedFarm = document.getElementById('attendance-farm-select')?.value;
    if (!selectedDate) {
        showToast(t('attendance.selectDateFirst'), true);
        return;
    }

    // Populate the modal's farm dropdown with "All Farms" + each individual farm
    const farmSelect = document.getElementById('clear-attendance-farm');
    if (farmSelect) {
        farmSelect.innerHTML = '<option value="all">\uD83C\uDF3E All Farms</option>' +
            (state.farms || []).map(f =>
                `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`
            ).join('');
        // Pre-select the farm currently open in the attendance view (if any)
        if (selectedFarm && selectedFarm !== 'all') {
            farmSelect.value = selectedFarm;
        } else {
            farmSelect.value = 'all';
        }
    }

    const scopeSelect = document.getElementById('clear-attendance-scope');
    const start = document.getElementById('clear-attendance-start');
    const end = document.getElementById('clear-attendance-end');
    if (start) start.value = selectedDate;
    if (end) end.value = selectedDate;
    if (scopeSelect) scopeSelect.value = 'range';
    window.handleAttendanceClearScopeChange();
    window.toggleModal('clear-attendance-modal');
};

window.handleAttendanceClearScopeChange = function () {
    const scope = document.getElementById('clear-attendance-scope')?.value || 'all';
    const rangeGroup = document.getElementById('clear-attendance-range-group');
    if (rangeGroup) rangeGroup.style.display = scope === 'range' ? 'block' : 'none';
    if (scope === 'range') {
        const selectedDate = document.getElementById('attendance-date')?.value || '';
        const start = document.getElementById('clear-attendance-start');
        const end = document.getElementById('clear-attendance-end');
        if (start && !start.value) start.value = selectedDate;
        if (end && !end.value) end.value = start?.value || selectedDate;
    }
};

function buildAttendanceClearPlan() {
    // Read farm from the modal's own dropdown (supports 'all' or a specific farm)
    const selectedFarm = document.getElementById('clear-attendance-farm')?.value || 'all';
    const isAllFarms = selectedFarm === 'all';

    const scope = document.getElementById('clear-attendance-scope')?.value || 'range';
    let range = null;
    if (scope === 'range') {
        const start = document.getElementById('clear-attendance-start')?.value || '';
        const end   = document.getElementById('clear-attendance-end')?.value   || '';
        if (!start || !end) {
            showToast(t('common.selectBothDatesFirst'), true);
            return null;
        }
        range = normalizeDateRange(start, end);
    }

    // Find all dates that have attendance for the chosen farm(s)
    const datesToDelete = Object.keys(state.attendance || {})
        .sort()
        .filter(date => {
            const dayData = state.attendance?.[date] || {};
            if (isAllFarms) {
                // Include the date if ANY farm has a non-empty entry
                return Object.keys(dayData).some(fId =>
                    Object.keys(dayData[fId] || {}).length > 0
                ) && (scope === 'all' || isDateWithinRange(date, range));
            } else {
                const farmEntries = dayData[selectedFarm];
                return farmEntries && Object.keys(farmEntries).length > 0 &&
                    (scope === 'all' || isDateWithinRange(date, range));
            }
        });

    if (!datesToDelete.length) {
        showToast(t('attendance.noRecordsForScope'), true);
        return null;
    }

    // Build snapshot (for undo / localStorage backup)
    const deletedSnapshot = {};
    datesToDelete.forEach(date => {
        if (isAllFarms) {
            deletedSnapshot[date] = JSON.parse(JSON.stringify(state.attendance[date] || {}));
        } else {
            deletedSnapshot[date] = {
                [selectedFarm]: JSON.parse(JSON.stringify(state.attendance[date][selectedFarm] || {}))
            };
        }
    });

    const effectiveRange = scope === 'all'
        ? normalizeDateRange(datesToDelete[0], datesToDelete[datesToDelete.length - 1])
        : range;

    // Build attendance entries for the Excel export
    const attendanceEntries = getAttendanceEntries({
        range: effectiveRange,
        farmId: isAllFarms ? 'all' : selectedFarm
    });
    if (!attendanceEntries.length) {
        showToast(t('attendance.noRecordsForScope'), true);
        return null;
    }

    const farmName = isAllFarms
        ? 'All Farms'
        : (state.farms.find(f => f.id === selectedFarm)?.name || selectedFarm);
    const rangeLabel = effectiveRange?.start === effectiveRange?.end
        ? formatDateToDDMMYYYY(effectiveRange.start)
        : `${formatDateToDDMMYYYY(effectiveRange.start)} - ${formatDateToDDMMYYYY(effectiveRange.end)}`;
    const confirmLabel = scope === 'all'
        ? `${t('clearAttendance.scopeAll')} (${farmName})`
        : `${farmName} / ${rangeLabel}`;

    return {
        selectedFarm,
        isAllFarms,
        farmName,
        scope,
        range: effectiveRange,
        datesToDelete,
        attendanceEntries,
        deletedSnapshot,
        confirmLabel,
        activityScope: scope === 'all'
            ? `${farmName} / ${t('clearAttendance.scopeAll')}`
            : `${farmName} / ${rangeLabel}`
    };
}

window.confirmAttendanceClear = function () {
    if (!currentUser?.isAdmin) return;
    const clearPlan = buildAttendanceClearPlan();
    if (!clearPlan) return;
    if (!confirm(t('attendance.clearConfirm', { date: clearPlan.confirmLabel }) || `Clear attendance for ${clearPlan.confirmLabel}? This cannot be undone.`)) return;

    const exported = exportWorkbook({
        fileName: `Attendance_Backup_${Date.now()}.xlsx`,
        farmsData: state.farms,
        workersData: state.workers,
        attendanceEntries: clearPlan.attendanceEntries
    });
    if (!exported) return;

    try {
        localStorage.setItem('farmWorkerDeletedAttendanceSnapshot', JSON.stringify({
            savedAt: Date.now(),
            scope: clearPlan.scope,
            farmId: clearPlan.selectedFarm,
            range: clearPlan.range,
            attendance: clearPlan.deletedSnapshot
        }));
    } catch (_error) {
        console.warn('Deleted attendance snapshot could not be saved.', _error);
    }

    // Delete attendance records for the selected farm(s) across the date range
    const nextAttendance = { ...(state.attendance || {}) };
    clearPlan.datesToDelete.forEach(date => {
        if (clearPlan.isAllFarms) {
            // Remove the entire day's attendance (all farms)
            delete nextAttendance[date];
        } else {
            const nextDateEntries = { ...(nextAttendance[date] || {}) };
            delete nextDateEntries[clearPlan.selectedFarm];
            if (Object.keys(nextDateEntries).length > 0) nextAttendance[date] = nextDateEntries;
            else delete nextAttendance[date];
        }
    });
    state.attendance = nextAttendance;

    // === PAYMENT DELETION FOR DATE RANGE ===
    // If checkbox is checked, also delete payment history entries in the range
    // and roll back each worker's paidAmount / loanAmount accordingly.
    const alsoDeletePayments = document.getElementById('clear-attendance-also-payments')?.checked !== false;
    if (alsoDeletePayments && clearPlan.range) {
        const rangeStart = clearPlan.range.start; // 'YYYY-MM-DD'
        const rangeEnd   = clearPlan.range.end;   // 'YYYY-MM-DD'

        if (Array.isArray(state.paymentHistory) && state.paymentHistory.length > 0) {
            const toDelete = state.paymentHistory.filter(entry => {
                const eDate = (entry.entryDate || '').slice(0, 10);
                return eDate >= rangeStart && eDate <= rangeEnd;
            });
            if (toDelete.length > 0) {
                // Rollback worker balances
                toDelete.forEach(entry => {
                    const w = state.workers.find(x => x.id === entry.workerId);
                    if (!w) return;
                    if (Number(entry.paidAmount) > 0) {
                        w.paidAmount = roundCurrency(Math.max(0, (w.paidAmount || 0) - entry.paidAmount));
                    }
                    if (Number(entry.addedLoanAmount) > 0) {
                        w.loanAmount = roundCurrency(Math.max(0, (w.loanAmount || 0) - entry.addedLoanAmount));
                    }
                });
                // Remove entries from paymentHistory
                const deletedIds = new Set(toDelete.map(e => e.id));
                state.paymentHistory = state.paymentHistory.filter(e => !deletedIds.has(e.id));
            }
        }

        // Remove settled periods overlapping the deleted date range
        state.workers = state.workers.map(w => {
            if (!Array.isArray(w.settledPeriods) || w.settledPeriods.length === 0) return w;
            const filtered = w.settledPeriods.filter(period => {
                const pStart = (period.start || period.from || '').slice(0, 10);
                const pEnd   = (period.end   || period.to   || '').slice(0, 10);
                return pEnd < rangeStart || pStart > rangeEnd;
            });
            return { ...w, settledPeriods: filtered };
        });
    }

    workerStatsCache.clear();
    logActivity(t('activity.clearedAttendance', { scope: clearPlan.activityScope }));

    // Persist to localStorage
    state = sanitizeStateForPersistence(state);
    const stateKey = currentUser?.isDemo ? 'farmWorkerState_demo' : 'farmWorkerState';
    try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch (_e) {
        console.warn('Local state save failed after payment confirmation.', _e);
    }

    // Immediate Firestore write; bypass the saveState debounce so the
    // deletion reaches the Firestore database right now, not after a delay.
    if (isHydrated && currentUser && !currentUser.isDemo) {
        clearTimeout(firestoreSyncTimer);
        syncStateToFirestore(state, { merge: false })
            .then(() => console.log('Attendance/payments deletion synced to Firestore.'))
            .catch(e => {
                console.error('Firestore deletion sync failed, queuing via saveState():', e);
                saveState(); // fallback
            });
    }

    window.toggleModal('clear-attendance-modal');
    renderAll();
    showToast(t('recovery.attendanceClearedSnapshot'));
};

window.restoreLastAttendanceSnapshot = function () {
    if (!currentUser?.isAdmin) return showToast(t('common.adminAccessRequired', true));
    let payload = null;
    try {
        payload = JSON.parse(localStorage.getItem('farmWorkerDeletedAttendanceSnapshot') || 'null');
    } catch (_error) {
        payload = null;
    }
    if (!payload?.attendance || typeof payload.attendance !== 'object') {
        return showToast(t('recovery.noLocalSnapshot', true));
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

window.updateFarmPaymentTotal = function () {
    const inputs = document.querySelectorAll('.farm-payment-input');
    let total = 0;
    inputs.forEach(inp => { total += parseFloat(inp.value) || 0; });
    const totalEl = document.getElementById('payment-farm-total');
    if (totalEl) totalEl.textContent = '\u20B9' + total.toFixed(2);
    const paidInput = document.getElementById('payment-add-paid');
    if (paidInput) paidInput.value = total > 0 ? total : '';
};

window.validatePaymentForm = function () {
    const id = document.getElementById('payment-worker-id').value;
    const w = state.workers.find(x => x.id === id);
    if (!w) return;

    const baseRemainingLoan = getWorkerLoanBalance(w);

    const deductLoanInput = document.getElementById('payment-deduct-loan');
    const addLoanInput = document.getElementById('payment-add-loan');
    const confirmBtn = document.querySelector('#payment-modal button[type="submit"]');

    const deductAmount = parseFloat(deductLoanInput?.value) || 0;
    const addAmount = parseFloat(addLoanInput?.value) || 0;

    let isValid = true;
    if (deductAmount > baseRemainingLoan || (baseRemainingLoan <= 0 && deductAmount > 0)) {
        if (deductLoanInput) {
            deductLoanInput.style.borderColor = '#DC2626';
            deductLoanInput.style.boxShadow = '0 0 0 3px rgba(220, 38, 38, 0.2)';
        }
        isValid = false;
    } else {
        if (deductLoanInput) {
            deductLoanInput.style.borderColor = '';
            deductLoanInput.style.boxShadow = '';
        }
    }

    const loanDisplay = document.getElementById('current-loan-display');
    if (loanDisplay) {
        // Dynamically update the displayed loan amount based on user input
        const dynamicRemainingLoan = Math.max(0, baseRemainingLoan + addAmount - deductAmount);
        loanDisplay.innerText = formatCurrency(dynamicRemainingLoan);
    }

    if (confirmBtn) confirmBtn.disabled = !isValid;
};

window.openPaymentModal = function (id) {
    const w = state.workers.find(x => x.id === id);
    if (!w) return;
    document.getElementById('payment-worker-id').value = id;
    const title = document.getElementById('payment-modal-title');
    if (title) title.innerText = `${t('paymentModal.logPaymentFor')}: ${w.name}`;
    const paidDisplay = document.getElementById('current-paid-display');
    if (paidDisplay) paidDisplay.innerText = formatCurrency(w.paidAmount || 0);
    const stats = calculateWorkerStats(id);
    const remainingLoan = getWorkerLoanBalance(w);

    const loanDisplay = document.getElementById('current-loan-display');
    if (loanDisplay) {
        loanDisplay.innerText = formatCurrency(remainingLoan);
    }

    const paidInput = document.getElementById('payment-add-paid');
    const loanInput = document.getElementById('payment-add-loan');
    const deductLoanInput = document.getElementById('payment-deduct-loan');
    const paidInputGroup = paidInput?.closest('.form-group');

    if (paidInput) paidInput.value = '';
    if (loanInput) loanInput.value = '';
    if (deductLoanInput) deductLoanInput.value = '';

    const deductLoanWrapper = document.getElementById('payment-deduct-loan-wrapper');
    if (deductLoanWrapper) {
        if (remainingLoan > 0) {
            deductLoanWrapper.style.display = 'flex';
            if (deductLoanInput) deductLoanInput.disabled = false;
        } else {
            deductLoanWrapper.style.display = 'none';
            if (deductLoanInput) deductLoanInput.disabled = true;
        }
    }

    if (deductLoanInput && !deductLoanInput.dataset.listenerAdded) {
        deductLoanInput.addEventListener('input', window.validatePaymentForm);
        deductLoanInput.dataset.listenerAdded = 'true';
    }
    if (loanInput && !loanInput.dataset.listenerAdded) {
        loanInput.addEventListener('input', window.validatePaymentForm);
        loanInput.dataset.listenerAdded = 'true';
    }
    setTimeout(window.validatePaymentForm, PAYMENT_VALIDATION_DELAY_MS);

    if (paidInputGroup) paidInputGroup.style.display = '';

    window.toggleModal('payment-modal');
};

window.settleWorkerPayment = function () {
    const id = document.getElementById('payment-worker-id').value;
    const w = state.workers.find(x => x.id === id);
    if (!w) return;

    const paid = parseFloat(document.getElementById('payment-add-paid').value) || 0;
    const addedLoan = parseFloat(document.getElementById('payment-add-loan').value) || 0;
    const deductLoan = parseFloat(document.getElementById('payment-deduct-loan').value) || 0;
    if (paid <= 0 && addedLoan <= 0 && deductLoan <= 0) return;

    const remainingLoan = getWorkerLoanBalance(w);

    if (deductLoan > remainingLoan || (remainingLoan <= 0 && deductLoan > 0)) {
        showToast(t('paymentModal.invalidDeduction') || "Invalid deduction: exceeds loan balance", true);
        return;
    }

    const previousPaidAmount = Number(w.paidAmount || 0) || 0;
    const previousLoanAmount = Number(w.loanAmount || 0) || 0;

    w.paidAmount = roundCurrency((w.paidAmount || 0) + paid + deductLoan);
    // addedLoan adds to loan, deductLoan reduces loan. Ensure loan doesn't go below 0
    w.loanAmount = Math.max(0, roundCurrency((w.loanAmount || 0) + addedLoan - deductLoan));

    if (paid > 0) {
        recordPaymentHistoryEntry(w, {
            type: 'payment',
            paidAmount: paid,
            previousPaidAmount,
            newPaidAmount: Number(w.paidAmount || 0) || 0,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0,
            note: 'Paid to worker'
        });
    }
    if (addedLoan > 0) {
        recordPaymentHistoryEntry(w, {
            type: 'loan_given',
            amount: addedLoan,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0
        });
    }
    if (deductLoan > 0) {
        recordPaymentHistoryEntry(w, {
            type: 'loan_deduction',
            amount: deductLoan,
            previousLoanAmount,
            newLoanAmount: Number(w.loanAmount || 0) || 0,
            note: 'Deducted from Loan using earnings'
        });
    }

    logActivity(t('activity.loggedPayment', { name: w.name, pay: paid, loan: addedLoan }));
    saveState();
    window.toggleModal('payment-modal');
    workerStatsCache.delete(id);
    renderPaymentsTable();
    renderDashboard();
    showToast(t('payments.paymentUpdated'));
};

window.openBreakdownModal = function (id) {
    const w = state.workers.find(x => x.id === id);
    if (!w) return;
    const s = calculateWorkerStats(id);
    document.getElementById('breakdown-modal-title').innerText = t('breakdown.titleWithWorker', { worker: w.name });

    const renderAttendancePreviewRow = item => {
        const previewLabel = item.label;
        return `
            <div style="display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border);">
                <div>
                    <div style="font-weight:600; color:var(--text-strong);">${escapeHtml(formatDateToDDMMYYYY(item.date))}</div>
                    <div style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(previewLabel)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:700; color:var(--primary);">${formatCurrency(item.amount)}</div>
                    <div style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(window.formatLocalizedDayCount ? window.formatLocalizedDayCount(item.days) : String(item.days))}</div>
                </div>
            </div>
        `;
    };

    const worker = state.workers.find(x => x.id === id);
    const settlementMeta = getWorkerSettlementMeta(worker);
    const extraWagesTotal = roundCurrency(
        (worker.overtime || [])
            .filter(entry => {
                const d = parseImportedDate(entry?.date);
                return !d || !isWorkerDateSettled(worker, d, settlementMeta);
            })
            .reduce((sum, entry) => sum + (Number(entry?.amount) || 0), 0)
    );

    let breakdownHtml = '<div style="margin-top:20px; border-top:1px solid var(--border); padding-top:16px;">';
    breakdownHtml += `<h4 style="margin-bottom:12px; color:var(--text-strong);">${t('breakdown.sectionTitle')}</h4>`;
    breakdownHtml += '<div style="display:grid; gap:12px;">';

    const farmBreakdown = Array.isArray(s.farmBreakdown) ? s.farmBreakdown : [];
    if (farmBreakdown.length) {
        breakdownHtml += farmBreakdown.map((farmSummary, index) => {
            const previewEntries = farmSummary.entries.slice(0, 3);
            const hiddenEntries = farmSummary.entries.slice(3);
            const domKey = toBreakdownDomKey(`${id}_${farmSummary.farmId || 'farm'}_${index}`);
            return `
                <div style="border:1px solid var(--border); border-radius:14px; background:var(--bg-1); padding:16px;">
                    <div style="display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:12px;">
                        <div>
                            <h5 style="margin:0 0 4px 0; color:var(--text-strong); font-size:1rem;">${escapeHtml(farmSummary.farmName)}</h5>
                            <div style="font-size:0.85rem; color:var(--text-muted);">
                                ${escapeHtml(t('payments.unpaidDays'))}: <strong>${escapeHtml(window.formatLocalizedDayCount ? window.formatLocalizedDayCount(farmSummary.displayDays) : String(farmSummary.displayDays))}</strong>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(t('payments.pending'))}</div>
                            <div style="font-size:1rem; font-weight:700; color:var(--primary);">${formatCurrency(farmSummary.displayAmount)}</div>
                        </div>
                    </div>
                    <div style="font-size:0.9rem;">${previewEntries.map(renderAttendancePreviewRow).join('')}</div>
                    ${hiddenEntries.length ? `
                        <div id="breakdown-extra-${domKey}" style="display:none; font-size:0.9rem;">${hiddenEntries.map(renderAttendancePreviewRow).join('')}</div>
                        <button
                            type="button"
                            id="breakdown-toggle-${domKey}"
                            class="btn btn-secondary"
                            data-expanded="false"
                            style="margin-top:12px; width:100%;"
                            onclick="window.toggleBreakdownAttendance('${domKey}')"
                        >${escapeHtml(t('common.showMore'))}</button>
                    ` : ''}
                </div>
            `;
        }).join('');
    } else {
        breakdownHtml += `<p style="color:var(--text-muted); padding:10px 0;">${t('breakdown.noAttendance')}</p>`;
    }

    if (extraWagesTotal > 0) {
        breakdownHtml += `
            <div style="border:1px dashed var(--border); border-radius:14px; background:var(--bg-1); padding:16px;">
                <div style="display:flex; justify-content:space-between; gap:16px; align-items:center;">
                    <div>
                        <h5 style="margin:0 0 4px 0; color:var(--text-strong); font-size:1rem;">${escapeHtml(t('breakdown.extraWages'))}</h5>
                        <div style="font-size:0.85rem; color:var(--text-muted);">${escapeHtml(t('payments.pending'))}</div>
                    </div>
                    <div style="font-size:1rem; font-weight:700; color:var(--primary);">${formatCurrency(extraWagesTotal)}</div>
                </div>
            </div>
        `;
    }

    breakdownHtml += '</div></div>';

    document.getElementById('breakdown-content').innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
            <p>${t('payments.unpaidDays')}: <strong>${window.formatCountValue ? window.formatCountValue(s.unpaidDays) : s.unpaidDays}</strong></p>
            <p>${t('payments.earned')}: <strong>${formatCurrency(s.unpaidEarnings)}</strong></p>
            <p>${t('workerModal.initialDebt')}: <strong>${formatCurrency(s.initialDebt)}</strong></p>
            <p>${t('payments.paid')}: <strong>${formatCurrency(s.paidAmount)}</strong></p>
            <p>${t('payments.loans')}: <strong>${formatCurrency(Math.max(0, s.loanAmount || 0))}</strong></p>
        </div>
        <p style="margin-top:12px; font-size:1.1rem; color:var(--primary); border-top:1px solid var(--border); padding-top:12px;">${t('payments.unpaidBalance')}: <strong>${formatCurrency(s.pendingAmount)}</strong></p>
        ${breakdownHtml}
    `;
    window.toggleModal('breakdown-modal');
};

window.toggleBreakdownAttendance = function (domKey) {
    const extraRows = document.getElementById(`breakdown-extra-${domKey}`);
    const toggleButton = document.getElementById(`breakdown-toggle-${domKey}`);
    if (!extraRows || !toggleButton) return;
    const expanded = toggleButton.getAttribute('data-expanded') === 'true';
    extraRows.style.display = expanded ? 'none' : 'block';
    toggleButton.setAttribute('data-expanded', expanded ? 'false' : 'true');
    toggleButton.textContent = expanded ? t('common.showMore') : t('common.showLess');
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
    const previousLanguage = currentUser.language || window.appLanguage || 'en';
    const allowedThemes = getAllowedThemes(currentUser);
    const selectedTheme = document.getElementById('profile-theme')?.value || localStorage.getItem('appTheme') || allowedThemes[0] || 'light';
    const data = {
        fullName: document.getElementById('profile-name')?.value.trim() || '',
        phone: document.getElementById('profile-phone')?.value.trim() || '',
        language: document.getElementById('profile-language')?.value || currentUser.language || 'en',
        theme: allowedThemes.includes(selectedTheme) ? selectedTheme : (allowedThemes[0] || 'light'),
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
        applyTheme(data.theme); // Update theme immediately
        if (data.language !== previousLanguage) setLanguage(data.language, { rerender: true });
        const successMessage = t('profile.saved');
        if (profileStatus) {
            profileStatus.innerText = successMessage;
            profileStatus.style.display = 'none';
            profileStatus.style.color = '#059669';
        }
        window.activateSection('dashboard');
        updateGreetings();
        showToast(successMessage);
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
    if (!currentUser?.isAdmin) return showToast(t('admin.onlyAdminsClearPayments', true));
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
        const mainData = sanitizeStateForPersistence(JSON.parse(localStorage.getItem('farmWorkerState') || '{}'));
        const demoData = sanitizeStateForPersistence(JSON.parse(localStorage.getItem('farmWorkerState_demo') || '{}'));
        const googleSheetsConfig = sanitizeGoogleSheetsConfig(
            mainData.googleSheetsConfig || demoData.googleSheetsConfig,
            getLegacyGoogleSheetsConfig()
        );
        const backupData = {
            timestamp: new Date().toISOString(),
            mainData,
            demoData,
            googleSheetsConfig,
            webhookUrl: googleSheetsConfig.webhookUrl,
            lastSync: googleSheetsConfig.lastSyncAt,
            version: APP_VERSION
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
                const restoredGoogleSheetsConfig = sanitizeGoogleSheetsConfig(
                    backup.googleSheetsConfig,
                    {
                        webhookUrl: backup.webhookUrl,
                        lastSyncAt: backup.lastSync
                    }
                );
                if (backup.mainData) {
                    const restoredMainData = sanitizeStateForPersistence({
                        ...backup.mainData,
                        googleSheetsConfig: restoredGoogleSheetsConfig
                    });
                    localStorage.setItem('farmWorkerState', JSON.stringify(restoredMainData));
                }
                if (backup.demoData) {
                    const restoredDemoData = sanitizeStateForPersistence({
                        ...backup.demoData,
                        googleSheetsConfig: restoredGoogleSheetsConfig
                    });
                    localStorage.setItem('farmWorkerState_demo', JSON.stringify(restoredDemoData));
                }
                syncLegacyGoogleSheetsStorage(restoredGoogleSheetsConfig);

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
    initializeLoginPasswordToggle();
    normalizeEnglishUiCopies();
    setLanguage(session?.language || window.getStoredLanguage?.() || 'en', { rerender: false });
    sanitizeStaticUiText();
    let savedTheme = document.documentElement.getAttribute('data-theme') || 'light';
    try { savedTheme = localStorage.getItem('appTheme') || savedTheme; } catch (_error) {
        console.warn('Unable to read saved theme; using default.', _error);
    }
    applyTheme(savedTheme);
    if (session) {
        currentUser = session;
        const allowedT = getAllowedThemes(currentUser);

        let activeTheme = currentUser.theme || localStorage.getItem('appTheme') || 'light';
        if (!allowedT.includes(activeTheme)) activeTheme = allowedT[0] || 'light';

        applyTheme(activeTheme);

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
        btn.addEventListener('click', () => {
            window.activateSection(btn.getAttribute('data-target'));
            window.closeMobileSidebar();
        });
    });

    // Set default attendance date if not set
    const attDate = document.getElementById('attendance-date');
    if (attDate && !attDate.value) attDate.value = getTodayLocalISO();
    const attDateEnd = document.getElementById('attendance-date-end');
    if (attDateEnd && !attDateEnd.value) attDateEnd.value = getTodayLocalISO();
    if (attDateEnd) {
        attDateEnd.addEventListener('change', () => {
            renderAttendanceSummary();
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

    // Bug 5 fix: The payment-settle-attendance checkbox and payment-settle-date-container
    // were non-functional (empty container, no settlement logic in settleWorkerPayment).
    // The event listener and the empty shell div have been removed to avoid confusing users.

    // Initialize recovery file input
    const restoreInput = document.getElementById('restore-file-input');
    if (restoreInput) restoreInput.addEventListener('change', window.restoreFromBackup);

    // Check data integrity on page load
    setTimeout(() => {
        if (!window.checkDataOnLoad()) {

        }
    }, 1000);

    // Absolute last-resort: hide splash after 5 seconds no matter what
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash && splash.style.display !== 'none') {
            showLoading(false);
            if (!isHydrated) {
                isHydrated = true;
                renderAll();
            }
        }
    }, 5000);
});

function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.innerHTML =
        '<span class="toast-icon">' + (isError ? '&#9888;' : '&#10003;') + '</span>' +
        '<span>' + escapeHtml(message) + '</span>';
    container.appendChild(toast);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { toast.classList.add('active'); });
    });
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

window.showToast = showToast;

function updateGreetings() {
    const greetEl = document.querySelector('.greeting-text');
    if (!greetEl || !currentUser) return;
    const name = currentUser.fullName || currentUser.username || '';
    greetEl.innerText = name
        ? t('dashboard.greeting', { name })
        : t('dashboard.overview');
}
