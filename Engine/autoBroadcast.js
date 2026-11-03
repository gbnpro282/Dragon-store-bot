/**
 * ============================================================================
 * DRAGON STORE - AUTOMATED BROADCAST & WHATSAPP STATUS ENGINE
 * Module: High-Availability Broadcast Engine with Dynamic Socket Getter
 * File: Engine/autoBroadcast.js
 * Author: Dragon Store Development Team
 * Description: Engine otomatisasi broadcast yang mendukung Dynamic Socket Getter
 *              serta Retry Mechanism jika koneksi sedang terputus saat jadwal cron.
 * ============================================================================
 */

const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const webStore = require('./webStore');

const REPLIED_CONTACTS_PATH = path.join(__dirname, '../replied_contacts.json');
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30000;
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

function strictlySanitizeUserJid(rawJid) {
    try {
        if (!rawJid || typeof rawJid !== 'string') return null;
        if (rawJid.endsWith('@lid') || rawJid.endsWith('@g.us') || rawJid.endsWith('@newsletter')) return null;

        let cleanNumber = rawJid.split('@')[0].split(':')[0];
        cleanNumber = cleanNumber.replace(/[^0-9]/g, '');

        if (cleanNumber.startsWith('08')) cleanNumber = '62' + cleanNumber.slice(1);
        if (cleanNumber.length < 8 || cleanNumber.length > 15) return null;

        return `${cleanNumber}@s.whatsapp.net`;
    } catch (error) {
        return null;
    }
}

async function fetchRemoteImageBuffer(imageUrl) {
    try {
        if (!imageUrl || typeof imageUrl !== 'string') return null;

        console.log(`[BROADCAST ENGINE] Mengunduh gambar promosi dari URL: ${imageUrl}`);

        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: MEDIA_DOWNLOAD_TIMEOUT_MS,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });

        if (response.status === 200 && response.data) {
            const imageBuffer = Buffer.from(response.data, 'binary');
            console.log(`[BROADCAST ENGINE] Gambar berhasil diunduh. Ukuran: ${imageBuffer.length} bytes.`);
            return imageBuffer;
        }
        return null;
    } catch (error) {
        console.error('[BROADCAST ENGINE ERROR] Gagal mengunduh gambar promosi:', error.message);
        return null;
    }
}

function loadRepliedContactsFromFile() {
    try {
        if (!fs.existsSync(REPLIED_CONTACTS_PATH)) {
            return {};
        }
        const fileContent = fs.readFileSync(REPLIED_CONTACTS_PATH, 'utf8');
        if (!fileContent || fileContent.trim() === '') {
            return {};
        }
        const parsedData = JSON.parse(fileContent);
        if (Array.isArray(parsedData)) {
            const migrated = {};
            const currentTime = Date.now();
            for (const jid of parsedData) {
                if (typeof jid === 'string') {
                    migrated[jid] = currentTime;
                }
            }
            return migrated;
        }
        return typeof parsedData === 'object' && parsedData !== null ? parsedData : {};
    } catch (error) {
        return {};
    }
}

function saveRepliedContactsToFile(databaseObject) {
    try {
        fs.writeFileSync(REPLIED_CONTACTS_PATH, JSON.stringify(databaseObject, null, 2), 'utf8');
    } catch (error) {
        console.error('[BROADCAST ENGINE ERROR] Gagal menyimpan replied_contacts.json:', error.message);
    }
}

async function backfillAllContactsToDatabase(sock) {
    try {
        const db = loadRepliedContactsFromFile();
        let addedCount = 0;
        const currentTime = Date.now();

        if (process.env.ADMIN_NUMBER) {
            const adminJid = strictlySanitizeUserJid(process.env.ADMIN_NUMBER);
            if (adminJid && !db[adminJid]) {
                db[adminJid] = currentTime;
                addedCount++;
            } else if (adminJid) {
                db[adminJid] = currentTime;
            }
        }

        if (sock && sock.user && sock.user.id) {
            const ownJid = strictlySanitizeUserJid(sock.user.id);
            if (ownJid && !db[ownJid]) {
                db[ownJid] = currentTime;
                addedCount++;
            } else if (ownJid) {
                db[ownJid] = currentTime;
            }
        }

        if (sock && sock.store) {
            if (sock.store.contacts) {
                for (const jid of Object.keys(sock.store.contacts)) {
                    const sanitizedJid = strictlySanitizeUserJid(jid);
                    if (sanitizedJid && !db[sanitizedJid]) {
                        db[sanitizedJid] = currentTime;
                        addedCount++;
                    }
                }
            }
            if (sock.store.chats) {
                for (const jid of Object.keys(sock.store.chats)) {
                    const sanitizedJid = strictlySanitizeUserJid(jid);
                    if (sanitizedJid && !db[sanitizedJid]) {
                        db[sanitizedJid] = currentTime;
                        addedCount++;
                    }
                }
            }
        }

        if (addedCount > 0) {
            saveRepliedContactsToFile(db);
            console.log(`[BROADCAST ENGINE] Backfill selesai! Ditambahkan ${addedCount} nomor baru ke replied_contacts.json`);
        } else {
            saveRepliedContactsToFile(db);
            console.log('[BROADCAST ENGINE] Backfill selesai! Tidak ada nomor baru yang ditambahkan.');
        }
    } catch (error) {
        console.error('[BROADCAST ENGINE ERROR] Gagal melakukan backfill kontak:', error.message);
    }
}

async function resolveComprehensiveStatusJidList(sock) {
    const verifiedJidSet = new Set();

    try {
        if (process.env.ADMIN_NUMBER) {
            const adminJid = strictlySanitizeUserJid(process.env.ADMIN_NUMBER);
            if (adminJid) verifiedJidSet.add(adminJid);
        }

        if (sock && sock.user && sock.user.id) {
            const ownJid = strictlySanitizeUserJid(sock.user.id);
            if (ownJid) verifiedJidSet.add(ownJid);
        }

        if (fs.existsSync(REPLIED_CONTACTS_PATH)) {
            try {
                const fileContent = fs.readFileSync(REPLIED_CONTACTS_PATH, 'utf8');
                if (fileContent && fileContent.trim() !== '') {
                    const parsedData = JSON.parse(fileContent);
                    let rawContactList = Array.isArray(parsedData) ? parsedData : Object.keys(parsedData);
                    for (const rawJid of rawContactList) {
                        const sanitizedJid = strictlySanitizeUserJid(rawJid);
                        if (sanitizedJid) verifiedJidSet.add(sanitizedJid);
                    }
                }
            } catch (dbError) {}
        }

        if (sock && sock.store) {
            if (sock.store.contacts) {
                for (const jid of Object.keys(sock.store.contacts)) {
                    const sanitizedJid = strictlySanitizeUserJid(jid);
                    if (sanitizedJid) verifiedJidSet.add(sanitizedJid);
                }
            }
            if (sock.store.chats) {
                for (const jid of Object.keys(sock.store.chats)) {
                    const sanitizedJid = strictlySanitizeUserJid(jid);
                    if (sanitizedJid) verifiedJidSet.add(sanitizedJid);
                }
            }
        }
    } catch (error) {
        console.error('[BROADCAST ENGINE ERROR] Gagal menyusun daftar target status:', error.message);
    }

    return Array.from(verifiedJidSet);
}

async function publishToWhatsAppStatus(sock, imageBuffer, caption) {
    try {
        console.log('[BROADCAST ENGINE] Mempersiapkan payload pengiriman WhatsApp Status...');
        const targetContactJids = await resolveComprehensiveStatusJidList(sock);

        if (targetContactJids.length === 0) {
            console.error('[BROADCAST ENGINE ERROR] Pengiriman status dibatalkan: statusJidList kosong.');
            return;
        }

        const statusSendResponse = await sock.sendMessage('status@broadcast', {
            image: imageBuffer,
            caption: caption
        }, {
            statusJidList: targetContactJids,
            broadcast: true
        });

        console.log('[BROADCAST ENGINE SUCCESS] Status WhatsApp berhasil diunggah!');
        console.log(`[BROADCAST ENGINE LOG] Message ID: ${statusSendResponse?.key?.id || 'OK'}`);
    } catch (error) {
        console.error('[BROADCAST ENGINE CRITICAL ERROR] Gagal mengunggah ke WhatsApp Status:', error.message);
    }
}

async function publishToWhatsAppChannel(sock, imageBuffer, caption) {
    const channelJid = process.env.CHANNEL_JID;
    if (!channelJid || channelJid.includes('xxxxxxxxxx')) return;

    try {
        console.log(`[BROADCAST ENGINE] Mengirim pesan promosi ke WhatsApp Channel: ${channelJid}`);
        const channelSendResponse = await sock.sendMessage(channelJid, {
            image: imageBuffer,
            caption: caption
        });

        console.log('[BROADCAST ENGINE SUCCESS] Pesan promosi berhasil dikirim ke WhatsApp Channel!');
        console.log(`[BROADCAST ENGINE LOG] Channel Message ID: ${channelSendResponse?.key?.id || 'OK'}`);
    } catch (error) {
        console.error('[BROADCAST ENGINE ERROR] Gagal mengirim pesan ke WhatsApp Channel:', error.message);
    }
}

/**
 * Eksekutor Utama Pekerjaan Broadcast dengan Retry Guard.
 * @param {Function|Object} getSocket - Target instance socket atau fungsi getter.
 */
async function executeBroadcastJob(getSocket) {
    // Gate Setting dari Panel Admin: Auto Broadcast bisa dimatikan oleh owner
    if (!webStore.getSettings().autoBroadcast) {
        console.log('[BROADCAST ENGINE] Auto Broadcast sedang nonaktif (dimatikan dari panel admin). Job dilewati.');
        return;
    }

    console.log('\n================================================================');
    console.log('       DRAGON STORE - AUTOMATED BROADCAST EXECUTION ENGINE      ');
    console.log('================================================================\n');

    // Mengambil instance socket aktif
    let sock = typeof getSocket === 'function' ? getSocket() : getSocket;

    // Retry Guard: Tunggu hingga 3x jika koneksi sedang reconnect
    let retryCount = 0;
    while ((!sock || !sock.user) && retryCount < 3) {
        console.warn(`[BROADCAST ENGINE WARNING] Socket belum siap/sedang reconnect. Menunggu 5 detik (Percobaan ${retryCount + 1}/3)...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        sock = typeof getSocket === 'function' ? getSocket() : getSocket;
        retryCount++;
    }

    if (!sock || !sock.user) {
        console.error('[BROADCAST ENGINE CRITICAL] Gagal mengeksekusi broadcast: Socket WhatsApp tidak terhubung.');
        return;
    }

    const imageUrl = process.env.IMAGE_PROMO_URL;
    const caption = process.env.PROMO_CAPTION || '🔥 DRAGON STORE - JASA JOKI CDID TERPERCAYA 🔥';

    const imageBuffer = await fetchRemoteImageBuffer(imageUrl);
    if (!imageBuffer) {
        console.error('[BROADCAST ENGINE ABORTED] Proses dibatalkan karena gambar gagal diunduh.');
        return;
    }

    await publishToWhatsAppStatus(sock, imageBuffer, caption);
    await publishToWhatsAppChannel(sock, imageBuffer, caption);

    console.log('\n================================================================');
    console.log('   PROSES BROADCAST (STATUS & CHANNEL) SELESAI DIEKSEKUSI       ');
    console.log('================================================================\n');
}

/**
 * Inisialisasi Penjadwalan Cron Job (06:00 WIB, 12:00 WIB & 15:00 WIB).
 * @param {Function|Object} getSocketProvider - Fungsi getter socket aktif.
 */
function initScheduler(getSocketProvider) {
    const timezone = process.env.TIMEZONE || DEFAULT_TIMEZONE;

    console.log('[SCHEDULER ENGINE] Menyalakan penjadwalan otomatis...');

    cron.schedule('0 6 * * *', async () => {
        console.log('[CRON TRIGGER] Memulai eksekusi jadwal pagi (06:00 WIB)...');
        await executeBroadcastJob(getSocketProvider);
    }, { scheduled: true, timezone: timezone });

    cron.schedule('0 12 * * *', async () => {
        console.log('[CRON TRIGGER] Memulai eksekusi jadwal siang (12:00 WIB)...');
        await executeBroadcastJob(getSocketProvider);
    }, { scheduled: true, timezone: timezone });

    cron.schedule('0 15 * * *', async () => {
        console.log('[CRON TRIGGER] Memulai eksekusi jadwal sore (15:00 WIB)...');
        await executeBroadcastJob(getSocketProvider);
    }, { scheduled: true, timezone: timezone });

    console.log('[SCHEDULER ENGINE] Cron Job aktif untuk jam 06:00 WIB, 12:00 WIB dan 15:00 WIB.');
}

module.exports = {
    initScheduler,
    executeBroadcastJob,
    publishToWhatsAppStatus,
    publishToWhatsAppChannel,
    backfillAllContactsToDatabase
};