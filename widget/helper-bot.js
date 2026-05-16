/**
 * Global Storefront — Customer Chat Widget
 *
 * Drop this on any client site with:
 * <script src="https://globalstorefront.netlify.app/widget/helper-bot.js" data-tenant="TENANT_RECORD_ID" defer></script>
 *
 * Optional attributes:
 *   data-tenant  — Required. The client's Airtable record ID from the Clients table.
 *   data-color   — Optional. Brand primary color hex (e.g., "#955418"). Defaults to gold.
 *   data-name    — Optional. Bot display name (e.g., "Glaze"). Defaults to "Store Helper".
 *   data-welcome — Optional. Custom welcome message.
 */
(function() {
    'use strict';

    // Find our script tag and read config
    const scriptTag = document.currentScript || document.querySelector('script[data-tenant]');
    if (!scriptTag) return;

    const TENANT_ID = scriptTag.getAttribute('data-tenant');
    if (!TENANT_ID) {
        console.warn('[GlobalStorefront] Missing data-tenant attribute');
        return;
    }

    const BRAND_COLOR = scriptTag.getAttribute('data-color') || '#d4af37';
    const BOT_NAME = scriptTag.getAttribute('data-name') || 'Store Helper';
    const WELCOME_MSG = scriptTag.getAttribute('data-welcome') || `Hi! I'm ${BOT_NAME}. Ask me anything about this store — hours, menu, services, or policies.`;
    const API_BASE = scriptTag.src.replace('/widget/helper-bot.js', '/api');

    // State
    let isOpen = false;
    let sessionId = sessionStorage.getItem('gs_chat_session') || ('sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    let conversationId = sessionStorage.getItem('gs_chat_conv') || null;
    let messages = JSON.parse(sessionStorage.getItem('gs_chat_messages') || '[]');
    let isWaitingForOwner = sessionStorage.getItem('gs_chat_waiting') === 'true';
    let pollTimer = null;
    let lastSendTime = 0;

    sessionStorage.setItem('gs_chat_session', sessionId);

    // --- Inject CSS ---
    const style = document.createElement('style');
    style.textContent = `
        .gs-widget-bubble {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: ${BRAND_COLOR};
            box-shadow: 0 4px 20px rgba(0,0,0,0.25);
            cursor: pointer;
            z-index: 99998;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
            border: none;
            outline: none;
        }
        .gs-widget-bubble:hover {
            transform: scale(1.08);
            box-shadow: 0 6px 28px rgba(0,0,0,0.35);
        }
        .gs-widget-bubble:active { transform: scale(0.95); }
        .gs-widget-bubble svg {
            width: 26px; height: 26px;
            fill: none; stroke: #fff; stroke-width: 2;
            stroke-linecap: round; stroke-linejoin: round;
        }
        .gs-widget-bubble.gs-has-reply::after {
            content: '';
            position: absolute;
            top: 2px; right: 2px;
            width: 14px; height: 14px;
            background: #ef4444;
            border-radius: 50%;
            border: 2px solid #fff;
        }

        .gs-widget-panel {
            position: fixed;
            bottom: 92px;
            right: 24px;
            width: 360px;
            height: 520px;
            max-height: calc(100vh - 120px);
            background: #fff;
            border-radius: 16px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.2);
            z-index: 99999;
            display: none;
            flex-direction: column;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .gs-widget-panel.gs-open { display: flex; }

        @media (max-width: 540px) {
            .gs-widget-panel {
                position: fixed;
                inset: 0;
                width: 100%;
                height: 100%;
                max-height: 100%;
                border-radius: 0;
                bottom: 0;
                right: 0;
            }
            .gs-widget-bubble {
                bottom: 16px;
                right: 16px;
                width: 48px;
                height: 48px;
            }
            .gs-widget-bubble svg { width: 22px; height: 22px; }
        }

        .gs-panel-header {
            padding: 16px 18px;
            background: ${BRAND_COLOR};
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        .gs-panel-header__title {
            font-weight: 600;
            font-size: 0.95rem;
        }
        .gs-panel-header__close {
            background: none; border: none;
            color: #fff; cursor: pointer;
            padding: 4px; opacity: 0.8;
        }
        .gs-panel-header__close:hover { opacity: 1; }
        .gs-panel-header__close svg { width: 20px; height: 20px; }

        .gs-panel-messages {
            flex: 1;
            overflow-y: auto;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: #f8f9fa;
        }

        .gs-msg {
            max-width: 82%;
            padding: 10px 14px;
            border-radius: 14px;
            font-size: 0.88rem;
            line-height: 1.45;
            word-wrap: break-word;
        }
        .gs-msg--bot {
            background: #fff;
            align-self: flex-start;
            border: 1px solid #e8e8e8;
            border-bottom-left-radius: 4px;
            color: #333;
        }
        .gs-msg--user {
            background: ${BRAND_COLOR};
            color: #fff;
            align-self: flex-end;
            border-bottom-right-radius: 4px;
        }
        .gs-msg--owner {
            background: #e8f5e9;
            align-self: flex-start;
            border-bottom-left-radius: 4px;
            color: #2e7d32;
            border: 1px solid #c8e6c9;
        }
        .gs-msg--owner::before {
            content: '${BOT_NAME} (Staff)';
            display: block;
            font-size: 0.7rem;
            font-weight: 600;
            margin-bottom: 3px;
            opacity: 0.7;
        }
        .gs-msg--system {
            align-self: center;
            font-size: 0.75rem;
            color: #999;
            padding: 4px 12px;
            background: #f0f0f0;
            border-radius: 20px;
        }

        .gs-typing {
            align-self: flex-start;
            padding: 10px 16px;
            background: #fff;
            border: 1px solid #e8e8e8;
            border-radius: 14px;
            border-bottom-left-radius: 4px;
            display: none;
        }
        .gs-typing.gs-visible { display: flex; gap: 4px; }
        .gs-typing span {
            width: 6px; height: 6px;
            background: #bbb; border-radius: 50%;
            animation: gsBounce 1.2s infinite;
        }
        .gs-typing span:nth-child(2) { animation-delay: 0.2s; }
        .gs-typing span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes gsBounce {
            0%, 60%, 100% { transform: translateY(0); }
            30% { transform: translateY(-4px); }
        }

        .gs-panel-input {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 14px;
            border-top: 1px solid #eee;
            background: #fff;
            flex-shrink: 0;
        }
        .gs-panel-input input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #e0e0e0;
            border-radius: 20px;
            font-size: 0.88rem;
            outline: none;
            font-family: inherit;
        }
        .gs-panel-input input:focus { border-color: ${BRAND_COLOR}; }
        .gs-panel-input button {
            width: 36px; height: 36px;
            border-radius: 50%;
            background: ${BRAND_COLOR};
            border: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
            transition: transform 0.15s;
        }
        .gs-panel-input button:active { transform: scale(0.9); }
        .gs-panel-input button:disabled { opacity: 0.4; cursor: not-allowed; }
        .gs-panel-input button svg { width: 16px; height: 16px; stroke: #fff; fill: none; stroke-width: 2; }
    `;
    document.head.appendChild(style);

    // --- Inject HTML ---
    const bubble = document.createElement('button');
    bubble.className = 'gs-widget-bubble';
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    document.body.appendChild(bubble);

    const panel = document.createElement('div');
    panel.className = 'gs-widget-panel';
    panel.innerHTML = `
        <div class="gs-panel-header">
            <span class="gs-panel-header__title">${escapeHtml(BOT_NAME)}</span>
            <button class="gs-panel-header__close" aria-label="Close chat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        </div>
        <div class="gs-panel-messages" id="gsMessages"></div>
        <div class="gs-typing" id="gsTyping"><span></span><span></span><span></span></div>
        <div class="gs-panel-input">
            <input type="text" id="gsInput" placeholder="Type a message..." autocomplete="off">
            <button id="gsSend"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>
        </div>
    `;
    document.body.appendChild(panel);

    const messagesEl = panel.querySelector('#gsMessages');
    const inputEl = panel.querySelector('#gsInput');
    const sendBtn = panel.querySelector('#gsSend');
    const typingEl = panel.querySelector('#gsTyping');
    const closeBtn = panel.querySelector('.gs-panel-header__close');

    // --- Event handlers ---
    bubble.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('gs-open', isOpen);
        bubble.classList.remove('gs-has-reply');
        if (isOpen) {
            if (messages.length === 0) {
                messages.push({ role: 'bot', content: WELCOME_MSG });
                saveMessages();
            }
            renderMessages();
            inputEl.focus();
            if (isWaitingForOwner) startPolling();
        } else {
            stopPolling();
        }
    });

    closeBtn.addEventListener('click', () => {
        isOpen = false;
        panel.classList.remove('gs-open');
        stopPolling();
    });

    // Escape key closes
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) {
            isOpen = false;
            panel.classList.remove('gs-open');
            stopPolling();
        }
    });

    sendBtn.addEventListener('click', handleSend);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSend();
    });

    // --- Core logic ---
    async function handleSend() {
        const text = inputEl.value.trim();
        if (!text) return;

        // Rate limit: 1 message per 4 seconds
        if (Date.now() - lastSendTime < 4000) return;
        lastSendTime = Date.now();

        // Message count limit per session
        const userMsgCount = messages.filter(m => m.role === 'user').length;
        if (userMsgCount >= 40) {
            addMessage('system', 'Session limit reached. Please refresh to start a new conversation.');
            return;
        }

        addMessage('user', text);
        inputEl.value = '';
        sendBtn.disabled = true;
        typingEl.classList.add('gs-visible');

        try {
            // Build conversation history for context
            const history = messages
                .filter(m => m.role === 'user' || m.role === 'bot')
                .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

            const res = await fetch(`${API_BASE}/helper-bot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    tenantId: TENANT_ID,
                    sessionId: sessionId,
                    conversationHistory: history.slice(-6)
                })
            });

            const data = await res.json();

            if (data.reply) {
                addMessage('bot', data.reply);
            }

            // If escalated, trigger escalation and start polling
            if (data.escalate) {
                await triggerEscalation(text);
            }

        } catch (err) {
            addMessage('bot', 'Sorry, something went wrong. Please try again.');
        }

        typingEl.classList.remove('gs-visible');
        sendBtn.disabled = false;
    }

    async function triggerEscalation(originalMessage) {
        try {
            const res = await fetch(`${API_BASE}/escalate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tenantId: TENANT_ID,
                    customerName: 'Website Visitor',
                    customerEmail: '',
                    message: originalMessage,
                    sessionId: sessionId
                })
            });

            const data = await res.json();
            if (data.conversationId) {
                conversationId = data.conversationId;
                sessionStorage.setItem('gs_chat_conv', conversationId);
                isWaitingForOwner = true;
                sessionStorage.setItem('gs_chat_waiting', 'true');
                startPolling();
            }
        } catch (err) {
            // Escalation failed silently — bot already gave a helpful response
        }
    }

    function startPolling() {
        if (pollTimer || !conversationId) return;
        pollTimer = setInterval(pollForReplies, 3000);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function pollForReplies() {
        if (!conversationId) return;

        try {
            const res = await fetch(`${API_BASE}/customer-poll?conversationId=${conversationId}`);
            const data = await res.json();

            if (data.messages && data.messages.length > 0) {
                for (const msg of data.messages) {
                    addMessage('owner', msg.content);
                }
                // Notify if panel is closed
                if (!isOpen) {
                    bubble.classList.add('gs-has-reply');
                }
            }

            if (data.status === 'resolved') {
                addMessage('system', 'This conversation has been resolved. Thank you!');
                isWaitingForOwner = false;
                sessionStorage.setItem('gs_chat_waiting', 'false');
                stopPolling();
            }
        } catch (err) {
            // Silent fail on poll
        }
    }

    // --- Rendering ---
    function addMessage(role, content) {
        messages.push({ role, content });
        saveMessages();
        renderMessages();
    }

    function renderMessages() {
        messagesEl.innerHTML = messages.map(m => {
            const cls = m.role === 'user' ? 'user' : m.role === 'owner' ? 'owner' : m.role === 'system' ? 'system' : 'bot';
            return `<div class="gs-msg gs-msg--${cls}">${escapeHtml(m.content)}</div>`;
        }).join('');
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function saveMessages() {
        sessionStorage.setItem('gs_chat_messages', JSON.stringify(messages));
    }

    // --- Utilities ---
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Boot ---
    // If there are existing messages from this session, restore state
    if (messages.length > 0 && isWaitingForOwner && conversationId) {
        // Start polling in background even if widget is closed
        startPolling();
    }

})();
