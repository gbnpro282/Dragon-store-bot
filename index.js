/**
 * ============================================================================
 * DRAGON STORE - MAIN BOT SERVER ENGINE
 * Module: Core WhatsApp Server Initialization & Dynamic Socket Management
 * File: index.js
 * Author: Dragon Store Development Team
 * Description: Server utama WhatsApp Bot Dragon Store. Menggunakan Dynamic
 *              Socket Reference untuk menjamin Cron Job selalu menggunakan
 *              koneksi WebSocket yang aktif meskipun terjadi reconnect.
 * ============================================================================
 */

require('dotenv').config();

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');

// Import modul logika internal dari folder Engine
const { handleAutoReply } = require('./Engine/autoReply');
const { initScheduler } = require('./Engine/autoBroadcast');
const webStore = require('./Engine/webStore');
const {
    initWebServer,
    forwardIncomingMessages,
    setLinked,
    setQr
} = require('./Engine/webServer');

// ============================================================================
// GLOBAL SOCKET MANAGER & STREAM INTERCEPTOR
// ============================================================================

// Referensi global ke instance socket yang sedang aktif terhubung
let currentActiveSocket = null;

/**
 * Getter untuk mengambil instance socket terhubung yang paling terbaru.
 * @returns {Object|null} Active Baileys WASocket.
 */
function getActiveSocket() {
    return currentActiveSocket;
}

/**
 * Memeriksa apakah pesan log mengandung error kriptografi yang aman diabaikan.
 */
function isIgnorableCryptoError(logMessage) {
    if (!logMessage || typeof logMessage !== 'string') return false;
    const patterns = [
        'Failed to decrypt message', 'Bad MAC', 'Session error', 
        'SessionCipher', 'doDecryptWhisperMessage', 'decryptWithSessions', 
        'verifyMAC', 'libsignal', 'Closing session:'
    ];
    return patterns.some((p) => logMessage.includes(p));
}

// Intercept Standard Error Stream
const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, fd) {
    const errorString = chunk.toString();
    if (isIgnorableCryptoError(errorString)) return true;
    return originalStderrWrite.apply(process.stderr, arguments);
};

// Intercept Standard Output Stream
const originalStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, fd) {
    const outputString = chunk.toString();
    if (isIgnorableCryptoError(outputString)) return true;
    return originalStdoutWrite.apply(process.stdout, arguments);
};

// Pino Logger Config
const pinoLogger = pino({ level: 'fatal', base: undefined });
let isSchedulerInitialized = false;

// ============================================================================
// LOGIKA UTAMA INISIALISASI SERVER BOT
// ============================================================================

async function initializeDragonStoreBotServer() {
    console.log('\n================================================================');
    console.log('       DRAGON STORE - WHATSAPP AUTOMATION SERVER ENGINE         ');
    console.log('================================================================\n');

    const sessionDirectoryPath = path.join(__dirname, 'session_db');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDirectoryPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`[SERVER STATUS] Memulai engine dengan Baileys Web Version: ${version.join('.')}`);

    // Inisialisasi Socket Baileys dengan Keep-Alive Guard
    const sock = makeWASocket({
        version,
        logger: pinoLogger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Dragon Store Home Server', 'Chrome', '120.0.0.0'],
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 25000,   // Ping server setiap 25 detik agar koneksi tidak idle/die
        connectTimeoutMs: 60000,      // Timeout koneksi 60 detik
        defaultQueryTimeoutMs: 60000, // Timeout query 60 detik
        retryRequestDelayMs: 2000,
        getMessage: async () => ({ conversation: 'Dragon Store System Message' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (connectionUpdate) => {
        const { connection, lastDisconnect, qr } = connectionUpdate;

        if (qr) {
            console.log('\n[AUTHENTICATION] QR Code baru telah dibuat. Silakan scan melalui WhatsApp:');
            qrcode.generate(qr, { small: true });
            // Simpan QR agar owner bisa scan ulang lewat panel web
            setLinked(false);
            setQr(qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[SERVER WARNING] Koneksi terputus. Kode Alasan: ${statusCode || 'Unknown'}`);
            currentActiveSocket = null; // Reset socket aktif saat terputus
            setLinked(false);
            setQr(null);

            if (!isLoggedOut) {
                console.log('[SERVER RECOVERY] Melakukan penyambungan ulang otomatis dalam 3 detik...');
                setTimeout(() => {
                    initializeDragonStoreBotServer();
                }, 3000);
            } else {
                console.error('[SERVER CRITICAL] Sesi terkeluar (Logged Out). Hapus folder session_db dan scan ulang.');
            }
        } else if (connection === 'open') {
            console.log('\n================================================================');
            console.log('   ✅ KONEKSI BOT DRAGON STORE BERHASIL TERHUBUNG KE SERVER!    ');
            console.log('================================================================\n');

            // Update referensi socket global yang sedang aktif
            currentActiveSocket = sock;
            setLinked(true);
            setQr(null);
            webStore.setMeta({ lastLinkedAt: Date.now() });
            console.log('[WEB PANEL] Waktu terakhir ditautkan diperbarui di panel admin.');

            // Jalankan backfill semua kontak yang ada ke replied_contacts.json
            try {
                const { backfillAllContactsToDatabase } = require('./Engine/autoBroadcast');
                backfillAllContactsToDatabase(sock).catch(err => {
                    console.error('[SERVER] Error saat backfill kontak:', err.message);
                });
            } catch (err) {
                console.error('[SERVER] Gagal load backfill function:', err.message);
            }

            // Inisialisasi Cron Job Scheduler dengan mempassing fungsi getter
            if (!isSchedulerInitialized) {
                initScheduler(getActiveSocket);
                isSchedulerInitialized = true;
            }
        }
    });

    sock.ev.on('messages.upsert', async (messageUpsertEvent) => {
        // Forward SEMUA chat personal (termasuk foto/media) ke panel admin web
        try {
            await forwardIncomingMessages(sock, messageUpsertEvent);
        } catch (forwardError) {
            console.error('[SERVER] Gagal forward pesan ke panel web:', forwardError.message);
        }

        await handleAutoReply(sock, messageUpsertEvent);
    });
}

// Global Crash Handlers
process.on('uncaughtException', (error) => {
    if (!isIgnorableCryptoError(error.message)) {
        console.error('[UNCAUGHT EXCEPTION ERROR]:', error.message);
        console.error(error.stack || '');
        // Keluar dengan kode error agar PM2 bisa auto-restart (tanpa PM2, proses mati bersih)
        setTimeout(() => process.exit(1), 500);
    }
});

process.on('unhandledRejection', (reason) => {
    const detail = reason && reason.message ? reason.message : String(reason);
    if (!isIgnorableCryptoError(detail)) {
        console.error('[UNHANDLED REJECTION]:', detail);
    }
});

// ============================================================================
// GRACEFUL SHUTDOWN (DIBUTUHKAN UNTUK PM2)
// Menutup koneksi WebSocket Baileys dengan rapi saat pm2 stop/restart.
// PENTING: menggunakan sock.end(undefined), BUKAN sock.logout() —
// sock.logout() akan meng-unpair sesi (hapus session_db).
// ===========================================================================

async function performGracefulShutdown(signalName) {
    if (performGracefulShutdown.isRunning) return;
    performGracefulShutdown.isRunning = true;

    console.log(`[SERVER] Sinyal ${signalName} diterima. Menutup koneksi WhatsApp dengan rapi...`);

    try {
        const closingSocket = getActiveSocket();
        if (closingSocket && typeof closingSocket.end === 'function') {
            closingSocket.end(undefined);
        }
    } catch (shutdownError) {
        console.error('[SERVER] Gagal menutup koneksi secara rapi:', shutdownError.message);
    }

    // Beri jeda kecil agar socket sempat mengirim sinyal penutup lalu keluar bersih
    setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => performGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => performGracefulShutdown('SIGTERM'));

let isWebServerInitialized = false;
if (!isWebServerInitialized) {
    initWebServer(getActiveSocket);
    isWebServerInitialized = true;
}

// Jalankan server
initializeDragonStoreBotServer().catch((fatalError) => {
    console.error('[FATAL SERVER ERROR] Gagal memulai bot server:', fatalError);
});