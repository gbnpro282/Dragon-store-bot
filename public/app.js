/**
 * ============================================================================
 * DRAGON STORE - WEB ADMIN PANEL FRONTEND LOGIC
 * File: public/app.js
 * Description: Vanilla JS SPA untuk login/aktivasi, chat WhatsAppReply, label,
 *              Setting (toggle + reset + QR), Status bot dan Karyawan.
 * ============================================================================
 */

(function () {
    'use strict';

    // ======================================================================
    // STATE
    // ======================================================================

    const state = {
        token: localStorage.getItem('ds_admin_token') || null,
        me: null,               // { phone, role, username, status }
        activeView: 'chat',
        linked: false,
        chats: [],
        labels: [],
        activeJid: null,
        socket: null,
        qrTimer: null,
        loginContext: { phone: '', mode: 'login', activationToken: null }
    };

    const $ = (id) => document.getElementById(id);

    // ======================================================================
    // HELPERS API
    // ======================================================================

    async function apiFetch(path, options = {}, keepRaw = false) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (state.token) headers.Authorization = 'Bearer ' + state.token;

        const response = await fetch(path, { ...options, headers });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = new Error(data.error || 'Terjadi kesalahan.');
            error.status = response.status;
            throw error;
        }
        if (keepRaw) return response;
        return data;
    }

    function showToast(message, kind) {
        const toast = document.createElement('div');
        toast.className = 'toast ' + (kind || '');
        toast.textContent = message;
        $('toastWrap').appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
    }

    function formatTime(timestamp) {
        if (!timestamp) return '';
        return new Date(Number(timestamp)).toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });
    }

    function formatUptime(ms) {
        if (!ms || ms < 0) ms = 0;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${h}j ${m}m ${s}d`;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // ======================================================================
    // SOCKET.IO (LIVE CHAT)
    // ======================================================================

    function connectSocket() {
        if (state.socket) { state.socket.disconnect(); }
        state.socket = io({ auth: { token: state.token } });

        state.socket.on('connect', () => refreshAllData());

        state.socket.on('chat:msg', (payload) => {
            loadChats();
            if (payload.jid === state.activeJid) openChat(payload.jid, true);
        });

        state.socket.on('chats:updated', () => loadChats());

        state.socket.on('state', (payload) => {
            state.linked = Boolean(payload && payload.linked);
            renderConnectionDependentUi();
        });
    }

    // ======================================================================
    // LOGIN / AKTIVASI
    // ======================================================================

    function renderLogin(step) {
        $('loginScreen').style.display = 'flex';
        $('appScreen').style.display = 'none';
        hideAllSteps();

        if (step === 'phone') {
            $('stepPhone').style.display = 'block';
        } else if (step === 'otp') {
            $('stepOtp').style.display = 'block';
        } else if (step === 'username') {
            $('stepUsername').style.display = 'block';
        }
    }

    function hideAllSteps() {
        $('stepPhone').style.display = 'none';
        $('stepOtp').style.display = 'none';
        $('stepUsername').style.display = 'none';
        $('loginNotice').style.display = 'none';
        $('stepError').textContent = '';
        $('otpError').textContent = '';
        $('usernameError').textContent = '';
    }

    function showNotice(message) {
        $('loginNotice').style.display = 'block';
        $('loginNotice').textContent = message;
    }

    /**
     * Step 1: cek nomor.
     * - Tidak terdaftar          -> error
     * - Karyawan + bot unlinked  -> tulisan "Nomor tidak tertaut, hubungi owner"
     * - unactivated              -> tampil Buat password + confirm password
     * - active                   -> tempat password saja
     */
    async function onPhoneNext() {
        $('stepError').textContent = '';
        const phone = $('inputPhone').value.trim();
        if (!phone) return $('stepError').textContent = 'Masukkan nomor telepon dulu.';

        try {
            const result = await apiFetch('/api/auth/check', {
                method: 'POST',
                body: JSON.stringify({ phone })
            });

            if (!result.found) {
                return $('stepError').textContent = 'Nomor belum didaftarkan oleh owner.';
            }
            if (result.blocked === 'unlinked') {
                state.loginContext.phone = phone;
                return showNotice(result.message || 'Nomor tidak tertaut, hubungi owner');
            }

            state.loginContext.phone = phone;
            state.loginContext.status = result.status;
            state.loginContext.role = result.role;
            state.loginContext.mode = result.status === 'unactivated' ? 'register' : 'login';

            showPhonePasswordStage();
        } catch (error) {
            $('stepError').textContent = error.message;
        }
    }

    function showPhonePasswordStage() {
        $('passwordArea').style.display = 'block';
        const isRegister = state.loginContext.mode === 'register';
        $('passwordLabel').textContent = isRegister ? 'Buat Password' : 'Password';
        $('confirmPasswordWrap').style.display = isRegister ? 'block' : 'none';
        $('btnNext').textContent = 'Next';
    }

    async function onPasswordNext() {
        $('stepError').textContent = '';
        const phone = state.loginContext.phone;
        const password = $('inputPassword').value;

        try {
            if (state.loginContext.mode === 'register') {
                const confirmPassword = $('inputConfirmPassword').value;
                const result = await apiFetch('/api/auth/register-password', {
                    method: 'POST',
                    body: JSON.stringify({ phone, password, confirmPassword })
                });
                if (result.skippedOtp && result.token) {
                    // Owner saat bot tidak tertaut: OTP dilewati, langsung masuk panel
                    return finishLogin(result.token);
                }
                renderLogin('otp');
                toastHint('Kode OTP dikirim ke WhatsApp nomormu.');
                return;
            }

            const result = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ phone, password })
            });

            if (result.skippedOtp && result.token) {
                return finishLogin(result.token);
            }
            renderLogin('otp');
            toastHint('Kode OTP dikirim ke WhatsApp nomormu.');
        } catch (error) {
            $('stepError').textContent = error.message;
        }
    }

    function toastHint(message) {
        showToast(message, 'success');
    }

    async function onOtpNext() {
        $('otpError').textContent = '';
        try {
            const result = await apiFetch('/api/auth/verify-otp', {
                method: 'POST',
                body: JSON.stringify({
                    phone: state.loginContext.phone,
                    code: $('inputOtp').value.trim()
                })
            });

            if (result.ok && result.next === 'username') {
                state.loginContext.activationToken = result.activationToken;
                renderLogin('username');
            } else if (result.ok && result.token) {
                finishLogin(result.token);
            }
        } catch (error) {
            $('otpError').textContent = error.message;
        }
    }

    async function onOtpResend() {
        try {
            const result = await apiFetch('/api/auth/resend-otp', {
                method: 'POST',
                body: JSON.stringify({ phone: state.loginContext.phone })
            });

            if (result.ok) {
                showToast(result.message || 'Kode OTP baru telah dikirim.', 'success');
                // Clear the input error and focus the OTP field
                $('otpError').textContent = '';
                $('inputOtp').value = '';
                $('inputOtp').focus();
            }
        } catch (error) {
            $('otpError').textContent = error.message;
        }
    }

    async function onUsernameNext() {
        $('usernameError').textContent = '';
        try {
            const result = await apiFetch('/api/auth/set-username', {
                method: 'POST',
                body: JSON.stringify({
                    activationToken: state.loginContext.activationToken,
                    username: $('inputUsername').value.trim()
                })
            });
            finishLogin(result.token);
        } catch (error) {
            $('usernameError').textContent = error.message;
        }
    }

    async function finishLogin(token) {
        state.token = token;
        localStorage.setItem('ds_admin_token', token);
        state.me = await apiFetch('/api/me');
        await autoFetchInitialData();
        renderLoginDone();
        connectSocket();
        renderConnectionDependentUi();
    }

    async function renderLoginDone() {
        $('loginScreen').style.display = 'none';
        $('appScreen').style.display = 'block';
        renderNavbarTabs();
        state.activeView = 'chat';
        setActiveView('chat');
    }

    async function bootLoadSession() {
        if (!state.token) return renderLogin('phone');
        try {
            state.me = await apiFetch('/api/me');
            await autoFetchInitialData();
            renderLoginDone();
            connectSocket();
        } catch (error) {
            state.token = null;
            localStorage.removeItem('ds_admin_token');
            renderLogin('phone');
        }
    }

    async function onLogout() {
        try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (error) { /* abaikan */ }
        state.token = null;
        state.me = null;
        if (state.socket) state.socket.disconnect();
        if (state.qrTimer) clearInterval(state.qrTimer);
        localStorage.removeItem('ds_admin_token');
        renderLogin('phone');
    }

    // ======================================================================
    // NAVBAR & VIEW ROUTING
    // ======================================================================

    function renderNavbarTabs() {
        const role = state.me.role;
        const tabs = role === 'owner'
            ? [['chat', 'Chat WA'], ['setting', 'Setting'], ['status', 'Status'], ['employees', 'Karyawan']]
            : [['chat', 'Chat WA'], ['status', 'Status']];

        $('navTabs').innerHTML = tabs.map(([key, label]) =>
            `<button class="nav-tab ${state.activeView === key ? 'active' : ''}" data-view="${key}">${label}</button>`
        ).join('');

        document.querySelectorAll('.nav-tab').forEach((tab) => {
            tab.addEventListener('click', () => setActiveView(tab.dataset.view));
        });
    }

    function setActiveView(view) {
        state.activeView = view;
        renderNavbarTabs();
        const container = $('viewContainer');
        container.className = 'view-container';

        if (view === 'chat') {
            container.innerHTML = '<div id="chatView"></div>';
            renderChatView();
        } else if (view === 'setting') {
            container.innerHTML = '<div id="settingView"></div>';
            renderSettingView().catch((error) => showToast(error.message, 'error'));
        } else if (view === 'status') {
            container.innerHTML = '<div id="statusView"></div>';
            refreshStatusView();
        } else if (view === 'employees') {
            container.innerHTML = '<div id="employeesView"></div>';
            refreshEmployeesView();
        }
    }

    /** Saat status koneksi berubah: banner QR owner / warning karyawan / chat. */
    function renderConnectionDependentUi() {
        if (!state.me) return;
        renderQrBannerForOwner();
        setActiveViewRefreshIfBlocked();
    }

    function renderQrBannerForOwner() {
        const banner = $('qrBanner');
        if (state.me.role === 'owner' && !state.linked) {
            banner.style.display = 'block';
            if (state.qrTimer) clearInterval(state.qrTimer);
            const pollQr = async () => {
                try {
                    const result = await apiFetch('/api/qr');
                    if (result.linked) {
                        state.linked = true;
                        renderConnectionDependentUi();
                        return;
                    }
                    if (result.qr) {
                        $('qrImage').src = result.qr;
                        $('qrImage').style.display = 'block';
                        $('qrWaiting').style.display = 'none';
                    } else {
                        $('qrImage').style.display = 'none';
                        $('qrWaiting').style.display = 'block';
                    }
                } catch (error) { /* polling QR dijalan lagi */ }
            };
            pollQr();
            state.qrTimer = setInterval(pollQr, 3000);
        } else {
            banner.style.display = 'none';
            if (state.qrTimer) clearInterval(state.qrTimer);
        }
    }

    /** Refresh tampilan aktif kalau sedang diblokir status koneksi. */
    function setActiveViewRefreshIfBlocked() {
        if (state.activeView === 'chat') {
            const el = $('chatView');
            if (el) renderChatView();
        }
    }

    async function refreshAllData() {
        if (!state.me) return;
        await Promise.all([loadChats(), loadLabels()]);
        if (state.activeView === 'status') refreshStatusView();
    }

    //====================================================================== 
    // CHAT WA
    // ======================================================================

    async function loadChats() {
        if (!state.me) return;
        state.chats = await apiFetch('/api/chats');
        if (state.activeView === 'chat') renderChatListOnly();
    }

    async function loadLabels() {
        if (!state.me) return;
        state.labels = await apiFetch('/api/labels');
    }

    async function renderChatView() {
        await loadLabels();
        if (!state.linked && state.me.role !== 'owner') {
            $('chatView').innerHTML = `
                <div class="unlinked-warning">
                    <h2>⚠️ Nomor tidak tertaut</h2>
                    <p>Hubungi owner untuk melakukan pengaitan ulang nomor bisnis.</p>
                </div>`;
            return;
        }
        await loadChats();

        const activeChat = state.chats.find(chat => chat.jid === state.activeJid);

        $('chatView').innerHTML = `
            <div class="chat-layout">
                <div class="card chat-list" id="chatListCard">
                    <div class="card-title">💬 Daftar Customer</div>
                    <div id="chatList"></div>
                </div>
                <div class="card chat-detail">
                    ${activeChat ? renderChatDetail(activeChat) : '<div class="chat-empty">Pilih customer untuk membuka percakapan</div>'}
                </div>
            </div>`;

        renderChatListOnly();

        if (state.activeJid) scrollChatToBottom();
    }

    function renderChatListOnly() {
        const listEl = $('chatList');
        if (!listEl) return;

        if (!state.chats || state.chats.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:14px;">Belum ada customer yang chat.</div>';
            return;
        }

        listEl.innerHTML = state.chats.map(chat => {
            const initial = String(chat.name || '?').trim().charAt(0).toUpperCase();
            const labelChips = (chat.labels || []).map(id => {
                const label = state.labels.find(l => l.id === id);
                if (!label) return '';
                return `<span class="label-chip" style="background:${label.color}">${escapeHtml(label.name)}</span>`;
            }).join('');

            const preview = chat.lastMessage
                ? (chat.lastMessage.type === 'image' ? '📷 ' : chat.lastMessage.type === 'video' ? '🎬 ' : '') + (chat.lastMessage.text || (chat.lastMessage.media ? '📎 Media' : ''))
                : 'Belum ada pesan';

            return `
                <div class="chat-item ${chat.jid === state.activeJid ? 'active' : ''}" data-jid="${escapeHtml(chat.jid)}">
                    <div class="chat-avatar">${escapeHtml(initial)}</div>
                    <div class="chat-item-body">
                        <div class="chat-item-name">${escapeHtml(chat.name)}</div>
                        <div class="chat-item-phone">${escapeHtml(chat.number)}</div>
                        <div class="chat-item-preview">${escapeHtml(preview)}</div>
                        <div class="chat-label-chips">${labelChips}</div>
                    </div>
                </div>`;
        }).join('');

        listEl.querySelectorAll('.chat-item').forEach(item => {
            item.addEventListener('click', () => openChat(item.dataset.jid));
        });
    }

    function renderChatDetail(chat) {
        return `
            <div class="chat-detail-header">
                <div>
                    <div class="chat-detail-name">${escapeHtml(chat.name)}</div>
                    <div class="chat-detail-phone">${escapeHtml(chat.number)} · ${escapeHtml(chat.name)}</div>
                </div>
                <button id="btnLabels" class="btn-ghost">🏷️ Label</button>
            </div>
            <div class="chat-messages" id="chatMessages"><div style="color:var(--text-dim);font-size:13px;">Memuat pesan…</div></div>
            <div class="chat-input-row">
                <input id="chatInput" class="field-input" placeholder="Tulis balasan ke customer…" />
                <button id="btnSend" class="btn-primary">Kirim</button>
            </div>`;
    }

    async function openChat(jid, keepSilent) {
        state.activeJid = jid;
        const chat = state.chats.find(item => item.jid === jid);
        if (!chat) return;

        renderChatListOnly();
        const detailCard = document.querySelector('.chat-detail');
        if (!detailCard) { renderChatView(); return; }
        detailCard.innerHTML = renderChatDetail(chat);

        renderLabelChipInHeader(chat);
        bindChatActions(jid);
        await refreshChatMessages(jid);
    }

    function renderLabelChipInHeader(chat) {
        const chips = (chat.labels || []).map(id => {
            const label = state.labels.find(item => item.id === id);
            return label ? `<span class="label-chip" style="background:${label.color}">${escapeHtml(label.name)}</span>` : '';
        }).join('');
        const phoneEl = document.querySelector('.chat-detail-phone');
        if (phoneEl && chips) phoneEl.insertAdjacentHTML('afterend', `<div class="chat-label-chips">${chips}</div>`);
    }

    function bindChatActions(jid) {
        const sendBtn = $('btnSend');
        const input = $('chatInput');
        const labelsBtn = $('btnLabels');

        const send = async () => {
            const text = input.value.trim();
            if (!text) return;
            sendBtn.disabled = true;
            try {
                const result = await apiFetch(`/api/chats/${encodeURIComponent(jid)}/send`, {
                    method: 'POST',
                    body: JSON.stringify({ text })
                });
                input.value = '';
                appendBubble(result.message, true);
                scrollChatToBottom();
                loadChats();
            } catch (error) {
                showToast(error.message, 'error');
            } finally {
                sendBtn.disabled = false;
            }
        };

        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') send(); });
        labelsBtn.addEventListener('click', () => openLabelModal(jid));
    }

    async function refreshChatMessages(jid) {
        const messages = await apiFetch(`/api/chats/${encodeURIComponent(jid)}/messages`);
        const container = $('chatMessages');
        if (!container) return;
        if (!messages.length) {
            container.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Belum ada pesan.</div>';
            return;
        }
        container.innerHTML = messages.map(message => renderBubble(message)).join('');
        scrollChatToBottom();
    }

    function renderBubble(message) {
        let inner = '';
        if (message.type === 'image' && message.media) {
            inner += `<img src="/media/${encodeURIComponent(message.media)}" alt="Foto" loading="lazy" />`;
        }
        if (message.type === 'sticker' && message.media) {
            inner += `<img src="/media/${encodeURIComponent(message.media)}" alt="Sticker" style="max-width:120px;" />`;
        }
        if (['video', 'audio', 'document'].includes(message.type) && message.media) {
            inner += `<div>📎 <span style="font-size:12px;">${escapeHtml(message.type.toUpperCase())}</span><br>
                <a class="media-download" href="/media/${encodeURIComponent(message.media)}" download>Unduh lampiran</a></div>`;
        }
        if (message.type === 'contact' || message.type === 'location' || message.type === 'reaction') {
            inner += `<div>📌 ${escapeHtml(message.text || message.type)}</div>`;
        }
        if (message.text) inner += `<div>${escapeHtml(message.text)}</div>`;
        if (!inner) inner = '<div style="color:var(--text-dim);">[Media]</div>';

        return `
            <div class="msg-row ${message.fromMe ? 'me' : ''}">
                <div class="bubble">
                    ${inner}
                    <div class="msg-time">${formatTime(message.at)}${message.viaWeb ? ' · dari web' : ''}</div>
                </div>
            </div>`;
    }

    function appendBubble(message) {
        const container = $('chatMessages');
        if (!container) return;
        if (container.querySelector('[style*="Belum ada pesan"]')) container.innerHTML = '';
        container.insertAdjacentHTML('beforeend', renderBubble(message));
    }

    function scrollChatToBottom() {
        const container = $('chatMessages');
        if (container) container.scrollTop = container.scrollHeight;
    }

    // ======================================================================
    // LABEL MODAL
    // ======================================================================

    function openLabelModal(jid) {
        const chat = state.chats.find(item => item.jid === jid);
        const assigned = new Set(chat ? (chat.labels || []) : []);

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal">
                <h3>Labels — ${escapeHtml(chat ? chat.name : '')}</h3>
                <div id="labelOptionList">
                    ${state.labels.map(label => `
                        <label class="label-option">
                            <input type="checkbox" data-label-id="${label.id}" ${assigned.has(label.id) ? 'checked' : ''} />
                            <span class="label-chip" style="background:${label.color}">${escapeHtml(label.name)}</span>
                            ${label.system ? '<span class="badge badge-neutral">otomatis</span>' : ''}
                        </label>`).join('') || '<div style="color:var(--text-dim);font-size:13px;">Belum ada label.</div>'}
                </div>
                <div class="new-label-row">
                    <input id="newLabelName" class="field-input" placeholder="Buat label baru…" />
                    <button id="btnNewLabel" class="btn-ghost">+ Buat</button>
                </div>
                <div class="modal-actions">
                    <button id="btnCancelLabels" class="btn-ghost">Batal</button>
                    <button id="btnSaveLabels" class="btn-primary" style="margin-top:0;">Simpan</button>
                </div>
            </div>`;

        document.body.appendChild(backdrop);

        backdrop.querySelector('#btnCancelLabels').addEventListener('click', () => backdrop.remove());
        backdrop.querySelector('#btnNewLabel').addEventListener('click', async () => {
            const name = backdrop.querySelector('#newLabelName').value.trim();
            if (!name) return;
            try {
                const created = await apiFetch('/api/labels', { method: 'POST', body: JSON.stringify({ name }) });
                await loadLabels();
                openLabelModal(jid);
                showToast(`Label "${created.name}" dibuat.`, 'success');
            } catch (error) {
                showToast(error.message, 'error');
            }
        });
        backdrop.querySelector('#btnSaveLabels').addEventListener('click', async () => {
            const ids = Array.from(backdrop.querySelectorAll('input[data-label-id]:checked'))
                .map(input => input.dataset.labelId);
            try {
                await apiFetch(`/api/chats/${encodeURIComponent(jid)}/labels`, {
                    method: 'POST',
                    body: JSON.stringify({ labelIds: ids })
                });
                backdrop.remove();
                showToast('Label tersimpan.', 'success');
                await loadChats();
                await loadLabels();
                openChat(jid, true);
            } catch (error) {
                showToast(error.message, 'error');
            }
        });
    }

    // ======================================================================
    // SETTING (OWNER)
    // ======================================================================

    async function renderSettingView() {
        const data = await apiFetch('/api/settings');
        const viewEl = $('settingView');
        const isOwner = state.me.role === 'owner';

        viewEl.innerHTML = `
            <div class="card">
                <div class="card-title">⚙️ Otomatisasi Bot</div>
                <div class="toggle-row">
                    <div>
                        <div class="toggle-name">Auto Reply</div>
                        <div class="toggle-desc">Balasan otomatis + flyer promo untuk customer baru (cooldown 24 jam).</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="toggleAutoReply" ${data.autoReply ? 'checked' : ''} ${isOwner ? '' : 'disabled'} />
                        <span class="switch-slider"></span>
                    </label>
                </div>
                <div class="toggle-row">
                    <div>
                        <div class="toggle-name">Auto Broadcast</div>
                        <div class="toggle-desc">Broadcast promo otomatis (Status + Channel) jadwal 06:00 / 12:00 / 15:00 WIB.</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="toggleAutoBroadcast" ${data.autoBroadcast ? 'checked' : ''} ${isOwner ? '' : 'disabled'} />
                        <span class="switch-slider"></span>
                    </label>
                </div>
                <div class="meta-line">Terakhir ditautkan: <b>${data.lastLinkedAt ? formatTime(data.lastLinkedAt) : 'Belum pernah'}</b></div>
            </div>

            ${isOwner ? `
            <div class="card">
                <div class="card-title">🔗 Tautan Ulang Nomor Bot</div>
                <p style="font-size:13px;color:var(--text-dim);">Jika bot tidak tertaut, pastikan dirimu login lalu scan QR di banner bagian atas halaman ini.</p>
                <div id="settingQrStatus" class="meta-line">Status: <b id="qrStatusText">…</b></div>
            </div>

            <div class="card">
                <div class="card-title">⚠️ Zona Bahaya</div>
                <button id="btnResetAll" class="btn-danger">Reset Semua Data (Settingan)</button>
                <p class="meta-line">Mengembalikan seluruh setingan ke default. Data karyawan, chat dan label tetap aman.</p>
            </div>` : ''}`;

        if (isOwner) {
            $('toggleAutoReply').addEventListener('change', (event) => updateToggle('autoReply', event.target.checked));
            $('toggleAutoBroadcast').addEventListener('change', (event) => updateToggle('autoBroadcast', event.target.checked));
            $('btnResetAll').addEventListener('click', onResetAll);

            const statusLine = $('qrStatusText');
            try {
                const qrData = await apiFetch('/api/qr');
                statusLine.textContent = qrData.linked ? 'Terhubung ✅' : (qrData.qr ? 'Belum tertaut — QR tersedia di atas' : 'Belum tertaut — menunggu QR…');
            } catch (error) {
                statusLine.textContent = 'Tidak dapat memuat status.';
            }
        }
    }

    async function updateToggle(key, value) {
        try {
            await apiFetch('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ [key]: value })
            });
            showToast(`${key === 'autoReply' ? 'Auto Reply' : 'Auto Broadcast'} ${value ? 'dihidupkan' : 'dimatikan'}.`, 'success');
        } catch (error) {
            showToast(error.message, 'error');
            renderSettingView();
        }
    }

    async function onResetAll() {
        if (!confirm('Yakin reset semua settingan ke default? Data karyawan/chat/label aman.')) return;
        try {
            await apiFetch('/api/settings/reset', { method: 'POST' });
            showToast('Semua settingan berhasil direset ke default.', 'success');
            renderSettingView();
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    // ======================================================================
    // STATUS
    // ======================================================================

    async function refreshStatusView() {
        const viewEl = $('statusView');
        if (!viewEl) return;
        let data;
        try { data = await apiFetch('/api/status'); } catch (error) { toastNotice(error.message); return; }

        viewEl.innerHTML = `
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="stat-label">Status Bot</div>
                    <div class="stat-value">${data.linked ? '🟢' : '🔴'}</div>
                    <span class="badge ${data.linked ? 'badge-ok' : 'badge-off'}">${data.linked ? 'Terhubung' : 'Tidak Tertaut'}</span>
                    ${data.botNumber ? `<div class="meta-line">Nomor bot: <b>${escapeHtml(data.botNumber)}</b></div>` : ''}
                </div>
                <div class="stat-card">
                    <div class="stat-label">Latency</div>
                    <div class="stat-value">${data.latencyMs != null ? escapeHtml(String(data.latencyMs)) + ' <span style="font-size:14px;">ms</span>' : '—'}</div>
                    <span class="badge ${data.latencyMs != null ? 'badge-ok' : 'badge-warn'}">${data.latencyMs != null ? 'Stabil' : 'Jaringan belum aktif'}</span>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Customer Dilayani (Total)</div>
                    <div class="stat-value">${data.customersTotal}</div>
                    <span class="badge badge-neutral">${data.customersNewToday} baru hari ini</span>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Pesan Hari Ini</div>
                    <div class="stat-value">${data.messagesToday}</div>
                    <span class="badge badge-neutral">Semua arah</span>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Uptime Server Panel</div>
                    <div class="stat-value" style="font-size:19px;">${formatUptime(data.uptimeMs)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Terakhir Tertaut</div>
                    <div class="stat-value" style="font-size:17px;">${data.lastLinkedAt ? formatTime(data.lastLinkedAt) : '—'}</div>
                </div>
            </div>

            <div class="card" style="margin-top:16px;">
                <div class="card-title">Otomatisasi Saat Ini</div>
                <div class="toggle-row">
                    <div class="toggle-name">Auto Reply</div>
                    <span class="badge ${data.settings.autoReply ? 'badge-ok' : 'badge-off'}">${data.settings.autoReply ? 'Aktif' : 'Nonaktif'}</span>
                </div>
                <div class="toggle-row">
                    <div class="toggle-name">Auto Broadcast</div>
                    <span class="badge ${data.settings.autoBroadcast ? 'badge-ok' : 'badge-off'}">${data.settings.autoBroadcast ? 'Aktif' : 'Nonaktif'}</span>
                </div>
            </div>`;
    }

    function toastNotice(message) { showToast(message, 'error'); }

    // ======================================================================
    // KARYAWAN (OWNER)
    // ======================================================================

    async function refreshEmployeesView() {
        const viewEl = $('employeesView');
        if (!viewEl) return;
        if (state.me.role !== 'owner') {
            viewEl.innerHTML = '<div class="unlinked-warning"><h2>Khusus Owner</h2></div>';
            return;
        }

        let employees = [];
        try { employees = await apiFetch('/api/employees'); } catch (error) {
            viewEl.innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`;
            return;
        }

        viewEl.innerHTML = `
            <div class="card">
                <div class="card-title">➕ Tambah Karyawan</div>
                <div class="add-employee-row">
                    <input id="newEmployeePhone" class="field-input" type="tel" placeholder="Nomor telepon karyawan (08…)" />
                    <button id="btnAddEmployee" class="btn-primary" style="margin-top:0;padding:11px 18px;">Daftarkan</button>
                </div>
                <p class="meta-line">Nomor akan didaftarkan dengan status <span class="badge badge-warn">unactivated</span>. Karyawan mendaftarkan password lewat halaman login, lalu verifikasi OTP dari WhatsApp bisnis.</p>
            </div>
            <div class="card">
                <div class="card-title">👥 Daftar Karyawan (${employees.length})</div>
                <div id="employeeList">${employees.map(renderEmployeeCard).join('')}</div>
            </div>`;

        $('btnAddEmployee').addEventListener('click', addEmployee);
        viewEl.querySelectorAll('.btn-reveal-pass').forEach(btn => {
            btn.addEventListener('click', () => {
                const span = document.getElementById('pass-' + btn.dataset.phone);
                span.style.display = span.style.display === 'none' ? 'inline' : 'none';
            });
        });
        viewEl.querySelectorAll('.btn-remove-emp').forEach(btn => {
            btn.addEventListener('click', () => removeEmployeeConfirm(btn.dataset.phone));
        });
    }

    function renderEmployeeCard(employee) {
        const statusBadge = employee.status === 'active'
            ? '<span class="badge badge-ok">Active</span>'
            : '<span class="badge badge-warn">unactivated</span>';

        return `
            <div class="employee-card">
                <div class="employee-main">
                    <div class="employee-name">${escapeHtml(employee.username || '—')} ${employee.role === 'owner' ? '<span class="badge badge-neutral">Owner</span>' : '<span class="badge badge-neutral">Karyawan</span>'}</div>
                    <div class="employee-sub">${escapeHtml(employee.displayPhone)} · didaftarkan ${formatTime(employee.createdAt)}</div>
                    ${employee.status === 'active' ? `<div class="employee-sub">Aktif sejak: <b>${formatTime(employee.activatedAt)}</b></div>` : ''}
                </div>
                <div class="employee-side">
                    ${employee.hasPassword ? `
                        <span class="reveal-password" id="pass-${employee.phone}" style="display:none;">${escapeHtml(employee.passwordPlain)}</span>
                        ${employee.role === 'owner' || state.me.role === 'owner' ? `<button class="btn-ghost btn-reveal-pass" data-phone="${escapeHtml(employee.phone)}">🔑 Password</button>` : ''}` : ''}
                    ${statusBadge}
                    ${employee.role !== 'owner' ? `<button class="btn-danger btn-remove-emp" data-phone="${escapeHtml(employee.phone)}">Remove</button>` : ''}
                </div>
            </div>`;
    }

    async function addEmployee() {
        const input = $('newEmployeePhone');
        const phone = input.value.trim();
        try {
            await apiFetch('/api/employees', { method: 'POST', body: JSON.stringify({ phone }) });
            showToast('Karyawan terdaftar (unactivated).', 'success');
            refreshEmployeesView();
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    async function removeEmployeeConfirm(phone) {
        if (!confirm('Hapus karyawan ini? Login mereka akan ditolak setelah dihapus.')) return;
        try {
            await apiFetch(`/api/employees/${encodeURIComponent(phone)}`, { method: 'DELETE' });
            showToast('Karyawan dihapus.', 'success');
            refreshEmployeesView();
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    // ======================================================================
    // WIRING EVENT LOGIN & BOOT
    // ======================================================================

    $('btnNext').addEventListener('click', () => {
        if ($('passwordArea').style.display === 'block') onPasswordNext();
        else onPhoneNext();
    });
    $('inputPhone').addEventListener('keydown', (event) => { if (event.key === 'Enter') onPhoneNext(); });
    $('btnOtpNext').addEventListener('click', onOtpNext);
    $('btnOtpResend').addEventListener('click', onOtpResend);
    $('btnUsernameNext').addEventListener('click', onUsernameNext);
    $('btnLogout').addEventListener('click', onLogout);

    bootLoadSession();

})();
