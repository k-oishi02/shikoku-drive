(function () {
    'use strict';

    const TRIP_DAYS = {
        'tab-day1': { key: 'day1', label: 'DAY 01', date: '2026-08-30' },
        'tab-day2': { key: 'day2', label: 'DAY 02', date: '2026-08-31' },
        'tab-day3': { key: 'day3', label: 'DAY 03', date: '2026-09-01' }
    };
    const CHECKLIST_KEY = 'shikoku-drive-checklist-v1';
    const EXPENSE_KEY = 'shikoku-drive-expenses-v1';
    let activeDelayMinutes = 0;

    function safeLoad(key, fallback) {
        try {
            const value = window.localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch (error) {
            return fallback;
        }
    }

    function safeSave(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            // Private browsing or storage restrictions should not break the guide.
        }
    }

    function parseCardTime(text) {
        const match = String(text || '').match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
        if (!match) return null;
        return {
            startMinute: Number(match[1]) * 60 + Number(match[2]),
            endMinute: Number(match[3]) * 60 + Number(match[4])
        };
    }

    function dateAtMinute(date, minute) {
        const hour = String(Math.floor(minute / 60)).padStart(2, '0');
        const mins = String(minute % 60).padStart(2, '0');
        return new Date(`${date}T${hour}:${mins}:00+09:00`);
    }

    function minuteLabel(minute) {
        const normalized = ((minute % 1440) + 1440) % 1440;
        return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
    }

    function isFixedCard(card) {
        const badge = card.querySelector('.j-tag-badge')?.textContent.trim().toUpperCase() || '';
        const title = card.querySelector('.j-card-ttl')?.textContent.trim() || '';
        return ['FLIGHT', 'BUS', 'FERRY'].includes(badge) ||
            /フェリー|四国水族館|五志喜|ポケモンセンター|松山空港店|Orange BAR/.test(title);
    }

    function getEntries(panelId) {
        const day = TRIP_DAYS[panelId];
        const panel = document.getElementById(panelId);
        if (!day || !panel) return [];

        return Array.from(panel.querySelectorAll('.j-card')).map((card, index) => {
            const timeEl = card.querySelector('.j-card-time');
            const parsed = parseCardTime(timeEl?.textContent);
            if (!parsed) return null;
            const title = card.querySelector('.j-card-ttl')?.textContent.replace(/\s+/g, ' ').trim() || '予定';
            const route = card.querySelector('.j-btn.primary, a[href*="google.com/maps"], a[href*="maps.app.goo.gl"]');
            return {
                index,
                card,
                timeEl,
                title,
                route: route?.href || '',
                fixed: isFixedCard(card),
                startMinute: parsed.startMinute,
                endMinute: parsed.endMinute,
                start: dateAtMinute(day.date, parsed.startMinute),
                end: dateAtMinute(day.date, parsed.endMinute)
            };
        }).filter(Boolean).sort((a, b) => a.startMinute - b.startMinute);
    }

    function getTokyoDateKey(date) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(date);
    }

    function formatDuration(milliseconds) {
        const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
        if (totalMinutes >= 1440) {
            const days = Math.floor(totalMinutes / 1440);
            const hours = Math.floor((totalMinutes % 1440) / 60);
            return `${days}日${hours}時間`;
        }
        if (totalMinutes >= 60) {
            return `${Math.floor(totalMinutes / 60)}時間${totalMinutes % 60}分`;
        }
        return `${totalMinutes}分`;
    }

    function dayPanelForDate(now) {
        const dateKey = getTokyoDateKey(now);
        return Object.keys(TRIP_DAYS).find(panelId => TRIP_DAYS[panelId].date === dateKey) || null;
    }

    function nearestTripPanel(now) {
        const todayPanel = dayPanelForDate(now);
        if (todayPanel) return todayPanel;
        const start = new Date('2026-08-30T00:00:00+09:00');
        const end = new Date('2026-09-01T23:59:59+09:00');
        if (now < start) return 'tab-day1';
        if (now > end) return 'tab-day3';
        return 'tab-day2';
    }

    function renderNowMode() {
        const dayEl = document.getElementById('now-day');
        const titleEl = document.getElementById('now-title');
        const timeEl = document.getElementById('now-time');
        const countdownEl = document.getElementById('now-countdown');
        const routeEl = document.getElementById('now-route');
        if (!dayEl || !titleEl || !timeEl || !countdownEl || !routeEl) return;

        const now = new Date();
        const tripStart = new Date('2026-08-30T06:55:00+09:00');
        const tripEnd = new Date('2026-09-01T21:20:00+09:00');
        let panelId = dayPanelForDate(now);
        let entry = null;
        let state = 'NEXT';

        if (now < tripStart) {
            panelId = 'tab-day1';
            entry = getEntries(panelId)[0];
            dayEl.textContent = 'DAY 01 · 旅行前';
            countdownEl.textContent = `出発まで ${formatDuration(tripStart - now)}`;
        } else if (now > tripEnd) {
            dayEl.textContent = 'TRIP COMPLETE';
            titleEl.textContent = '四国ドライブ、おつかれさまでした！';
            timeEl.textContent = 'MEMORIES SAVED';
            countdownEl.textContent = '';
            routeEl.hidden = true;
            return;
        } else if (panelId) {
            const entries = getEntries(panelId);
            const current = entries.find(item => now >= item.start && now < item.end);
            entry = current || entries.find(item => item.start > now) || entries[entries.length - 1];
            state = current ? 'NOW' : 'NEXT';
            dayEl.textContent = `${TRIP_DAYS[panelId].label} · ${state}`;
            countdownEl.textContent = current
                ? `終了まで ${formatDuration(entry.end - now)}`
                : `出発まで ${formatDuration(entry.start - now)}`;
        } else {
            const future = Object.keys(TRIP_DAYS)
                .flatMap(id => getEntries(id).map(item => ({ panelId: id, item })))
                .find(candidate => candidate.item.start > now);
            panelId = future?.panelId || 'tab-day3';
            entry = future?.item || getEntries(panelId).at(-1);
            dayEl.textContent = `${TRIP_DAYS[panelId].label} · NEXT`;
            countdownEl.textContent = `出発まで ${formatDuration(entry.start - now)}`;
        }

        if (!entry) return;
        titleEl.textContent = entry.title;
        timeEl.textContent = `${minuteLabel(entry.startMinute)} — ${minuteLabel(entry.endMinute)}`;
        if (entry.route) {
            routeEl.href = entry.route;
            routeEl.hidden = false;
        } else {
            routeEl.hidden = true;
        }
    }

    window.jumpToCurrentTripDay = function () {
        const panelId = nearestTripPanel(new Date());
        const button = document.querySelector(`[aria-controls="${panelId}"]`);
        if (typeof window.switchTab === 'function') window.switchTab(panelId, button);
        button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    };

    function selectedDayPanel() {
        const active = document.querySelector('.j-tab-panel.active')?.id;
        return TRIP_DAYS[active] ? active : nearestTripPanel(new Date());
    }

    function removeDelayBadges() {
        document.querySelectorAll('.delay-preview').forEach(element => element.remove());
    }

    window.applyDelayScenario = function (minutes, button) {
        activeDelayMinutes = Number(minutes) || 0;
        removeDelayBadges();
        document.querySelectorAll('[data-delay-minutes]').forEach(element => {
            element.classList.toggle('active', Number(element.dataset.delayMinutes) === activeDelayMinutes);
        });

        const panelId = selectedDayPanel();
        const entries = getEntries(panelId);
        const status = document.getElementById('delay-status');
        const dayLabel = TRIP_DAYS[panelId]?.label || 'DAY';

        if (!activeDelayMinutes) {
            if (status) status.textContent = `${dayLabel}の予定どおりです。`;
            return;
        }

        let shortened = 0;
        let squeezedMinutes = 0;
        entries.forEach((entry, index) => {
            const badge = document.createElement('span');
            badge.className = 'delay-preview';
            if (entry.fixed) {
                badge.classList.add('fixed');
                badge.textContent = `FIXED ${minuteLabel(entry.startMinute)}`;
            } else {
                const nextFixed = entries.slice(index + 1).find(candidate => candidate.fixed);
                const shiftedStart = entry.startMinute + activeDelayMinutes;
                let shiftedEnd = entry.endMinute + activeDelayMinutes;
                let conflict = 0;
                if (nextFixed && shiftedEnd > nextFixed.startMinute) {
                    conflict = shiftedEnd - nextFixed.startMinute;
                    shiftedEnd = Math.max(shiftedStart, nextFixed.startMinute);
                }
                badge.textContent = `${minuteLabel(shiftedStart)}–${minuteLabel(shiftedEnd)}`;
                if (conflict > 0) {
                    badge.classList.add('conflict');
                    badge.textContent += ` / ${conflict}分短縮`;
                    shortened += 1;
                    squeezedMinutes += conflict;
                }
            }
            entry.timeEl.appendChild(badge);
        });

        if (status) {
            status.textContent = shortened
                ? `${dayLabel} +${activeDelayMinutes}分：固定時刻を守るため${shortened}件を計${squeezedMinutes}分短縮します。`
                : `${dayLabel} +${activeDelayMinutes}分：固定時刻は維持したまま再計算しました。`;
        }
        button?.blur();
    };

    function setupTabDelayReset() {
        document.querySelectorAll('.j-tab-btn').forEach(button => {
            button.addEventListener('click', () => {
                window.setTimeout(() => {
                    if (activeDelayMinutes) window.applyDelayScenario(activeDelayMinutes);
                    else window.applyDelayScenario(0);
                }, 0);
            });
        });
    }

    function updateChecklistProgress() {
        const checks = Array.from(document.querySelectorAll('[data-check-id]'));
        const completed = checks.filter(input => input.checked).length;
        const progress = document.getElementById('checklist-progress');
        if (progress) progress.textContent = `${completed} / ${checks.length} COMPLETE`;
    }

    function setupChecklist() {
        const saved = safeLoad(CHECKLIST_KEY, {});
        document.querySelectorAll('[data-check-id]').forEach(input => {
            input.checked = Boolean(saved[input.dataset.checkId]);
            input.addEventListener('change', () => {
                const state = {};
                document.querySelectorAll('[data-check-id]').forEach(check => {
                    state[check.dataset.checkId] = check.checked;
                });
                safeSave(CHECKLIST_KEY, state);
                updateChecklistProgress();
            });
        });
        updateChecklistProgress();
    }

    window.resetChecklist = function () {
        if (!window.confirm('この端末に保存したチェック状態をすべて解除しますか？')) return;
        document.querySelectorAll('[data-check-id]').forEach(input => { input.checked = false; });
        safeSave(CHECKLIST_KEY, {});
        updateChecklistProgress();
    };

    function formatYen(value) {
        return new Intl.NumberFormat('ja-JP', {
            style: 'currency',
            currency: 'JPY',
            maximumFractionDigits: 0
        }).format(Math.round(value || 0));
    }

    function expenseLabel(expense) {
        const payer = expense.payer === 'aoi' ? 'あおい' : 'こうたろう';
        return `${expense.category} · ${payer}が支払い`;
    }

    function notifyExpenseAction(detail) {
        window.dispatchEvent(new CustomEvent('shikoku-expense-action', { detail }));
    }

    function renderExpenses() {
        const expenses = safeLoad(EXPENSE_KEY, []);
        const list = document.getElementById('expense-list');
        if (!list) return;
        list.replaceChildren();

        let aoiPaid = 0;
        let kotaroPaid = 0;
        expenses.forEach(expense => {
            if (expense.payer === 'aoi') aoiPaid += Number(expense.amount);
            else kotaroPaid += Number(expense.amount);

            const row = document.createElement('li');
            const textBox = document.createElement('div');
            const title = document.createElement('strong');
            const detail = document.createElement('small');
            const amount = document.createElement('strong');
            const remove = document.createElement('button');
            title.textContent = expense.note || expense.category;
            detail.textContent = expenseLabel(expense);
            amount.textContent = formatYen(expense.amount);
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `${title.textContent}を削除`);
            remove.addEventListener('click', () => removeExpense(expense.id));
            textBox.append(title, detail);
            row.append(textBox, amount, remove);
            list.appendChild(row);
        });

        const total = aoiPaid + kotaroPaid;
        const share = total / 2;
        document.getElementById('expense-total').textContent = formatYen(total);
        document.getElementById('expense-share').textContent = formatYen(share);
        const settlement = document.getElementById('expense-settlement');
        if (!total) {
            settlement.textContent = 'まだ支出はありません';
        } else {
            const aoiCredit = aoiPaid - share;
            if (Math.abs(aoiCredit) < 0.5) settlement.textContent = '精算済み';
            else if (aoiCredit > 0) settlement.textContent = `こうたろう → あおい ${formatYen(aoiCredit)}`;
            else settlement.textContent = `あおい → こうたろう ${formatYen(-aoiCredit)}`;
        }
    }

    function removeExpense(id) {
        const expenses = safeLoad(EXPENSE_KEY, []).filter(expense => expense.id !== id);
        safeSave(EXPENSE_KEY, expenses);
        renderExpenses();
        notifyExpenseAction({ type: 'remove', id });
    }

    function setupExpenses() {
        const form = document.getElementById('expense-form');
        form?.addEventListener('submit', event => {
            event.preventDefault();
            const amount = Number(document.getElementById('expense-amount').value);
            if (!Number.isFinite(amount) || amount <= 0) return;
            const expenses = safeLoad(EXPENSE_KEY, []);
            const expense = {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                amount: Math.round(amount),
                payer: document.getElementById('expense-payer').value,
                category: document.getElementById('expense-category').value,
                note: document.getElementById('expense-note').value.trim(),
                createdAt: new Date().toISOString()
            };
            expenses.unshift(expense);
            safeSave(EXPENSE_KEY, expenses);
            form.reset();
            renderExpenses();
            notifyExpenseAction({ type: 'upsert', expense });
        });
        window.addEventListener('shikoku-expenses-remote', event => {
            const expenses = Array.isArray(event.detail) ? event.detail : [];
            safeSave(EXPENSE_KEY, expenses);
            renderExpenses();
        });
        renderExpenses();
    }

    window.clearExpenses = function () {
        if (!window.confirm('二人の共有台帳から支出をすべて削除しますか？')) return;
        safeSave(EXPENSE_KEY, []);
        renderExpenses();
        notifyExpenseAction({ type: 'clear' });
    };

    function updateNetworkStatus() {
        const status = document.getElementById('offline-status');
        if (!status) return;
        const online = window.navigator.onLine;
        status.textContent = online ? 'ONLINE' : 'OFFLINE READY';
        status.classList.toggle('offline', !online);
    }

    function setupOfflineSupport() {
        updateNetworkStatus();
        window.addEventListener('online', updateNetworkStatus);
        window.addEventListener('offline', updateNetworkStatus);
        if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js').catch(() => {
                    const status = document.getElementById('offline-status');
                    if (status) status.textContent = 'ONLINE';
                });
            });
        }
    }

    function openLinkedTab() {
        const panelId = window.location.hash.slice(1);
        if (!/^tab-(day[1-3]|checklist|paypay)$/.test(panelId)) return;
        const button = document.querySelector(`[aria-controls="${panelId}"]`);
        if (typeof window.switchTab === 'function') window.switchTab(panelId, button);
    }

    function initEnhancements() {
        setupChecklist();
        setupExpenses();
        setupOfflineSupport();
        setupTabDelayReset();
        openLinkedTab();
        window.applyDelayScenario(0);
        renderNowMode();
        window.setInterval(renderNowMode, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEnhancements, { once: true });
    } else {
        initEnhancements();
    }
})();
