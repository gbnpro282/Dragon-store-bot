/**
 * ============================================================================
 * DRAGON STORE - AUTOMATED RESPONSE ENGINE WITH WIDE PANEL LAYOUT
 * Module: Auto Reply Engine with Image Attachment & 24-Hour Cooldown
 * File: Engine/autoReply.js
 * Author: Dragon Store Development Team
 * Description: Modul balasan otomatis untuk pelanggan baru Joki CDID.
 *              Mengirimkan pesan sambutan profesional berformat lebar (horizontal layout)
 *              beserta flyer promo dengan fitur 24-hour smart cooldown.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const webStore = require('./webStore');

// ============================================================================
// KONFIGURASI CONSTANT & PATH REPOSITORY ENGINE
// ============================================================================

// Path ke file penyimpanan data kontak dan timestamp lokal
const DATABASE_FILE_PATH = path.join(__dirname, '../replied_contacts.json');

// Durasi Cooldown Auto Reply: 24 Jam dalam Milidetik (24 jam * 60 menit * 60 detik * 1000 ms)
const COOLDOWN_DURATION_MS = 24 * 60 * 60 * 1000; 

// Batas waktu pembersihan database berkala (Entri lebih lama dari 30 hari akan dibersihkan)
const DATABASE_CLEANUP_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

// Timeout pengunduhan gambar flyer dari URL (milidetik)
const IMAGE_FETCH_TIMEOUT_MS = 20000;

// Cache memori internal untuk mencegah duplikasi pemrosesan pesan yang sama dalam waktu singkat
const processedMessageCache = new Map();

// ============================================================================
// STRUKTUR FUNGSI HELPER & DATABASE UTAMA
// ============================================================================

/**
 * Membaca data kontak dan timestamp terakhir balasan dari file JSON lokal.
 * Mendukung migrasi otomatis dari format lama (Array) ke format baru (Object/Map).
 * @returns {Record<string, number>} Object berisi key (JID) dan value (Timestamp ms).
 */
function loadRepliedContactsDatabase() {
    try {
        if (!fs.existsSync(DATABASE_FILE_PATH)) {
            const initialData = {};
            fs.writeFileSync(DATABASE_FILE_PATH, JSON.stringify(initialData, null, 2), 'utf8');
            return initialData;
        }

        const rawFileContent = fs.readFileSync(DATABASE_FILE_PATH, 'utf8');
        if (!rawFileContent || rawFileContent.trim() === '') {
            return {};
        }

        const parsedData = JSON.parse(rawFileContent);

        // Migrasi data otomatis jika file sebelumnya menggunakan format Array lama
        if (Array.isArray(parsedData)) {
            console.log('[AUTO-REPLY ENGINE] Melakukan migrasi database dari format Array ke Object Timestamp...');
            const migratedData = {};
            const currentTime = Date.now();
            for (const jid of parsedData) {
                if (typeof jid === 'string') {
                    migratedData[jid] = currentTime;
                }
            }
            saveRepliedContactsDatabase(migratedData);
            return migratedData;
        }

        if (typeof parsedData === 'object' && parsedData !== null) {
            return parsedData;
        }

        return {};
    } catch (error) {
        console.error('[AUTO-REPLY ENGINE ERROR] Gagal membaca file database kontak:', error.message);
        return {};
    }
}

/**
 * Menyimpan objek data kontak dan timestamp secara aman ke file JSON.
 * @param {Record<string, number>} databaseObject - Object data kontak.
 */
function saveRepliedContactsDatabase(databaseObject) {
    try {
        const serializedContent = JSON.stringify(databaseObject, null, 2);
        fs.writeFileSync(DATABASE_FILE_PATH, serializedContent, 'utf8');
    } catch (error) {
        console.error('[AUTO-REPLY ENGINE ERROR] Gagal menyimpan data ke database kontak:', error.message);
    }
}

/**
 * Membersihkan entri database yang sudah sangat lama (di atas 30 hari)
 * agar ukuran file JSON tetap ringan dan tidak membebani memori server.
 * @param {Record<string, number>} databaseObject 
 * @returns {Record<string, number>} Database yang sudah dibersihkan.
 */
function pruneExpiredDatabaseEntries(databaseObject) {
    const currentTime = Date.now();
    let hasChanges = false;

    for (const [jid, timestamp] of Object.entries(databaseObject)) {
        if (currentTime - timestamp > DATABASE_CLEANUP_THRESHOLD_MS) {
            delete databaseObject[jid];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        console.log('[AUTO-REPLY ENGINE] Pembersihan database berkala berhasil dilakukan.');
        saveRepliedContactsDatabase(databaseObject);
    }

    return databaseObject;
}

/**
 * Membersihkan cache deduplikasi ID pesan secara berkala agar memori server tetap optimal.
 */
function cleanupMessageCache() {
    const currentTime = Date.now();
    if (processedMessageCache.size > 500) {
        for (const [messageId, timestamp] of processedMessageCache.entries()) {
            if (currentTime - timestamp > 300000) { // Hapus cache lebih dari 5 menit
                processedMessageCache.delete(messageId);
            }
        }
    }
}

/**
 * Memeriksa apakah pengirim masih berada dalam masa Cooldown 24 Jam.
 * @param {number|undefined} lastRepliedTimestamp - Timestamp terakhir di-reply.
 * @returns {{ isCooldown: boolean, remainingHours: string }} Status cooldown.
 */
function checkIsCooldownActive(lastRepliedTimestamp) {
    if (!lastRepliedTimestamp || typeof lastRepliedTimestamp !== 'number') {
        return { isCooldown: false, remainingHours: '0' };
    }

    const currentTime = Date.now();
    const elapsedTime = currentTime - lastRepliedTimestamp;

    if (elapsedTime < COOLDOWN_DURATION_MS) {
        const remainingMs = COOLDOWN_DURATION_MS - elapsedTime;
        const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);
        return { isCooldown: true, remainingHours };
    }

    return { isCooldown: false, remainingHours: '0' };
}

/**
 * Mengunduh buffer gambar flyer/promo dari URL publik di file .env
 * @param {string} imageUrl - URL publik gambar promo.
 * @returns {Promise<Buffer|null>} Buffer gambar atau null jika terjadi kesalahan.
 */
async function fetchPromoImageBuffer(imageUrl) {
    try {
        if (!imageUrl || typeof imageUrl !== 'string') {
            return null;
        }

        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: IMAGE_FETCH_TIMEOUT_MS,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (response.status === 200 && response.data) {
            return Buffer.from(response.data, 'binary');
        }

        return null;
    } catch (error) {
        console.warn('[AUTO-REPLY ENGINE WARNING] Gagal mengunduh gambar promo untuk auto-reply:', error.message);
        return null;
    }
}

/**
 * Mensimulasikan status "mengetik..." (typing presence) di WhatsApp.
 * @param {Object} sock - Instance Baileys Socket.
 * @param {string} remoteJid - JID penerima.
 * @param {number} durationMs - Durasi simulasi dalam milidetik.
 */
async function simulateTypingEffect(sock, remoteJid, durationMs = 2000) {
    try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        await sock.sendPresenceUpdate('paused', remoteJid);
    } catch (presenceError) {
        // Abaikan jika ada kegagalan update presence
    }
}

/**
 * Membuat template panel pesan balasan otomatis dengan layout meledak ke samping (horizontal format),
 * bersih, rapi, dan tanpa bagian metode pembayaran.
 * @returns {string} String template pesan balasan.
 */
function generateWelcomeMessageTemplate() {
    const welcomeMessage = 
        `===============================\n` +
        ` 🐉 *DRAGON STORE OFFICIAL* 🐉             \n` +
        `       *Jasa Joki CDID Terpercaya*       \n` +
        `===============================\n\n` +
        `Halo Kak! 👋 Selamat datang di *Dragon Store*.\n\n` +
        `🤖 *SYSTEM AUTO-REPLY*\n` +
        `Pesan Anda telah kami terima secara otomatis. Harap tunggu sebentar, *Seller / Admin* kami akan segera merespons chat Anda secara langsung.\n\n` +
        `-----------------------------------------\n` +
        `🌟 *KEUNGGULAN DRAGON STORE*\n` +
        `• *Safe:* Aman dari ban.\n` +
        `• *Proses Cepat:* Ditangani langsung oleh tim pro-driver CDID.\n` +
        `• *Bonus Melimpah:* Dapatkan bonus Money di setiap pengerjaan!\n` +
        `-----------------------------------------\n\n` +
        `📸 *PRICELIST & PACKAGES:* \n` +
        `Silakan periksa flyer/gambar yang terlampir pada pesan ini untuk melihat daftar paket Joki CDID & harga promo terbaru secara langsung! ✨\n\n` +
        `-----------------------------------------\n` +
        `⚠️ *PETUNJUK SEBELUM DIPROSES*\n` +
        `1️⃣ Siapkan Username & Password akun Roblox Anda.\n` +
        `2️⃣ Matikan sementara Verifikasi 2 Langkah (2FA / PIN) agar proses login lancar.\n` +
        `3️⃣ Dilarang *tabrak login* saat proses joki sedang berlangsung.\n` +
        `4️⃣ Harap tidak *spam chat* agar antrean Anda tidak tergeser ke atas.\n` +
        `-----------------------------------------\n\n` +
        `Silakan tinggalkan detail pesanan atau pertanyaan Anda di bawah ini. Terima kasih atas kesabaran Anda! 🚗💨`;

    return welcomeMessage;
}

// ============================================================================
// LOGIKA UTAMA ENGINE AUTO REPLY
// ============================================================================

/**
 * Processing handler utama untuk pesan masuk dari WhatsApp.
 * @param {Object} sock - Instance Baileys WASocket.
 * @param {Object} msg - Event payload messages.upsert.
 */
async function handleAutoReply(sock, msg) {
    try {
        // 1. Validasi keberadaan payload pesan
        if (!msg || !msg.messages || !Array.isArray(msg.messages) || msg.messages.length === 0) {
            return;
        }

        // 2. Hanya proses event bertipe 'notify' untuk mencegah pemrosesan ulang
        if (msg.type && msg.type !== 'notify') {
            return;
        }

        const incomingMessage = msg.messages[0];

        // 3. Validasi struktur key pesan
        if (!incomingMessage || !incomingMessage.key) {
            return;
        }

        const messageId = incomingMessage.key.id;
        const remoteJid = incomingMessage.key.remoteJid;

        // 4. Proteksi Deduplikasi Pesan dalam Waktu Singkat
        if (messageId && processedMessageCache.has(messageId)) {
            return;
        }

        if (messageId) {
            processedMessageCache.set(messageId, Date.now());
            cleanupMessageCache();
        }

        // 5. Filter pengirim: Abaikan pesan dari diri sendiri, broadcast, grup, dan newsletter channel
        if (
            incomingMessage.key.fromMe ||
            !remoteJid ||
            remoteJid === 'status@broadcast' ||
            remoteJid.endsWith('@g.us') ||
            remoteJid.endsWith('@newsletter')
        ) {
            return;
        }

        // 6. Muat database kontak dan lakukan pembersihan berkala
        let contactsDatabase = loadRepliedContactsDatabase();
        contactsDatabase = pruneExpiredDatabaseEntries(contactsDatabase);

        const lastRepliedTimestamp = contactsDatabase[remoteJid];

        // 7. Simpan nomor kontak yang chat (baik yang baru maupun yang sudah pernah chat)
        // Ini berguna agar bisa ditambahkan ke statusJidList
        if (!contactsDatabase[remoteJid]) {
            contactsDatabase[remoteJid] = Date.now();
            saveRepliedContactsDatabase(contactsDatabase);
            console.log(`[AUTO-REPLY ENGINE] Menyimpan nomor baru yang menghubungi bot: ${remoteJid}`);
        } else {
            // Update timestamp akses terakhir agar tetap terjaga
            contactsDatabase[remoteJid] = Date.now();
            saveRepliedContactsDatabase(contactsDatabase);
        }

        // 8. Cek Status Cooldown 24 Jam
        const cooldownStatus = checkIsCooldownActive(lastRepliedTimestamp);

        if (cooldownStatus.isCooldown) {
            return;
        }

        // 9. Gate Setting dari Panel Admin: Auto Reply bisa dimatikan oleh owner
        if (!webStore.getSettings().autoReply) {
            return;
        }

        // 8. Eksekusi Pengiriman Pesan Sambutan
        console.log(`[AUTO-REPLY ENGINE] Memproses Auto-Reply dengan Gambar Promo untuk pelanggan baru: ${remoteJid}`);

        // Simulasi status mengetik
        await simulateTypingEffect(sock, remoteJid, 2000);

        const welcomeCaptionText = generateWelcomeMessageTemplate();
        const promoImageUrl = process.env.IMAGE_PROMO_URL;

        // Unduh buffer gambar dari URL promo
        const imageBuffer = await fetchPromoImageBuffer(promoImageUrl);

        let responsePayload;

        if (imageBuffer) {
            // Jika gambar berhasil diunduh, kirim gambar + caption promo
            responsePayload = {
                image: imageBuffer,
                caption: welcomeCaptionText
            };
            console.log('[AUTO-REPLY ENGINE] Gambar promo berhasil dilampirkan ke pesan balasan.');
        } else {
            // Fallback: Kirim teks jika gambar gagal diunduh
            responsePayload = {
                text: welcomeCaptionText
            };
            console.warn('[AUTO-REPLY ENGINE WARNING] Mengirim balasan teks (Gambar promo gagal diunduh).');
        }

        const responseOptions = {
            quoted: incomingMessage
        };

        // Kirim pesan balasan ke WhatsApp pelanggan
        await sock.sendMessage(remoteJid, responsePayload, responseOptions);

        // 9. Perbarui Timestamp Terakhir di Database
        contactsDatabase[remoteJid] = Date.now();
        saveRepliedContactsDatabase(contactsDatabase);

        console.log(`[AUTO-REPLY ENGINE SUCCESS] Pesan sambutan & Flyer Promo sukses dikirim ke ${remoteJid}. Cooldown 24 jam aktif.`);

    } catch (error) {
        console.error('[AUTO-REPLY ENGINE CRITICAL ERROR] Gagal memproses balasan otomatis:', error);
    }
}

module.exports = {
    handleAutoReply,
    loadRepliedContactsDatabase,
    saveRepliedContactsDatabase,
    checkIsCooldownActive,
    generateWelcomeMessageTemplate
};