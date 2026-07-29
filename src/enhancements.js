(function () {
    'use strict';

    let TRIP_DAYS = {};
    const tripId = window.currentTripId || 'default';
    const CHECKLIST_KEY = `checklist-${tripId}-v1`;
    const EXPENSE_KEY = `expenses-${tripId}-v1`;
    const DEVICE_OWNER_KEY = 'shikoku-drive-device-owner-v1';
    let activeProgressMinutes = 0;
    // Dynamically populated from JSON config, default to empty to prevent hardcoding errors
    let OPTIONAL_RULES = {};
    let DETOUR_SUGGESTIONS = {};

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
        const departureEl = document.getElementById('now-departure');
        if (!dayEl || !titleEl || !timeEl || !countdownEl || !routeEl || !departureEl) return;

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
            departureEl.disabled = true;
            departureEl.textContent = '旅行日に有効';
        } else if (now > tripEnd) {
            dayEl.textContent = 'TRIP COMPLETE';
            titleEl.textContent = '四国ドライブ、おつかれさまでした！';
            timeEl.textContent = 'MEMORIES SAVED';
            countdownEl.textContent = '';
            routeEl.hidden = true;
            departureEl.disabled = true;
            departureEl.textContent = 'TRIP COMPLETE';
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
            departureEl.dataset.targetMinute = String(current ? entry.endMinute : entry.startMinute);
            departureEl.dataset.panelId = panelId;
            departureEl.dataset.targetTitle = entry.title;
            departureEl.disabled = false;
            departureEl.textContent = 'DEPARTURE NOW';
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

    function tokyoMinuteOfDay(date) {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Tokyo',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(date);
        const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
        const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
        return hour * 60 + minute;
    }

    window.recordDepartureNow = function () {
        const button = document.getElementById('now-departure');
        if (!button || button.disabled) return;
        const targetMinute = Number(button.dataset.targetMinute);
        const panelId = button.dataset.panelId;
        if (!Number.isFinite(targetMinute) || !TRIP_DAYS[panelId]) return;

        const difference = tokyoMinuteOfDay(new Date()) - targetMinute;
        const direction = document.getElementById('progress-direction');
        const minutes = document.getElementById('progress-minutes');
        if (direction) direction.value = difference < 0 ? '-1' : '1';
        if (minutes) minutes.value = String(Math.abs(difference));
        const tabButton = document.querySelector(`[aria-controls="${panelId}"]`);
        if (typeof window.switchTab === 'function') window.switchTab(panelId, tabButton);
        window.applyProgressAdvisor(difference);
        window.toggleScheduleAdvisor(true);

        const advice = document.getElementById('progress-advice');
        const message = advice?.querySelector('span');
        if (message) {
            const timing = difference < 0
                ? `予定より${Math.abs(difference)}分早く`
                : difference > 0
                    ? `予定より${difference}分遅く`
                    : '予定どおりに';
            message.textContent = `${button.dataset.targetTitle || '現在地'}を${timing}出発。以降の予定を再調整しました。`;
        }
        button.textContent = 'RECORDED ✓';
        window.setTimeout(() => { button.textContent = 'DEPARTURE NOW'; }, 1800);
        advice?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    window.toggleScheduleAdvisor = function (forceOpen) {
        const content = document.getElementById('advisor-content');
        const toggle = document.getElementById('advisor-toggle');
        if (!content || !toggle) return;
        const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : content.hidden;
        content.hidden = !shouldOpen;
        toggle.setAttribute('aria-expanded', String(shouldOpen));
        toggle.textContent = shouldOpen ? 'CLOSE −' : 'OPEN ＋';
    };

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

    function removeProgressBadges() {
        document.querySelectorAll('.delay-preview').forEach(element => element.remove());
        document.querySelectorAll('.optional-decision').forEach(element => element.remove());
        document.querySelectorAll('.optional-go, .optional-no').forEach(card => {
            card.classList.remove('optional-go', 'optional-no');
        });
    }

    function optionalRuleFor(panelId, title) {
        return (OPTIONAL_RULES[panelId] || []).find(rule => rule.match.test(title));
    }

    function renderOptionalAdvice(panelId, signedMinutes) {
        const panel = document.getElementById(panelId);
        const advice = document.getElementById('optional-advice');
        if (!panel || !advice) return { canAdd: 0, cannotAdd: 0 };

        const earlyMinutes = Math.max(0, -signedMinutes);
        const lateMinutes = Math.max(0, signedMinutes);
        const decisions = [];

        panel.querySelectorAll('.j-card').forEach(card => {
            const timeText = card.querySelector('.j-card-time')?.childNodes[0]?.textContent.trim();
            if (timeText !== 'OPTIONAL') return;
            const title = card.querySelector('.j-card-ttl')?.textContent.replace(/\s+/g, ' ').trim() || 'Optional';
            const rule = optionalRuleFor(panelId, title);
            if (!rule) return;

            const available = Math.max(0, rule.baseline + earlyMinutes - lateMinutes);
            const canAdd = available >= rule.required;
            const badge = document.createElement('span');
            badge.className = `optional-decision ${canAdd ? 'go' : 'no'}`;
            badge.textContent = canAdd
                ? `GO · ${available}分確保`
                : `NO · あと${Math.max(1, rule.required - available)}分必要`;
            card.querySelector('.j-card-time')?.appendChild(badge);
            card.classList.add(canAdd ? 'optional-go' : 'optional-no');
            decisions.push({ title, canAdd, available, required: rule.required });
        });

        const usableLead = earlyMinutes;
        const detours = (DETOUR_SUGGESTIONS[panelId] || [])
            .filter(item => item.minutes <= usableLead)
            .sort((a, b) => b.minutes - a.minutes);
        const bestDetour = detours[0];
        const canAdd = decisions.filter(item => item.canAdd);
        const cannotAdd = decisions.filter(item => !item.canAdd);

        advice.replaceChildren();
        decisions.forEach(item => {
            const row = document.createElement('div');
            row.className = `optional-advice-row ${item.canAdd ? 'go' : 'no'}`;
            row.innerHTML = `<strong>${item.canAdd ? '入れてOK' : '今回は入れない'}</strong><span>${item.title}</span>`;
            advice.appendChild(row);
        });
        const detour = document.createElement('div');
        detour.className = 'detour-advice';
        if (lateMinutes > 0) {
            detour.innerHTML = '<strong>寄り道判断</strong><span>いまは寄り道を見送り、次の固定予定を優先。</span>';
        } else if (bestDetour) {
            detour.innerHTML = `<strong>寄り道候補</strong><span>${bestDetour.text}</span>`;
        } else {
            detour.innerHTML = '<strong>寄り道判断</strong><span>10分以上早着したら、動線上の短い寄り道を提案します。</span>';
        }
        advice.appendChild(detour);
        return { canAdd: canAdd.length, cannotAdd: cannotAdd.length };
    }

    window.applyProgressAdvisor = function (signedMinutes) {
        activeProgressMinutes = Math.max(-180, Math.min(180, Number(signedMinutes) || 0));
        removeProgressBadges();
        const panelId = selectedDayPanel();
        const entries = getEntries(panelId);
        const advice = document.getElementById('progress-advice');
        const dayLabel = TRIP_DAYS[panelId]?.label || 'DAY';
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
                const previousFixed = entries.slice(0, index).reverse().find(candidate => candidate.fixed);
                let shiftedStart = entry.startMinute + activeProgressMinutes;
                let shiftedEnd = entry.endMinute + activeProgressMinutes;
                let conflict = 0;
                if (nextFixed && shiftedEnd > nextFixed.startMinute) {
                    conflict = shiftedEnd - nextFixed.startMinute;
                    shiftedEnd = Math.max(shiftedStart, nextFixed.startMinute);
                }
                if (previousFixed && shiftedStart < previousFixed.endMinute) {
                    const clipped = previousFixed.endMinute - shiftedStart;
                    shiftedStart = previousFixed.endMinute;
                    shiftedEnd = Math.max(shiftedStart, shiftedEnd + clipped);
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

        const optional = renderOptionalAdvice(panelId, activeProgressMinutes);
        if (advice) {
            const title = advice.querySelector('strong');
            const message = advice.querySelector('span');
            if (!activeProgressMinutes) {
                title.textContent = 'ON SCHEDULE';
                message.textContent = `${dayLabel}は予定どおり。Optionalは下の判定を確認してください。`;
            } else if (activeProgressMinutes < 0) {
                title.textContent = `${Math.abs(activeProgressMinutes)} MIN EARLY`;
                message.textContent = `${dayLabel}の今後を前倒し。Optionalは${optional.canAdd}件が追加可能です。`;
            } else {
                title.textContent = `${activeProgressMinutes} MIN LATE`;
                message.textContent = shortened
                    ? `固定時刻を守るため${shortened}件を計${squeezedMinutes}分短縮。Optionalは入れません。`
                    : '固定時刻は維持。寄り道とOptionalを見送って追いつきます。';
            }
        }
    };

    window.resetProgressAdvisor = function () {
        const direction = document.getElementById('progress-direction');
        const minutes = document.getElementById('progress-minutes');
        if (direction) direction.value = '-1';
        if (minutes) minutes.value = '0';
        window.applyProgressAdvisor(0);
    };

    function setupProgressAdvisor() {
        const form = document.getElementById('progress-form');
        form?.addEventListener('submit', event => {
            event.preventDefault();
            const direction = Number(document.getElementById('progress-direction')?.value) || -1;
            const minutes = Math.max(0, Number(document.getElementById('progress-minutes')?.value) || 0);
            window.applyProgressAdvisor(direction * minutes);
        });
        document.querySelectorAll('.j-tab-btn').forEach(button => {
            button.addEventListener('click', () => {
                window.setTimeout(() => {
                    window.applyProgressAdvisor(activeProgressMinutes);
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
        const members = window.currentTripMembers || [
            { id: 'aoi', name: 'あおい' },
            { id: 'kotaro', name: 'こうたろう' }
        ];
        const payerObj = members.find(m => m.id === expense.payer);
        const payerName = payerObj ? payerObj.name : expense.payer;
        return `${expense.category} · ${payerName}が支払い`;
    }

    function notifyExpenseAction(detail) {
        window.dispatchEvent(new CustomEvent('shikoku-expense-action', { detail }));
    }

    function renderExpenses() {
        const expenses = safeLoad(EXPENSE_KEY, []);
        const list = document.getElementById('expense-list-container');
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
            const comment = document.createElement('small');
            const amount = document.createElement('strong');
            const remove = document.createElement('button');
            title.textContent = expense.note || expense.category;
            detail.textContent = expenseLabel(expense);
            comment.className = 'expense-comment';
            comment.textContent = expense.comment || '';
            comment.hidden = !expense.comment;
            amount.textContent = formatYen(expense.amount);
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `${title.textContent}を削除`);
            remove.addEventListener('click', () => removeExpense(expense.id));
            textBox.append(title, detail, comment);
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
        const deviceOwner = document.getElementById('device-owner');
        const payer = document.getElementById('expense-payer');
        const savedOwner = safeLoad(DEVICE_OWNER_KEY, 'kotaro');
        if (deviceOwner) deviceOwner.value = savedOwner === 'aoi' ? 'aoi' : 'kotaro';
        if (payer) payer.value = deviceOwner?.value || 'kotaro';
        deviceOwner?.addEventListener('change', () => {
            safeSave(DEVICE_OWNER_KEY, deviceOwner.value);
            if (payer) payer.value = deviceOwner.value;
        });
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
                comment: document.getElementById('expense-comment').value.trim(),
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

    function expenseCategoryForBadge(badge, title = '') {
        if (badge === 'POKÉMON' && /フェリー/.test(title)) return '交通';
        if (['GOURMET', 'DINNER', 'FOOD LIST'].includes(badge)) return '食事';
        if (['FLIGHT', 'RENTAL CAR', 'FERRY', 'BUS', 'HELLO CYCLING', 'DRIVE', 'BREAK'].includes(badge)) return '交通';
        if (['AQUARIUM', 'VIEWPOINT', 'MUSEUM', 'SPA', 'PARK', 'STATION'].includes(badge)) return '観光';
        if (['SHOPPING', 'POKÉMON'].includes(badge)) return '買い物';
        if (badge === 'HOTEL') return '宿泊';
        return 'その他';
    }

    window.openExpenseShortcut = function (category, note) {
        const paypayButton = document.getElementById('btn-paypay');
        if (typeof window.switchTab === 'function') window.switchTab('tab-paypay', paypayButton);
        const categoryField = document.getElementById('expense-category');
        const noteField = document.getElementById('expense-note');
        const payerField = document.getElementById('expense-payer');
        const deviceOwner = document.getElementById('device-owner');
        const amountField = document.getElementById('expense-amount');
        if (payerField) payerField.value = deviceOwner?.value || safeLoad(DEVICE_OWNER_KEY, 'kotaro');
        if (categoryField) categoryField.value = category;
        if (noteField) noteField.value = note.slice(0, 40);
        const form = document.getElementById('expense-form');
        form?.classList.add('expense-prefilled');
        window.setTimeout(() => form?.classList.remove('expense-prefilled'), 1800);
        form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => amountField?.focus(), 350);
    };

    function setupExpenseShortcuts() {
        const shareableBadges = new Set([
            'GOURMET', 'DINNER', 'FOOD LIST', 'FERRY',
            'AQUARIUM', 'MUSEUM', 'SPA'
        ]);
        document.querySelectorAll('#tab-day1 .j-card, #tab-day2 .j-card, #tab-day3 .j-card').forEach(card => {
            const badge = card.querySelector('.j-tag-badge')?.textContent.trim().toUpperCase() || '';
            const titleClone = card.querySelector('.j-card-ttl')?.cloneNode(true);
            titleClone?.querySelector('.j-tag-badge')?.remove();
            const rawTitle = titleClone?.textContent.replace(/\s+/g, ' ').trim() || '旅費';
            const isLikelyShared = shareableBadges.has(badge) ||
                (badge === 'POKÉMON' && /フェリー/.test(rawTitle));
            if (!isLikelyShared || card.querySelector('.expense-shortcut')) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'j-btn expense-shortcut';
            button.textContent = 'PAID';
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
            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (!refreshing) {
                    refreshing = true;
                    console.log("Service Worker updated! Force reloading...");
                    window.location.reload();
                }
            });

            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js').then(reg => {
                    reg.addEventListener('updatefound', () => {
                        const newWorker = reg.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                newWorker.postMessage({ action: 'skipWaiting' });
                            }
                        });
                    });
                }).catch(() => {
                    const status = document.getElementById('offline-status');
                    if (status) status.textContent = 'ONLINE';
                });
            });
        }
    }
                    caches.keys().then(names => {
                        for (let name of names) caches.delete(name);
                    });
                    localStorage.setItem('last_sw_reset_v19', 'true');
                    console.log("Ultimate PWA Cache Reset triggered! Reloading...");
                    window.location.reload();
                });
                return;
            }

            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (!refreshing) {
                    refreshing = true;
                    console.log("Service Worker updated! Force reloading to apply latest PAID button...");
                    window.location.reload();
                }
            });

            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js').then(reg => {
                    reg.addEventListener('updatefound', () => {
                        const newWorker = reg.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                newWorker.postMessage({ action: 'skipWaiting' });
                            }
                        });
                    });
                }).catch(() => {
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

    function initTripDays() {
        // Construct TRIP_DAYS dynamically from panels present
        TRIP_DAYS = {};
        document.querySelectorAll('.j-tab-lnk[aria-controls^="tab-day"]').forEach((lnk, idx) => {
            const panelId = lnk.getAttribute('aria-controls');
            const dayKey = panelId.replace('tab-', '');
            // Compute trip date based on index relative to start date
            const dateStr = new Date(new Date(window.currentTripDate || '2026-08-30').getTime() + idx * 86400000).toISOString().split('T')[0];
            TRIP_DAYS[panelId] = {
                key: dayKey,
                label: lnk.textContent,
                date: dateStr
            };
        });
    }

    function initEnhancements() {
        const datesVal = document.querySelector('.j-info-val')?.textContent || '';
        if (datesVal) {
            window.currentTripDate = datesVal.split(' ')[0].replace(/\//g, '-');
        }
        
        // Dynamically fetch and preserve trip members list at runtime
        fetch(`data/${window.currentTripId}.json`)
            .then(res => res.json())
            .then(tripData => {
                window.currentTripMembers = tripData.members || [
                    { id: 'aoi', name: 'あおい' },
                    { id: 'kotaro', name: 'こうたろう' }
                ];
                
                // Parse optional rules from JSON if present, converting match strings into RegExps
                OPTIONAL_RULES = {};
                if (tripData.optionalRules) {
                    Object.keys(tripData.optionalRules).forEach(dayKey => {
                        OPTIONAL_RULES[dayKey] = tripData.optionalRules[dayKey].map(rule => ({
                            match: new RegExp(rule.match),
                            required: Number(rule.required),
                            baseline: Number(rule.baseline)
                        }));
                    });
                }
                
                // Parse detour suggestions from JSON if present
                DETOUR_SUGGESTIONS = tripData.detourSuggestions || {};

                // Parse map center options
                window.tripMapCenter = tripData.mapCenter || null;
                window.tripMapZoom = tripData.mapZoom || 9;

                initTripDays();
                setupChecklist();
                setupExpenses();
                setupExpenseShortcuts();
                setupOfflineSupport();
                setupProgressAdvisor();
                openLinkedTab();
                window.applyProgressAdvisor(0);
                renderNowMode();
                window.setInterval(renderNowMode, 1000);
            }).catch(() => {
                window.currentTripMembers = [
                    { id: 'aoi', name: 'あおい' },
                    { id: 'kotaro', name: 'こうたろう' }
                ];
                initTripDays();
                setupChecklist();
                setupExpenses();
                setupExpenseShortcuts();
                setupOfflineSupport();
                setupProgressAdvisor();
                openLinkedTab();
                window.applyProgressAdvisor(0);
                renderNowMode();
                window.setInterval(renderNowMode, 1000);
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEnhancements, { once: true });
    } else {
        initEnhancements();
    }
})();
