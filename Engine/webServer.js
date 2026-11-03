/**
 * ============================================================================
 * DRAGON STORE - WEB ADMIN PANEL HTTP/WEBSOCKET SERVER
 * Module: Express Server + Socket.IO Bridge for WhatsApp Forwarding
 * File: Engine/webServer.js
 * Author: Dragon Store Development Team
 * Description: Server panel admin Dragon Store. Meneruskan SEMUA chat dari
 *              nomor bisnis (termasuk foto/media) ke website, menyediakan
 *              auth OTP via WhatsApp, toggle Setting, Status bot serta QR
 *              scan ulang khusus owner.
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const { Server: IOServer } = require('socket.io');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./webStore');

// ============================================================================
// RUNTIME STATE
// ============================================================================

let activeSocketGetter = () => null;
let ioInstance = null;

// Status koneksi bot (dikontrol dari index.js lewat setter)
const runtimeState = {
    linked: false,
    qr: null,            // String QR mentah dari Baileys
    qrGeneratedAt: null,
    latencyMs: null,
    startedAt: Date.now()
};

// Token aktivasi sementara setelah OTP cocok (10 menit)
const activationTokens = new Map();

// Cache deduplikasi forward pesan (hindari duplikat saat reconnect)
const forwardedMessageIds = new Map();

const OTP_MESSAGE_TEMPLATE = (code) => (
    `🔐 *DRAGON STORE*\n\n` +
    `Kode OTP verifikasi Anda:\n*${code}*\n\n` +
    `Kode berlaku 5 menit. Jangan bagikan kode ini ke siapa pun, termasuk orang yang mengaku admin!`
);

// ============================================================================
// HELPER CONNECTION
// ============================================================================

function getActiveSocket() {
    try {
        return activeSocketGetter() || null;
    } catch (error) {
        return null;
    }
}

function setLinked(isLinked) {
    if (runtimeState.linked !== isLinked) {
        runtimeState.linked = Boolean(isLinked);
        broadcast('state', { linked: runtimeState.linked });
    }
}

function setQr(qrString) {
    runtimeState.qr = qrString || null;
    runtimeState.qrGeneratedAt = qrString ? Date.now() : null;
}

/** Pengukuran latency WebSocket tiap 30 detik - hanya aktif saat terhubung. */
function startLatencyPoller() {
    setInterval(() => {
        const sock = getActiveSocket();
        if (!sock || !runtimeState.linked || !sock.ws || typeof sock.ws.ping !== 'function') {
            runtimeState.latencyMs = null;
            return;
        }
        try {
            const started = Date.now();
            sock.ws.ping(() => {
                runtimeState.latencyMs = Date.now() - started;
            });
        } catch (error) {
            runtimeState.latencyMs = null;
        }
    }, 30000);
}

function broadcast(event, payload) {
    if (ioInstance) ioInstance.emit(event, payload);
}

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

function extractToken(request) {
    const header = request.headers.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7);
    return null;
}

function requireAuth(request, response, next) {
    const session = store.getSession(extractToken(request));
    if (!session) {
        return response.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
    }
    request.authSession = session;
    next();
}

function requireOwner(request, response, next) {
    if (!request.authSession || request.authSession.role !== 'owner') {
        return response.status(403).json({ error: 'Fitur ini khusus owner.' });
    }
    next();
}

// ============================================================================
// FORWARD PESAN WHATSAPP -> WEBSITE
// ============================================================================

function unwrapMessageContent(messageContent) {
    let content = messageContent || {};
    if (content.ephemeralMessage && content.ephemeralMessage.message) {
        content = content.ephemeralMessage.message;
    }
    if (content.ephemeralView && content.ephemeralView.message) {
        content = content.ephemeralView.message;
    }
    if (content.viewOnceMessage && content.viewOnceMessage.message) {
        content = content.viewOnceMessage.message;
    }
    if (content.viewOnceMessageV2 && content.viewOnceMessageV2.message) {
        content = content.viewOnceMessageV2.message;
    }
    return content;
}

function detectMessageTypeAndText(content) {
    if (!content) return { type: 'unknown', text: '' };

    if (typeof content.conversation === 'string') {
        return { type: 'text', text: content.conversation };
    }
    if (content.extendedTextMessage && typeof content.extendedTextMessage.text === 'string') {
        return { type: 'text', text: content.extendedTextMessage.text };
    }
    if (content.imageMessage) {
        return { type: 'image', text: content.imageMessage.caption || '' };
    }
    if (content.videoMessage) {
        return { type: 'video', text: content.videoMessage.caption || '' };
    }
    if (content.audioMessage) {
        return { type: 'audio', text: '' };
    }
    if (content.stickerMessage) {
        return { type: 'sticker', text: '' };
    }
    if (content.documentMessage) {
        return { type: 'document', text: content.documentMessage.caption || '' };
    }
    if (content.contactMessage) {
        return { type: 'contact', text: content.contactMessage.displayName || 'Kontak' };
    }
    if (content.locationMessage) {
        return { type: 'location', text: 'Lokasi' };
    }
    if (content.reactionMessage) {
        return { type: 'reaction', text: content.reactionMessage.text || '' };
    }

    const firstKey = Object.keys(content)[0];
    return { type: firstKey ? firstKey.replace('Message', '').toLowerCase() : 'unknown', text: '' };
}

function guessMediaExtension(type, content) {
    if (type === 'image') return 'jpg';
    if (type === 'video') return 'mp4';
    if (type === 'audio') return 'ogg';
    if (type === 'sticker') return 'webp';
    if (type === 'document') {
        const fileName = content?.documentMessage?.mimetype;
        if (fileName && fileName.includes('/')) {
            const ext = fileName.split('/')[1].split(';')[0];
            if (ext && ext.length < 6) return ext;
        }
        return 'pdf';
    }
    return 'bin';
}

/**
 * Forward SEMUA pesan personal (incoming maupun outgoing) ke panel web.
 * Dipanggil dari index.js pada event messages.upsert.
 * @param {Object} sock - Socket Baileys aktif.
 * @param {Object} upsertPayload - Payload messages.upsert.
 */
async function forwardIncomingMessages(sock, upsertPayload) {
    try {
        if (!upsertPayload || !upsertPayload.messages || !Array.isArray(upsertPayload.messages)) return;
        if (upsertPayload.type && upsertPayload.type !== 'notify') return;

        for (const incoming of upsertPayload.messages) {
            if (!incoming || !incoming.key) continue;

            const remoteJid = incoming.key.remoteJid;
            if (!remoteJid) continue;
            if (
                remoteJid === 'status@broadcast' ||
                remoteJid.endsWith('@g.us') ||
                remoteJid.endsWith('@newsletter')
            ) continue;

            // Deduplikasi ID pesan dalam 5 menit
            const messageId = incoming.key.id;
            if (messageId) {
                if (forwardedMessageIds.has(messageId)) continue;
                forwardedMessageIds.set(messageId, Date.now());
            }
            if (forwardedMessageIds.size > 1000) {
                const now = Date.now();
                for (const [key, timestamp] of forwardedMessageIds.entries()) {
                    if (now - timestamp > 5 * 60 * 1000) forwardedMessageIds.delete(key);
                }
            }

            const content = unwrapMessageContent(incoming.message);
            const { type, text } = detectMessageTypeAndText(content);

            // Simpan media (foto/video/audio/sticker/dokumen) - semua diteruskan
            let mediaFile = null;
            const isMediaType = !['text', 'unknown', 'contact', 'location'].includes(type);
            if (isMediaType && sock) {
                try {
                    const mediaBuffer = await downloadMediaMessage(incoming, { requeueRequestTime: 2000 });
                    if (mediaBuffer) {
                        const extension = guessMediaExtension(type, content);
                        const fileName = `${messageId || crypto.randomBytes(6).toString('hex')}.${extension}`;
                        fs.writeFileSync(path.join(store_uploadsDir(), fileName), mediaBuffer);
                        mediaFile = fileName;
                    }
                } catch (mediaError) {
                    console.warn('[WEB-SERVER] Gagal mengunduh media forward:', mediaError.message);
                }
            }

            const contactName = upsertPayload.pushName || '';
            const contact = store.upsertContact({ jid: remoteJid, name: contactName });

            const messageRecord = {
                id: messageId || crypto.randomBytes(8).toString('hex'),
                fromMe: Boolean(incoming.key.fromMe),
                type,
                text,
                media: mediaFile,
                at: Number(incoming.messageTimestamp) * 1000 || Date.now(),
                viaWeb: false
            };

            store.appendMessage(remoteJid, messageRecord);
            broadcast('chat:msg', { jid: remoteJid, contact, message: messageRecord });
            broadcast('chats:updated');
        }
    } catch (error) {
        console.error('[WEB-SERVER] Error forwarding pesan ke web:', error.message);
    }
}

function store_uploadsDir() {
    return path.join(__dirname, '../uploads');
}

// ============================================================================
// API: AUTH (LOGIN & AKTIVASI)
// ============================================================================

/** Cek nomor: apakah terdaftar, unactivated / active, dan apakah login diblokir karena bot tidak tertaut. */
function buildAuthCheckResult(employee) {
    if (!employee) {
        return { found: false };
    }
    const isOwner = employee.role === 'owner';
    if (!runtimeState.linked && !isOwner) {
        // Karyawan mencoba login saat bot tidak tertaut
        return { found: true, blocked: 'unlinked', message: 'Nomor tidak tertaut, hubungi owner' };
    }
    return { found: true, status: employee.status, role: employee.role, blocked: null };
}

async function sendOtpViaWhatsapp(phoneNumber) {
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    store.setOtpCode(phoneNumber, otpCode);

    const sock = getActiveSocket();
    if (!sock || !runtimeState.linked) {
        throw new Error('NOMOR_BELUM_TERTAUT');
    }

    const sendResult = await sock.sendMessage(store.numberToJid(phoneNumber), {
        text: OTP_MESSAGE_TEMPLATE(otpCode)
    });

    console.log(`[WEB-SERVER] OTP untuk ${store.displayNumber(phoneNumber)} terkirim ke WhatsApp (messageId: ${sendResult?.key?.id || 'n/a'})`);
    return otpCode;
}

/**
 * Issue sesi penuh atau token aktivasi + OTP.
 * Dipakai pada flow login maupun pembuatan password pertama kali.
 */
async function proceedVerificationStage(employee, response) {
    const isOwner = employee.role === 'owner';

    // Owner saat bot tidak tertaut: lewat tanpa OTP agar bisa login trus scan QR
    if (isOwner && !runtimeState.linked) {
        const token = store.createSession(employee.phone, employee.role);
        return response.json({ ok: true, otpRequired: false, skippedOtp: true, token });
    }

    try {
        await sendOtpViaWhatsapp(employee.phone);
        return response.json({ ok: true, otpRequired: true });
    } catch (error) {
        if (error.message === 'NOMOR_BELUM_TERTAUT') {
            return response.status(503).json({
                error: 'Nomor tidak tertaut, hubungi owner'
            });
        }
        console.error('[WEB-SERVER] Gagal mengirim OTP via WhatsApp:', error.message);
        return response.status(502).json({
            error: 'Gagal mengirim OTP ke WhatsApp (koneksi bot sedang tidak stabil). Coba lagi beberapa detik.'
        });
    }
}

function registerApiRoutes(app) {
    app.use(express.json({ limit: '2mb' }));

    // ----- AUTH -----

    app.post('/api/auth/check', (request, response) => {
        const { phone } = request.body || {};
        const normalized = store.normalizePhone(phone);
        if (!normalized) {
            return response.status(400).json({ error: 'Nomor telepon Indonesia tidak valid.' });
        }
        const employee = store.findEmployeeByPhone(normalized);
        const result = buildAuthCheckResult(employee);
        if (result.found && (result.status || result.role)) result.displayPhone = store.displayNumber(normalized);
        return response.json(result);
    });

    /** Flow unactivated: buat password + confirm password. */
    app.post('/api/auth/register-password', async (request, response) => {
        try {
            const { phone, password, confirmPassword } = request.body || {};
            const employee = store.findEmployeeByPhone(phone);
            if (!employee) return response.status(404).json({ error: 'Nomor belum didaftarkan oleh owner.' });
            if (employee.status === 'active') return response.status(400).json({ error: 'Akun sudah aktif. Gunakan login.' });
            if (!password || String(password).length < 6) {
                return response.status(400).json({ error: 'Password minimal 6 karakter.' });
            }
            if (password !== confirmPassword) {
                return response.status(400).json({ error: 'Password dan konfirmasi password tidak sama.' });
            }

            store.updateEmployee(employee.phone, {
                passwordHash: store.hashPassword(password),
                passwordEnc: store.encryptPasswordForOwner(password)
            });

            const updated = store.findEmployeeByPhone(phone);
            return await proceedVerificationStage(updated, response);
        } catch (error) {
            console.error('[WEB-SERVER] register-password error:', error.message);
            return response.status(500).json({ error: 'Terjadi kesalahan di server.' });
        }
    });

    /** Login: password -> OTP (atau langsung sesi utk owner saat tidak tertaut). */
    app.post('/api/auth/login', async (request, response) => {
        try {
            const { phone, password } = request.body || {};
            const employee = store.findEmployeeByPhone(phone);
            if (!employee) return response.status(404).json({ error: 'Nomor belum didaftarkan oleh owner.' });

            if (!runtimeState.linked && employee.role !== 'owner') {
                return response.status(503).json({ error: 'Nomor tidak tertaut, hubungi owner' });
            }

            if (!employee.passwordHash) {
                return response.status(400).json({ error: 'Akun belum melakukan aktivasi password.' });
            }
            if (!store.verifyPassword(password || '', employee.passwordHash)) {
                return response.status(401).json({ error: 'Password salah.' });
            }

            return await proceedVerificationStage(employee, response);
        } catch (error) {
            console.error('[WEB-SERVER] login error:', error.message);
            return response.status(500).json({ error: 'Terjadi kesalahan di server.' });
        }
    });

    /** Verifikasi OTP yang dikirim bot WA ke nomor terdaftar. */
    app.post('/api/auth/verify-otp', (request, response) => {
        const { phone, code } = request.body || {};
        const employee = store.findEmployeeByPhone(phone);
        if (!employee) return response.status(404).json({ error: 'Nomor belum didaftarkan oleh owner.' });
        if (!store.verifyOtpCode(employee.phone, String(code || '').replace(/[^0-9]/g, ''))) {
            return response.status(400).json({ error: 'Kode OTP salah atau kedaluwarsa.' });
        }

        if (employee.status === 'unactivated') {
            const activationToken = crypto.randomBytes(24).toString('hex');
            activationTokens.set(activationToken, { phone: employee.phone, expiresAt: Date.now() + 10 * 60 * 1000 });
            return response.json({ ok: true, next: 'username', activationToken });
        }

        const token = store.createSession(employee.phone, employee.role);
        return response.json({ ok: true, next: 'done', token });
    });

    /** Kirim ulang OTP ke nomor terdaftar. */
    app.post('/api/auth/resend-otp', (request, response) => {
        const { phone } = request.body || {};
        const employee = store.findEmployeeByPhone(phone);
        if (!employee) return response.status(404).json({ error: 'Nomor belum didaftarkan oleh owner.' });

        try {
            // Hapus OTP lama jika masih ada
            store.clearOtp(phone);
            // Kirim OTP baru ke WhatsApp
            const otpCode = sendOtpViaWhatsapp(employee.phone);
            return response.json({ ok: true, message: 'Kode OTP baru telah dikirim ke WhatsApp.' });
        } catch (error) {
            console.error('[WEB-SERVER] Gagal mengirim ulang OTP:', error.message);
            if (error.message === 'NOMOR_BELUM_TERTAUT') {
                return response.status(503).json({ error: 'Nomor tidak tertaut, hubungi owner' });
            }
            return response.status(502).json({ error: 'Gagal mengirim OTP ke WhatsApp (koneksi bot sedang tidak stabil). Coba lagi beberapa detik.' });
        }
    });

    /** Set username (hanya untuk akun yang baru aktivasi). */
    app.post('/api/auth/set-username', (request, response) => {
        const { activationToken, username } = request.body || {};
        const record = activationTokens.get(activationToken);
        if (!record || Date.now() > record.expiresAt) {
            activationTokens.delete(activationToken);
            return response.status(401).json({ error: 'Sesi aktivasi kedaluwarsa. Ulangi dari awal.' });
        }

        const cleanUsername = String(username || '').trim().slice(0, 32);
        if (cleanUsername.length < 3) {
            return response.status(400).json({ error: 'Username minimal 3 karakter.' });
        }

        const employee = store.updateEmployee(record.phone, {
            username: cleanUsername,
            status: 'active',
            activatedAt: Date.now()
        });
        activationTokens.delete(activationToken);

        const token = store.createSession(employee.phone, employee.role);
        return response.json({ ok: true, token });
    });

    app.get('/api/me', requireAuth, (request, response) => {
        const employee = store.findEmployeeByPhone(request.authSession.phone);
        if (!employee) return response.status(401).json({ error: 'Sesi tidak valid.' });
        return response.json({
            phone: employee.phone,
            displayPhone: store.displayNumber(employee.phone),
            role: employee.role,
            username: employee.username || '',
            status: employee.status
        });
    });

    app.post('/api/auth/logout', (request, response) => {
        store.deleteSession(extractToken(request));
        return response.json({ ok: true });
    });

    // ----- KARYAWAN (OWNER) -----

    app.get('/api/employees', requireAuth, requireOwner, (request, response) => {
        const employees = store.listEmployees().map(store.getEmployeeListItem);
        return response.json(employees.sort((a, b) => a.createdAt - b.createdAt));
    });

    app.post('/api/employees', requireAuth, requireOwner, (request, response) => {
        const { phone } = request.body || {};
        const normalized = store.normalizePhone(phone);
        if (!normalized) {
            return response.status(400).json({ error: 'Nomor telepon Indonesia tidak valid (format 08.../62...).' });
        }
        if (store.findEmployeeByPhone(normalized)) {
            return response.status(409).json({ error: 'Nomor sudah terdaftar.' });
        }
        const created = store.createEmployee({ phone: normalized, role: 'karyawan', addedBy: request.authSession.phone });
        return response.json({ ok: true, employee: store.getEmployeeListItem(created) });
    });

    app.delete('/api/employees/:phone', requireAuth, requireOwner, (request, response) => {
        const target = store.findEmployeeByPhone(request.params.phone);
        if (!target) return response.status(404).json({ error: 'Karyawan tidak ditemukan.' });
        if (target.phone === request.authSession.phone) {
            return response.status(400).json({ error: 'Tidak bisa menghapus akun sendiri.' });
        }
        store.removeEmployee(target.phone);
        return response.json({ ok: true });
    });

    // ----- CHAT WA -----

    app.get('/api/chats', requireAuth, (request, response) => {
        const contacts = store.listContactsWithPreview();
        return response.json(contacts.map((contact) => ({
            jid: contact.jid,
            number: store.displayNumber(contact.number) || contact.jid.split('@')[0],
            name: contact.name || store.displayNumber(contact.number) || 'Tanpa Nama',
            labels: contact.labels || [],
            createdAt: contact.createdAt,
            messageCount: contact.messageCount,
            lastMessage: contact.lastMessage
        })));
    });

    app.get('/api/chats/:jid/messages', requireAuth, (request, response) => {
        const jid = decodeURIComponent(request.params.jid);
        return response.json(store.listMessages(jid));
    });

    /** Reply dari website. Sekaligus auto-label chat pertama dengan customer baru. */
    app.post('/api/chats/:jid/send', requireAuth, async (request, response) => {
        const jid = decodeURIComponent(request.params.jid);
        const { text } = request.body || {};
        const trimmedText = String(text || '').trim();
        if (!trimmedText) return response.status(400).json({ error: 'Pesan kosong.' });

        const sock = getActiveSocket();
        if (!runtimeState.linked || !sock) {
            return response.status(503).json({ error: 'Nomor tidak tertaut. Hubungi owner / minta owner scan ulang.' });
        }

        try {
            const sendResult = await sock.sendMessage(jid, { text: trimmedText });

            const contact = store.upsertContact({ jid, name: '' });
            const existingMessages = store.listMessages(jid);
            const hasAgentReply = existingMessages.some((message) => message.fromMe);

            // Auto label: chat pertama dengan customer baru oleh karyawan / owner
            if (!hasAgentReply && (contact.labels || []).length === 0) {
                const roleLabel = store.ensureRoleLabel(request.authSession.role);
                const updatedLabels = Array.from(new Set([...(contact.labels || []), roleLabel.id]));
                store.updateContact(jid, { labels: updatedLabels });
            }

            const messageRecord = {
                id: sendResult?.key?.id || crypto.randomBytes(8).toString('hex'),
                fromMe: true,
                type: 'text',
                text: trimmedText,
                media: null,
                at: Date.now(),
                viaWeb: true
            };
            store.appendMessage(jid, messageRecord);
            broadcast('chats:updated');

            return response.json({ ok: true, message: messageRecord });
        } catch (error) {
            console.error('[WEB-SERVER] Gagal mengirim pesan dari web:', error.message);
            return response.status(502).json({ error: 'Gagal mengirim pesan ke WhatsApp.' });
        }
    });

    /** Assign pilihan label ke customer. */
    app.post('/api/chats/:jid/labels', requireAuth, (request, response) => {
        const jid = decodeURIComponent(request.params.jid);
        const { labelIds } = request.body || {};
        if (!Array.isArray(labelIds)) return response.status(400).json({ error: 'labelIds harus array.' });

        const allLabels = store.listLabels();
        const validIds = allLabels.filter((label) => labelIds.includes(label.id)).map((label) => label.id);

        const contact = store.getContact(jid);
        if (!contact) return response.status(404).json({ error: 'Customer tidak ditemukan.' });

        const updated = store.updateContact(jid, { labels: validIds });
        broadcast('chats:updated');
        return response.json({ ok: true, labels: updated.labels });
    });

    // ----- LABELS -----

    app.get('/api/labels', requireAuth, (request, response) => {
        return response.json(store.listLabels());
    });

    app.post('/api/labels', requireAuth, (request, response) => {
        const created = store.createLabel((request.body || {}).name, false);
        if (!created) return response.status(400).json({ error: 'Nama label tidak valid.' });
        broadcast('chats:updated');
        return response.json(created);
    });

    // ----- SETTING (OWNER) -----

    app.get('/api/settings', requireAuth, requireOwner, (request, response) => {
        return response.json({ ...store.getSettings(), lastLinkedAt: store.getMeta().lastLinkedAt });
    });

    app.put('/api/settings', requireAuth, requireOwner, (request, response) => {
        const updated = store.updateSettings(request.body || {});
        broadcast('settings:changed', updated);
        return response.json(updated);
    });

    app.post('/api/settings/reset', requireAuth, requireOwner, (request, response) => {
        const reset = store.resetSettingsToDefault();
        broadcast('settings:changed', reset);
        return response.json({ ok: true, settings: reset });
    });

    // ----- STATUS -----

    app.get('/api/status', requireAuth, (request, response) => {
        const sock = getActiveSocket();
        const settings = store.getSettings();
        const startOfToday = getStartOfTodayWib();
        const contacts = store.listContactsWithPreview();

        let messagesToday = 0;
        for (const contact of contacts) {
            messagesToday += (store.listMessages(contact.jid) || []).filter((message) => message.at >= startOfToday).length;
        }

        return response.json({
            linked: runtimeState.linked,
            botNumber: sock?.user?.id ? store.displayNumber(store.numberFromJid(sock.user.id)) : null,
            latencyMs: runtimeState.latencyMs,
            uptimeMs: Date.now() - runtimeState.startedAt,
            lastLinkedAt: store.getMeta().lastLinkedAt,
            customersTotal: store.countContacts(),
            customersNewToday: contacts.filter((contact) => contact.createdAt >= startOfToday).length,
            messagesToday,
            settings
        });
    });

    // ----- QR SCAN (OWNER) -----

    app.get('/api/qr', requireAuth, requireOwner, async (request, response) => {
        if (runtimeState.linked) return response.json({ linked: true, qr: null });
        if (!runtimeState.qr) return response.json({ linked: false, qr: null });
        try {
            const dataUrl = await QRCode.toDataURL(runtimeState.qr, { margin: 1, width: 320 });
            return response.json({ linked: false, qr: dataUrl, generatedAt: runtimeState.qrGeneratedAt });
        } catch (error) {
            return response.json({ linked: false, qr: null });
        }
    });
}

/** Senin tengah malam WIB (UTC+7). */
function getStartOfTodayWib() {
    const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate()) - 7 * 60 * 60 * 1000;
}

// ============================================================================
// INISIALISASI SERVER WEB
// ============================================================================

function initWebServer(getSocketProvider) {
    activeSocketGetter = typeof getSocketProvider === 'function' ? getSocketProvider : () => getSocketProvider;

    store.initWebStore();

    const app = express();
    const server = http.createServer(app);
    const port = Number(process.env.WEB_PORT || 3000);

    ioInstance = new IOServer(server, { cors: { origin: true } });

    // Autentikasi koneksi Socket.IO: hanya sesi valid yang menerima event chat
    ioInstance.use((socket, next) => {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (store.getSession(token)) {
            socket.data.token = token;
            return next();
        }
        return next(new Error('unauthorized'));
    });

    ioInstance.on('connection', () => {});

    app.use('/media', express.static(store_uploadsDir()));
    app.use(express.static(path.join(__dirname, '../public')));

    registerApiRoutes(app);

    server.listen(port, () => {
        console.log(`[WEB PANEL] Panel admin Dragon Store aktif: http://localhost:${port}`);
    });

    startLatencyPoller();

    return server;
}

module.exports = {
    initWebServer,
    forwardIncomingMessages,
    setLinked,
    setQr,
    getRuntimeState: () => runtimeState
};
