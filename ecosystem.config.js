/**
 * ============================================================================
 * DRAGON STORE - PM2 ECOSYSTEM CONFIGURATION
 * File: ecosystem.config.js
 * Author: Dragon Store Development Team
 * Description: Konfigurasi PM2 untuk bot + panel admin Dragon Store.
 *              Jalankan dengan:  pm2 start ecosystem.config.js
 *              Log:              pm2 logs dragon-store-wa-bot
 *              Stop/Restart:     pm2 stop dragon-store-wa-bot / pm2 restart dragon-store-wa-bot
 * ============================================================================
 */

module.exports = {
    apps: [
        {
            // Nama proses di pm2 list
            name: 'Dragon Store WA Bot',

            // Entry point server (bot + panel admin jalan dari 1 proses yang sama)
            script: 'index.js',
            cwd: __dirname,

            // WAJIB 'fork' + instances: 1.
            // WhatsApp menolak dua koneksi memakai sesi (session_db) yang sama —
            // kalau multi-instance, dua proses saling menendang koneksi sehingga
            // koneksi bot putus-nyambung dan pesan (mis. OTP) gagal terkirim.
            exec_mode: 'fork',
            instances: 1,

            // WATCH DIMATIKAN SECARA SENGAYA:
            // bot ini menulis file JSON tiap event (session_db/, data/, uploads/).
            // Kalau watch: true, PM2 akan restart terus-menerus seolah file berubah,
            // dan itu juga merusak koneksi WhatsApp.
            watch: false,

            // Auto-restart saat crash (uncaughtException di index.js exit 1)
            autorestart: true,

            // Anti crash-loop: batas restart + jeda antar restart
            max_restarts: 10,
            min_uptime: '10s',
            restart_delay: 4000,

            // Beri waktu graceful shutdown (index.js menutup koneksi WA saat SIGINT/SIGTERM)
            kill_timeout: 10000,

            // Prefix log dengan timestamp (pm2 logs)
            time: true,

            env: {
                NODE_ENV: 'production',
                WEB_PORT: process.env.WEB_PORT || 3000
            }
        }
    ]
};
