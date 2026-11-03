/**
 * ============================================================================
 * DRAGON STORE - WEB ADMIN PANEL DATA STORE
 * Module: JSON-backed Storage Layer for Admin Panel (Employees/Chats/Labels)
 * File: Engine/webStore.js
 * Author: Dragon Store Development Team
 * Description: Layer penyimpanan data untuk panel admin website. Semua data
 *              disimpan sebagai file JSON di folder /data (gaya database yang
 *              sama seperti replied_contacts.json). Password karyawan disimpan
 *              terenkripsi (AES-256-CBC) agar owner dapat melihatnya kembali.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// KONSTANTA PATH & KONFIGURASI
// ============================================================================

const DATA_DIR = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(__dirname, '../uploads');

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const EMPLOYEES_PATH = path.join(DATA_DIR, 'employees.json');
const LABELS_PATH = path.join(DATA_DIR, 'labels.json');
const CHATS_PATH = path.join(DATA_DIR, 'chats.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const OTP_PATH = path.join(DATA_DIR, 'otps.json');
const SECRET_PATH = path.join(DATA_DIR, '.secret');

const META_PATH = path.join(DATA_DIR, 'meta.json');

const DEFAULT_SETTINGS = { autoReply: true, autoBroadcast: true };

// Nomor owner (nomor Indonesia, dinormalisasi ke format 62)
const OWNER_PHONE = normalizePhone(process.env.OWNER_NUMBER || '085760933268');

// Sesi login web bertahan selama 7 hari
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// OTP bertahan 5 menit
const OTP_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// HELPER NOMOR & JID
// ============================================================================

/**
 * Normalisasi nomor telepon Indonesia (08... atau +62... atau 62...) ke 62...
 * @param {string} rawNumber
 * @returns {string|null} Nomor ternormalisasi atau null jika tidak valid.
 */
function normalizePhone(rawNumber) {
    if (!rawNumber || typeof rawNumber !== 'string') return null;
    let clean = rawNumber.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) clean = '62' + clean.slice(1);
    if (clean.length < 8 || clean.length > 15) return null;
    return clean;
}

/**
 * Mengubah nomor ternormalisasi (62...) menjadi JID WhatsApp.
 * @param {string} phoneNumber
 * @returns {string}
 */
function numberToJid(phoneNumber) {
    return `${phoneNumber}@s.whatsapp.net`;
}

/**
 * Mengekstrak nomor mentah dari sebuah JID.
 * @param {string} jid
 * @returns {string|null}
 */
function numberFromJid(jid) {
    if (!jid || typeof jid !== 'string') return null;
    const local = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return local || null;
}

/**
 * Menampilkan nomor 62... dalam bentuk 08... untuk UI.
 * @param {string} phoneNumber
 * @returns {string}
 */
function displayNumber(phoneNumber) {
    if (phoneNumber && phoneNumber.startsWith('62')) return '0' + phoneNumber.slice(2);
    return phoneNumber || '-';
}

// ============================================================================
// LOW LEVEL FILE HELPERS
// ============================================================================

function readFileJson(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || raw.trim() === '') return fallbackValue;
        return JSON.parse(raw);
    } catch (error) {
        console.error(`[WEB-STORE] Gagal membaca ${path.basename(filePath)}:`, error.message);
        return fallbackValue;
    }
}

function writeFileJson(filePath, dataObject) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(dataObject, null, 2), 'utf8');
    } catch (error) {
        console.error(`[WEB-STORE] Gagal menulis ${path.basename(filePath)}:`, error.message);
    }
}

function ensureDataDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ============================================================================
// KUNCI ENKRIPSILOKAL (UNTUK MEMBACA ULANG PASSWORD OLEH OWNER)
// ============================================================================

function getSecretKey() {
    try {
        if (!fs.existsSync(SECRET_PATH)) {
            ensureDataDirs();
            fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString('hex'), 'utf8');
        }
        const raw = fs.readFileSync(SECRET_PATH, 'utf8').trim();
        return crypto.createHash('sha256').update(raw).digest();
    } catch (error) {
        console.error('[WEB-STORE] Gagal menyiapkan secret key:', error.message);
        return crypto.createHash('sha256').update('fallback-key').digest();
    }
}

/** Enkripsi teks password untuk penyimpanan (format iv:cipher hex). */
function encryptText(plainText) {
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', getSecretKey(), iv);
        const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
        return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
        return '';
    }
}

/** Dekripsi kembali teks password agar bisa dilihat oleh owner. */
function decryptText(cipherText) {
    try {
        if (!cipherText || typeof cipherText !== 'string' || !cipherText.includes(':')) return null;
        const [ivHex, dataHex] = cipherText.split(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', getSecretKey(), Buffer.from(ivHex, 'hex'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (error) {
        return null;
    }
}

/** Hash password (scrypt) dengan salt acak per akun. */
function hashPassword(plainTextPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(plainTextPassword), salt, 64).toString('hex');
    return `${salt}:${derived}`;
}

/** Verifikasi password terhadap hash. */
function verifyPassword(plainTextPassword, storedHash) {
    try {
        if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
        const [salt, expected] = storedHash.split(':');
        const derived = crypto.scryptSync(String(plainTextPassword), salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));
    } catch (error) {
        return false;
    }
}

// ============================================================================
// SETTINGS (TOGGLE AUTO REPLY / AUTO BROADCAST)
// ============================================================================

function getSettings() {
    const stored = readFileJson(SETTINGS_PATH, DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
}

function updateSettings(partialSettings) {
    const current = getSettings();
    const merged = {
        autoReply: typeof partialSettings.autoReply === 'boolean' ? partialSettings.autoReply : current.autoReply,
        autoBroadcast: typeof partialSettings.autoBroadcast === 'boolean' ? partialSettings.autoBroadcast : current.autoBroadcast
    };
    writeFileJson(SETTINGS_PATH, merged);
    return merged;
}

/** Tombol "Reset semua data" di Setting: hanya mengembalikan settingan ke default. */
function resetSettingsToDefault() {
    writeFileJson(SETTINGS_PATH, { ...DEFAULT_SETTINGS });
    return getSettings();
}

// ============================================================================
// META (WAKTU TERAKHIR TERTAUT)
// ============================================================================

function getMeta() {
    return readFileJson(META_PATH, { lastLinkedAt: null });
}

function setMeta(patchObject) {
    const merged = { ...getMeta(), ...patchObject };
    writeFileJson(META_PATH, merged);
    return merged;
}

// ============================================================================
// EMPLOYEES (KARYAWAN + OWNER)
// ============================================================================

function listEmployees() {
    return readFileJson(EMPLOYEES_PATH, []);
}

function saveEmployees(employeeList) {
    writeFileJson(EMPLOYEES_PATH, employeeList);
}

function findEmployeeByPhone(phoneNumber) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) return null;
    return listEmployees().find((emp) => emp.phone === normalized) || null;
}

/**
 * Mendaftarkan karyawan baru (status awal "unactivated").
 * @param {Object} params
 * @returns {Object|null} Karyawan baru atau null jika nomor tidak valid.
 */
function createEmployee({ phone, role, addedBy }) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    if (findEmployeeByPhone(normalized)) return null;

    const employee = {
        phone: normalized,
        role: role === 'owner' ? 'owner' : 'karyawan',
        status: 'unactivated',
        username: '',
        passwordHash: '',
        passwordEnc: '',
        createdAt: Date.now(),
        activatedAt: null,
        addedBy: addedBy || ''
    };

    const employees = listEmployees();
    employees.push(employee);
    saveEmployees(employees);
    return employee;
}

function updateEmployee(phoneNumber, patchObject) {
    const normalized = normalizePhone(phoneNumber);
    const employees = listEmployees();
    const index = employees.findIndex((emp) => emp.phone === normalized);
    if (index === -1) return null;

    employees[index] = { ...employees[index], ...patchObject, phone: normalized };
    saveEmployees(employees);
    return employees[index];
}

function removeEmployee(phoneNumber) {
    const normalized = normalizePhone(phoneNumber);
    const employees = listEmployees();
    const filtered = employees.filter((emp) => emp.phone !== normalized);
    if (filtered.length === employees.length) return false;
    saveEmployees(filtered);
    return true;
}

/** Publikasi data karyawan untuk halaman Karyawan (owner). Termasuk password yang bisa dilihat. */
function getEmployeeListItem(employee) {
    return {
        phone: employee.phone,
        displayPhone: displayNumber(employee.phone),
        role: employee.role,
        status: employee.status,
        username: employee.username || '',
        hasPassword: Boolean(employee.passwordHash),
        passwordPlain: employee.passwordHash ? (decryptText(employee.passwordEnc) || '••••••') : '',
        createdAt: employee.createdAt || null,
        activatedAt: employee.activatedAt || null
    };
}

// ============================================================================
// LABELS
// ============================================================================

const LABEL_COLORS = ['#22c55e', '#38bdf8', '#a78bfa', '#f472b6', '#f59e0b', '#34d399', '#f87171', '#fb923c', '#60a5fa'];

function listLabels() {
    return readFileJson(LABELS_PATH, []);
}

function saveLabels(labelList) {
    writeFileJson(LABELS_PATH, labelList);
}

function findLabelById(labelId) {
    return listLabels().find((label) => label.id === labelId) || null;
}

function createLabel(name, isSystem) {
    const cleanName = String(name || '').trim().slice(0, 32);
    if (!cleanName) return null;

    const labels = listLabels();
    const existing = labels.find((label) => label.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) return existing;

    const label = {
        id: 'lbl_' + crypto.randomBytes(6).toString('hex'),
        name: cleanName,
        color: LABEL_COLORS[labels.length % LABEL_COLORS.length],
        system: Boolean(isSystem),
        createdAt: Date.now()
    };
    labels.push(label);
    saveLabels(labels);
    return label;
}

/** Label otomatis per role: karyawan pertama kali chat dengan customer baru. */
function ensureRoleLabel(role) {
    const roleName = role === 'owner' ? 'Service Owner' : 'Service Worker';
    const labels = listLabels();
    const existing = labels.find((label) => label.system && label.name === roleName);
    if (existing) return existing;
    return createLabel(roleName, true);
}

// ============================================================================
// CHATS (CUSTOMER + PESAN FORWARD)
// ============================================================================

function loadChatsDatabase() {
    return readFileJson(CHATS_PATH, { contacts: {}, messages: {} });
}

function saveChatsDatabase(databaseObject) {
    writeFileJson(CHATS_PATH, databaseObject);
}

/**
 * Mengambil atau membuat kontak customer.
 * @param {Object} params
 */
function upsertContact({ jid, number, name }) {
    const database = loadChatsDatabase();
    let contact = database.contacts[jid];

    if (!contact) {
        contact = {
            jid,
            number: number || numberFromJid(jid) || '',
            name: name || '',
            labels: [],
            createdAt: Date.now()
        };
        database.contacts[jid] = contact;
    } else if (name && contact.name !== name) {
        // Update nama terbaru (pushName) dari WhatsApp
        contact.name = name;
    }

    if (number && !contact.number) contact.number = number;

    saveChatsDatabase(database);
    return contact;
}

function getContact(jid) {
    const database = loadChatsDatabase();
    return database.contacts[jid] || null;
}

function updateContact(jid, patchObject) {
    const database = loadChatsDatabase();
    const contact = database.contacts[jid];
    if (!contact) return null;
    const updated = { ...contact, ...patchObject, jid };
    database.contacts[jid] = updated;
    saveChatsDatabase(database);
    return updated;
}

function listContactsWithPreview() {
    const database = loadChatsDatabase();
    return Object.values(database.contacts)
        .map((contact) => {
            const messages = database.messages[contact.jid] || [];
            const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
            return { ...contact, messageCount: messages.length, lastMessage };
        })
        .sort((a, b) => ((b.lastMessage?.at) || b.createdAt) - ((a.lastMessage?.at) || a.createdAt));
}

function countContacts() {
    const database = loadChatsDatabase();
    return Object.keys(database.contacts).length;
}

function appendMessage(jid, messageRecord) {
    const database = loadChatsDatabase();
    if (!database.messages[jid]) database.messages[jid] = [];
    database.messages[jid].push(messageRecord);

    // Batasi memori chat per kontak (simpan 300 pesan terakhir)
    if (database.messages[jid].length > 300) {
        database.messages[jid] = database.messages[jid].slice(-300);
    }

    saveChatsDatabase(database);
    return messageRecord;
}

function listMessages(jid) {
    const database = loadChatsDatabase();
    return (database.messages[jid] || []).slice(-100);
}

// ============================================================================
// OTP AKTIVASI / LOGIN
// ============================================================================

function setOtpCode(phoneNumber, plainCode) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) return false;
    const data = readFileJson(OTP_PATH, {});
    data[normalized] = {
        hash: hashPassword(plainCode),
        expiresAt: Date.now() + OTP_TTL_MS
    };
    writeFileJson(OTP_PATH, data);
    return true;
}

function verifyOtpCode(phoneNumber, plainCode) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) return false;
    const data = readFileJson(OTP_PATH, {});
    const record = data[normalized];
    if (!record) return false;
    if (Date.now() > record.expiresAt) {
        delete data[normalized];
        writeFileJson(OTP_PATH, data);
        return false;
    }
    const isValid = verifyPassword(plainCode, record.hash);
    if (isValid) {
        // OTP bersifat sekali pakai
        delete data[normalized];
        writeFileJson(OTP_PATH, data);
    }
    return isValid;
}

function clearOtp(phoneNumber) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) return;
    const data = readFileJson(OTP_PATH, {});
    delete data[normalized];
    writeFileJson(OTP_PATH, data);
}

// ============================================================================
// SESSIONS WEB (TOKEN LOGIN)
// ============================================================================

function createSession(phoneNumber, role) {
    const token = crypto.randomBytes(32).toString('hex');
    const data = readFileJson(SESSIONS_PATH, {});
    data[token] = {
        phone: normalizePhone(phoneNumber),
        role,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS
    };
    writeFileJson(SESSIONS_PATH, data);
    return token;
}

function getSession(token) {
    if (!token || typeof token !== 'string') return null;
    const data = readFileJson(SESSIONS_PATH, {});
    const record = data[token];
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
        delete data[token];
        writeFileJson(SESSIONS_PATH, data);
        return null;
    }
    return record;
}

function deleteSession(token) {
    if (!token) return false;
    const data = readFileJson(SESSIONS_PATH, {});
    if (!data[token]) return false;
    delete data[token];
    writeFileJson(SESSIONS_PATH, data);
    return true;
}

// ============================================================================
// INISIALISASI (SEED AKUN OWNER)
// ============================================================================

function initWebStore() {
    ensureDataDirs();

    // Seed akun owner (nomor tetap). Owner memulai dengan status "unactivated"
    // sehingga lewat proses aktivasi yang sama dengan karyawan.
    if (OWNER_PHONE && !findEmployeeByPhone(OWNER_PHONE)) {
        createEmployee({ phone: OWNER_PHONE, role: 'owner', addedBy: 'system' });
        console.log(`[WEB-STORE] Akun owner berhasil di-seed untuk nomor ${displayNumber(OWNER_PHONE)}`);
    }
}

module.exports = {
    OWNER_PHONE,
    DEFAULT_SETTINGS,
    initWebStore,
    normalizePhone,
    numberToJid,
    numberFromJid,
    displayNumber,
    getSettings,
    updateSettings,
    resetSettingsToDefault,
    getMeta,
    setMeta,
    listEmployees,
    findEmployeeByPhone,
    createEmployee,
    updateEmployee,
    removeEmployee,
    getEmployeeListItem,
    listLabels,
    findLabelById,
    createLabel,
    ensureRoleLabel,
    upsertContact,
    getContact,
    updateContact,
    listContactsWithPreview,
    countContacts,
    appendMessage,
    listMessages,
    setOtpCode,
    verifyOtpCode,
    clearOtp,
    createSession,
    getSession,
    deleteSession,
    hashPassword,
    verifyPassword,
    encryptPasswordForOwner: encryptText,
    decryptOwnerPassword: decryptText
};
