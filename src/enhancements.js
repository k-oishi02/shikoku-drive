(function () {
    'use strict';

    let TRIP_DAYS = {};
    let CHECKLIST_KEY = 'checklist-default-v1';
    let EXPENSE_KEY = 'expenses-default-v1';
    const DEVICE_OWNER_KEY = 'shiori-device-owner-v2';
    let lastEnhancedPanel = null;
    let lastEnhancedTripId = '';
    let enhancementRunId = 0;
    let remoteExpensesBound = false;

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

    function escapeMarkup(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function expenseStorageKey(tripId, ledgerToken) {
        const safeTripId = /^[A-Za-z0-9_-]+$/.test(String(tripId || '')) ? String(tripId) : 'default';
        const safeLedger = /^[A-Za-z0-9_-]{43}$/.test(String(ledgerToken || '')) ? String(ledgerToken) : 'local';
        return `expenses-${safeTripId}-${safeLedger}-v2`;
    }

    function deviceOwnerStorageKey() {
        const tripId = /^[A-Za-z0-9_-]+$/.test(String(window.currentTripId || ''))
            ? String(window.currentTripId)
            : 'default';
        const ledger = /^[A-Za-z0-9_-]{43}$/.test(String(window.currentTripLedgerToken || ''))
            ? String(window.currentTripLedgerToken)
            : 'local';
        return `${DEVICE_OWNER_KEY}-${tripId}-${ledger}`;
    }

    function currentLedgerAccess() {
        const access = window.currentLedgerAccess;
        return access && typeof access === 'object'
            ? { uid: String(access.uid || ''), isAdmin: access.isAdmin === true }
            : { uid: '', isAdmin: false };
    }

    function canRemoveExpense(expense) {
        if (!window.currentTripLedgerToken) return true;
        const access = currentLedgerAccess();
        if (access.isAdmin) return true;
        const creatorUid = String(expense?.creatorUid || '');
        if (creatorUid) return Boolean(access.uid && creatorUid === access.uid);
        return expense?.pendingSync === true
            || Boolean(access.uid && String(expense?.payer || '') === access.uid);
    }

    window.setExpenseStorageScope = function (tripId, ledgerToken) {
        EXPENSE_KEY = expenseStorageKey(tripId, ledgerToken);
        renderExpenses();
    };
    window.setLedgerDeviceOwner = value => safeSave(deviceOwnerStorageKey(), String(value || ''));
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
    function getEntries(panelId) {
        const day = TRIP_DAYS[panelId];
        const panel = document.getElementById(panelId);
        if (!day || !panel) return [];

        return Array.from(panel.querySelectorAll('.j-card')).map((card, index) => {
            const timeEl = card.querySelector('.j-card-time');
            const parsed = parseCardTime(timeEl?.textContent);
            if (!parsed) return null;
            const titleClone = card.querySelector('.j-card-ttl')?.cloneNode(true);
            titleClone?.querySelector('.j-tag-badge')?.remove();
            const title = titleClone?.textContent.replace(/\s+/g, ' ').trim() || '予定';
            const route = Array.from(card.querySelectorAll('a[href]')).find(link =>
                /^ROUTE\s*↗?$/i.test(link.textContent.trim())
            );
            const map = card.querySelector('.j-btn.primary, a[href*="google.com/maps"]');
            const action = route || map;
            return {
                index,
                card,
                timeEl,
                title,
                route: action?.href || '',
                routeLabel: route ? 'NEXT ROUTE' : map ? 'NEXT MAP' : '',
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
        const panels = Object.keys(TRIP_DAYS).sort((a, b) => TRIP_DAYS[a].date.localeCompare(TRIP_DAYS[b].date));
        if (!panels.length) return null;
        const first = new Date(`${TRIP_DAYS[panels[0]].date}T00:00:00+09:00`);
        const last = new Date(`${TRIP_DAYS[panels[panels.length - 1]].date}T23:59:59+09:00`);
        if (now < first) return panels[0];
        if (now > last) return panels[panels.length - 1];
        return panels.find(panelId => new Date(`${TRIP_DAYS[panelId].date}T00:00:00+09:00`) <= now && now <= new Date(`${TRIP_DAYS[panelId].date}T23:59:59+09:00`)) || panels[0];
    }

    function renderNowMode() {
        const dayEl = document.getElementById('now-day');
        const titleEl = document.getElementById('now-title');
        const timeEl = document.getElementById('now-time');
        const countdownEl = document.getElementById('now-countdown');
        const routeEl = document.getElementById('now-route');
        if (!dayEl || !titleEl || !timeEl || !countdownEl || !routeEl) return;

        const now = new Date();
        const timeline = Object.keys(TRIP_DAYS).flatMap(panelId => getEntries(panelId)).sort((a, b) => a.start - b.start);
        const fallbackDate = window.currentTripDate || getTokyoDateKey(now);
        const tripStart = timeline[0]?.start || new Date(`${Object.values(TRIP_DAYS)[0]?.date || fallbackDate}T00:00:00+09:00`);
        const tripEnd = timeline.at(-1)?.end || new Date(`${Object.values(TRIP_DAYS).at(-1)?.date || fallbackDate}T23:59:59+09:00`);
        let panelId = dayPanelForDate(now);
        let entry = null;
        let routeEntry = null;

        if (now < tripStart) {
            panelId = Object.keys(TRIP_DAYS).sort((a, b) => TRIP_DAYS[a].date.localeCompare(TRIP_DAYS[b].date))[0];
            entry = getEntries(panelId)[0];
            dayEl.textContent = `${TRIP_DAYS[panelId]?.label || 'DAY 01'} · 旅行前`;
            countdownEl.textContent = `出発まで ${formatDuration(tripStart - now)}`;
            if (getTokyoDateKey(now) === TRIP_DAYS[panelId]?.date && entry) {
                routeEntry = entry;
            }
        } else if (now > tripEnd) {
            dayEl.textContent = 'TRIP COMPLETE';
            titleEl.textContent = '旅行、おつかれさまでした！';
            timeEl.textContent = 'MEMORIES SAVED';
            countdownEl.textContent = '';
            routeEl.hidden = true;
            return;
        } else if (panelId) {
            const entries = getEntries(panelId);
            const currentIndex = entries.findIndex(item => now >= item.start && now < item.end);
            const current = currentIndex >= 0 ? entries[currentIndex] : null;
            const next = current ? entries[currentIndex + 1] : entries.find(item => item.start > now);
            entry = current || next || entries.at(-1);
            dayEl.textContent = `${TRIP_DAYS[panelId].label} · ${current ? 'NOW' : 'NEXT'}`;
            countdownEl.textContent = current
                ? `終了まで ${formatDuration(entry.end - now)}`
                : `出発まで ${formatDuration(entry.start - now)}`;
            if (next) routeEntry = next;
            else if (!current && entry) routeEntry = entry;
        } else {
            const future = Object.keys(TRIP_DAYS)
                .flatMap(id => getEntries(id).map(item => ({ panelId: id, item })))
                .find(candidate => candidate.item.start > now);
            panelId = future?.panelId || Object.keys(TRIP_DAYS).at(-1);
            entry = future?.item || getEntries(panelId).at(-1);
            dayEl.textContent = `${TRIP_DAYS[panelId]?.label || 'DAY'} · NEXT`;
            countdownEl.textContent = entry ? `出発まで ${formatDuration(entry.start - now)}` : '';
            if (entry) {
                routeEntry = entry;
            }
        }

        if (!entry) {
            routeEl.hidden = true;
            return;
        }
        titleEl.textContent = entry.title;
        timeEl.textContent = `${minuteLabel(entry.startMinute)} — ${minuteLabel(entry.endMinute)}`;
        if (routeEntry?.route || entry.route) {
            const actionEntry = routeEntry?.route ? routeEntry : entry;
            routeEl.href = actionEntry.route;
            routeEl.textContent = (actionEntry.routeLabel || 'NEXT MAP') + ' →';
            routeEl.hidden = false;
        } else {
            routeEl.hidden = true;
        }
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
            if (input.dataset.checklistBound === 'true') return;
            input.dataset.checklistBound = 'true';
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

    function expenseMembers() {
        const fallback = [{ id: 'local', name: String(localStorage.getItem('user_nickname') || '\u3053\u306e\u7aef\u672b').slice(0, 40) }];
        const source = Array.isArray(window.currentTripMembers) && window.currentTripMembers.length
            ? window.currentTripMembers
            : fallback;
        const seen = new Set();
        return source.map(member => ({
            id: String(member?.id || '').slice(0, 128),
            name: String(member?.name || member?.id || '参加者').slice(0, 40)
        })).filter(member => member.id && !seen.has(member.id) && seen.add(member.id));
    }

    function resolveExpensePayerId(payer, members) {
        const rawId = String(payer || '');
        const id = String(window.expensePayerAliases?.[rawId] || rawId);
        if (members.some(member => member.id === id)) return id;
        return id || members[0]?.id || 'local';
    }

    function expenseMemberName(id, members = expenseMembers()) {
        return members.find(member => member.id === id)?.name || window.memberNames?.[id] || id || '参加者';
    }

    function buildExpenseSettlements(members, paidBy, total) {
        const creditors = [];
        const debtors = [];
        const baseShare = members.length ? Math.floor(total / members.length) : 0;
        const remainder = members.length ? Math.round(total - (baseShare * members.length)) : 0;
        members.forEach((member, index) => {
            const targetShare = baseShare + (index < remainder ? 1 : 0);
            const balance = Number(paidBy.get(member.id) || 0) - targetShare;
            if (balance > 0.5) creditors.push({ ...member, amount: balance });
            if (balance < -0.5) debtors.push({ ...member, amount: -balance });
        });
        const transfers = [];
        let debtorIndex = 0;
        let creditorIndex = 0;
        while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
            const debtor = debtors[debtorIndex];
            const creditor = creditors[creditorIndex];
            const amount = Math.min(debtor.amount, creditor.amount);
            if (amount > 0.5) transfers.push(`${debtor.name} → ${creditor.name} ${formatYen(amount)}`);
            debtor.amount -= amount;
            creditor.amount -= amount;
            if (debtor.amount <= 0.5) debtorIndex += 1;
            if (creditor.amount <= 0.5) creditorIndex += 1;
        }
        return transfers;
    }

    function expenseLabel(expense) {
        const members = expenseMembers();
        const payerId = resolveExpensePayerId(expense.payer, members);
        return `${expense.category} · ${expenseMemberName(payerId, members)}が支払い`;
    }

    function notifyExpenseAction(detail) {
        window.dispatchEvent(new CustomEvent('shiori-expense-action', { detail }));
    }

    function renderExpenses() {
        const expenses = safeLoad(EXPENSE_KEY, []);
        const list = document.getElementById('expense-list');
        if (!list) return;
        list.replaceChildren();

        const members = expenseMembers();
        const paidBy = new Map(members.map(member => [member.id, 0]));
        expenses.forEach(expense => {
            const payerId = resolveExpensePayerId(expense.payer, members);
            if (!paidBy.has(payerId)) {
                const unknownMember = { id: payerId, name: expenseMemberName(payerId, members) };
                members.push(unknownMember);
                paidBy.set(payerId, 0);
            }
            paidBy.set(payerId, Number(paidBy.get(payerId) || 0) + Number(expense.amount || 0));

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
            const canRemove = canRemoveExpense(expense);
            remove.disabled = !canRemove;
            if (!canRemove) {
                remove.title = '\u3053\u306e\u652f\u51fa\u306f\u767b\u9332\u8005\u307e\u305f\u306f\u7ba1\u7406\u8005\u3060\u3051\u304c\u524a\u9664\u3067\u304d\u307e\u3059';
                remove.setAttribute('aria-label', `${title.textContent}\u306f\u767b\u9332\u8005\u307e\u305f\u306f\u7ba1\u7406\u8005\u3060\u3051\u304c\u524a\u9664\u3067\u304d\u307e\u3059`);
            }
            remove.addEventListener('click', () => removeExpense(expense.id));
            textBox.append(title, detail);
            row.append(textBox, amount, remove);
            list.appendChild(row);
        });

        const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
        const share = members.length ? total / members.length : 0;
        document.getElementById('expense-total').textContent = formatYen(total);
        document.getElementById('expense-share').textContent = formatYen(share);
        const settlement = document.getElementById('expense-settlement');
        if (!total) {
            settlement.textContent = 'まだ支出はありません';
        } else {
            const transfers = buildExpenseSettlements(members, paidBy, total);
            settlement.textContent = transfers.length ? transfers.join(' ／ ') : '精算済み';
        }
    }
    window.getMemberName = function(id) {
        const members = expenseMembers();
        const resolvedId = resolveExpensePayerId(id, members);
        return expenseMemberName(resolvedId, members);
    };
    window.recalculateExpenses = renderExpenses;

    function removeExpense(id) {
        const current = safeLoad(EXPENSE_KEY, []);
        const target = current.find(expense => expense.id === id);
        if (!target) return;
        if (!canRemoveExpense(target)) {
            window.alert('\u3053\u306e\u652f\u51fa\u306f\u767b\u9332\u8005\u307e\u305f\u306f\u7ba1\u7406\u8005\u3060\u3051\u304c\u524a\u9664\u3067\u304d\u307e\u3059\u3002');
            return;
        }
        const label = target.note || target.category || 'この支出';
        if (!window.confirm(`${label}（${formatYen(target.amount)}）を共有台帳から削除しますか？`)) return;
        const expenses = current.filter(expense => expense.id !== id);
        safeSave(EXPENSE_KEY, expenses);
        renderExpenses();
        notifyExpenseAction({ type: 'remove', id });
    }

    function setupExpenses() {
        const form = document.getElementById('expense-form');
        const deviceOwner = document.getElementById('device-owner');
        const payer = document.getElementById('expense-payer');
        const savedOwner = safeLoad(deviceOwnerStorageKey(), '');
        const optionIds = deviceOwner ? [...deviceOwner.options].map(option => option.value) : [];
        const fallbackOwner = optionIds[0] || expenseMembers()[0]?.id || 'local';
        if (deviceOwner) {
            const myName = localStorage.getItem('user_nickname');
            const ownOption = [...deviceOwner.options].find(option => option.textContent === myName);
            deviceOwner.value = optionIds.includes(savedOwner) ? savedOwner : (ownOption?.value || fallbackOwner);
        }
        if (payer) payer.value = deviceOwner?.value || fallbackOwner;
        if (deviceOwner && deviceOwner.dataset.expenseBound !== 'true') {
            deviceOwner.dataset.expenseBound = 'true';
            deviceOwner.addEventListener('change', () => {
                safeSave(deviceOwnerStorageKey(), deviceOwner.value);
                if (payer) payer.value = deviceOwner.value;
            });
        }
        if (form && form.dataset.expenseBound !== 'true') {
            form.dataset.expenseBound = 'true';
            form.addEventListener('submit', event => {
                event.preventDefault();
                const amount = Number(document.getElementById('expense-amount').value);
                if (!Number.isFinite(amount) || amount <= 0) return;
                const expenses = safeLoad(EXPENSE_KEY, []);
                const access = currentLedgerAccess();
                const expense = {
                    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    amount: Math.round(amount),
                    payer: document.getElementById('expense-payer').value,
                    category: document.getElementById('expense-category').value,
                    note: document.getElementById('expense-note').value.trim().slice(0, 120),
                    createdAt: new Date().toISOString(),
                    creatorUid: access.uid,
                    pendingSync: Boolean(window.currentTripLedgerToken)
                };
                expenses.unshift(expense);
                safeSave(EXPENSE_KEY, expenses);
                form.reset();
                if (payer) payer.value = deviceOwner?.value || safeLoad(deviceOwnerStorageKey(), '');
                renderExpenses();
                notifyExpenseAction({ type: 'upsert', expense });
            });
        }
        if (!remoteExpensesBound) {
            remoteExpensesBound = true;
            window.addEventListener('shiori-expenses-remote', event => {
                const expenses = Array.isArray(event.detail) ? event.detail : [];
                safeSave(EXPENSE_KEY, expenses);
                renderExpenses();
            });
            window.addEventListener('shiori-ledger-access', renderExpenses);
        }
        renderExpenses();
    }

    function expenseCategoryForBadge(badge, title = '') {
        if (badge === 'POKÉMON' && /フェリー/.test(title)) return '交通';
        if (['GOURMET', 'DINNER', 'FOOD LIST'].includes(badge)) return '食事';
        if (['FLIGHT', 'RENTAL CAR', 'FERRY'].includes(badge)) return '交通';
        if (['AQUARIUM', 'VIEWPOINT', 'MUSEUM', 'SPA', 'PARK', 'STATION'].includes(badge)) return '観光';
        if (['SHOPPING', 'POKÉMON'].includes(badge)) return '買い物';
        if (badge === 'HOTEL') return '宿泊';
        return 'その他';
    }

    window.openExpenseShortcut = function (category, note) {
        const expensesButton = document.getElementById('btn-expenses');
        if (typeof window.switchTab === 'function') window.switchTab('tab-expenses', expensesButton);
        const categoryField = document.getElementById('expense-category');
        const noteField = document.getElementById('expense-note');
        const payerField = document.getElementById('expense-payer');
        const deviceOwner = document.getElementById('device-owner');
        const amountField = document.getElementById('expense-amount');
        if (payerField) payerField.value = deviceOwner?.value || safeLoad(deviceOwnerStorageKey(), '');
        if (categoryField) categoryField.value = category;
        if (noteField) noteField.value = note.slice(0, 120);
        const form = document.getElementById('expense-form');
        form?.classList.add('expense-prefilled');
        window.setTimeout(() => form?.classList.remove('expense-prefilled'), 1800);
        form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => amountField?.focus(), 350);
    };

    function setupExpenseShortcuts() {
        // Only cards explicitly marked expenseShortcut=true receive an ADD COST button.
        document.querySelectorAll('.j-tab-panel[id^="tab-day"] .j-card').forEach(card => {
            const badge = card.querySelector('.j-tag-badge')?.textContent.trim().toUpperCase() || '';
            const titleClone = card.querySelector('.j-card-ttl')?.cloneNode(true);
            titleClone?.querySelector('.j-tag-badge')?.remove();
            const rawTitle = titleClone?.textContent.replace(/\s+/g, ' ').trim() || '旅費';
            const isLikelyShared = card.dataset.expenseShortcut === 'true';
            if (!isLikelyShared || card.querySelector('.expense-shortcut')) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'j-btn expense-shortcut';
            button.textContent = 'ADD COST';
            button.setAttribute('aria-label', `${rawTitle}の支出を追加`);
            button.addEventListener('click', () => {
                window.openExpenseShortcut(expenseCategoryForBadge(badge, rawTitle), rawTitle);
            });
            let row = card.querySelector('.j-btn-row');
            if (!row) {
                row = document.createElement('div');
                row.className = 'j-btn-row';
                card.appendChild(row);
            }
            row.appendChild(button);
        });
    }

    function setupOfflineSupport() {
        const bar = document.getElementById('offline-status');
        if (bar) {
            const updateNetworkStatus = () => {
                if (navigator.onLine) {
                    bar.textContent = 'ONLINE';
                    bar.classList.remove('offline');
                } else {
                    bar.textContent = 'OFFLINE MODE';
                    bar.classList.add('offline');
                }
            };
            updateNetworkStatus();
            if (bar.dataset.offlineBound !== 'true') {
                bar.dataset.offlineBound = 'true';
                window.addEventListener('online', updateNetworkStatus);
                window.addEventListener('offline', updateNetworkStatus);
            }
        }

    }

    function openLinkedTab() {
        const panelId = window.location.hash.slice(1);
        if (!/^tab-(day\d+|checklist|expenses)$/.test(panelId)) return;
        const button = document.querySelector(`[aria-controls="${panelId}"]`);
        if (typeof window.switchTab === 'function') window.switchTab(panelId, button);
    }

    function initTripDays() {
        // Construct TRIP_DAYS dynamically from panels present
        TRIP_DAYS = {};
        document.querySelectorAll('.j-tab-btn[aria-controls^="tab-day"]').forEach((lnk, idx) => {
            const panelId = lnk.getAttribute('aria-controls');
            const dayKey = panelId.replace('tab-', '');
            const dateStr = new Date(new Date(window.currentTripDate || getTokyoDateKey(new Date())).getTime() + idx * 86400000).toISOString().split('T')[0];
            TRIP_DAYS[panelId] = {
                key: dayKey,
                label: lnk.textContent,
                date: dateStr
            };
        });
    }

    function initEnhancements() {
        if (!window.currentTripId || window.currentTripId === 'undefined') {
            return;
        }
        const firstDayPanel = document.querySelector('.j-tab-panel[id^="tab-day"]');
        if (!firstDayPanel) return;
        if (lastEnhancedTripId === window.currentTripId && lastEnhancedPanel === firstDayPanel) return;
        lastEnhancedTripId = window.currentTripId;
        lastEnhancedPanel = firstDayPanel;
        const currentRunId = ++enhancementRunId;

        CHECKLIST_KEY = `checklist-${window.currentTripId}-v1`;
        EXPENSE_KEY = expenseStorageKey(window.currentTripId, window.currentTripLedgerToken);

        if (!window.currentTripDate) {
            window.currentTripDate = new Date().toISOString().slice(0, 10);
        }

        // Use the exact configuration already rendered by the participant app.
        const tripData = window.currentTripData || {};
        if (currentRunId !== enhancementRunId) return;
        window.currentTripMembers = Array.isArray(tripData.members) && tripData.members.length
            ? tripData.members
            : [{ id: 'local', name: String(localStorage.getItem('user_nickname') || '\u3053\u306e\u7aef\u672b').slice(0, 40) }];
        initTripDays();
        setupChecklist();
        setupExpenses();
        setupExpenseShortcuts();
        setupOfflineSupport();
        openLinkedTab();
        if (window.nowModeInterval) window.clearInterval(window.nowModeInterval);
        renderNowMode();
        window.nowModeInterval = window.setInterval(renderNowMode, 1000);
    }

    window.initEnhancements = initEnhancements;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (window.currentTripId && window.currentTripId !== 'undefined') {
                initEnhancements();
            }
        }, { once: true });
    } else {
        if (window.currentTripId && window.currentTripId !== 'undefined') {
            initEnhancements();
        }
    }
})();
