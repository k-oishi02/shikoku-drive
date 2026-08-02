(function () {
    'use strict';

    let TRIP_DAYS = {};
    let CHECKLIST_KEY = 'checklist-default-v1';
    let EXPENSE_KEY = 'expenses-default-v1';
    const DEVICE_OWNER_KEY = 'shikoku-drive-device-owner-v1';
    let activeProgressMinutes = 0;
    let progressAnchorMinute = null;
    let progressAnchorPanel = '';
    let lastEnhancedPanel = null;
    let lastEnhancedTripId = '';
    let enhancementRunId = 0;
    let remoteExpensesBound = false;
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

    window.setExpenseStorageScope = function (tripId, ledgerToken) {
        EXPENSE_KEY = expenseStorageKey(tripId, ledgerToken);
        renderExpenses();
    };
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
        if (card.dataset.fixed === 'true') return true;
        // Compatibility for already-published trips created before fixed flags existed.
        const badge = card.querySelector('.j-tag-badge')?.textContent.trim().toUpperCase() || '';
        const title = card.querySelector('.j-card-ttl')?.textContent.trim() || '';
        return ['FLIGHT', 'BUS', 'FERRY'].includes(badge) ||
            /フェリー|四国水族館|五志喜|ポケモンセンター|松山空港店|Orange BAR/.test(title);
    }

    function isRigidCard(card) {
        if (card.dataset.rigid === 'true') return true;
        const badge = card.querySelector('.j-tag-badge')?.textContent.trim().toUpperCase() || '';
        return ['FLIGHT', 'BUS', 'FERRY', 'DRIVE', 'HELLO CYCLING', 'RENTAL CAR'].includes(badge);
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
            // Prefer an explicit route link over the card's generic MAP button.
            // The latter is useful for the card itself, but NOW mode must open
            // the actual travel route when one is available.
            const route = Array.from(card.querySelectorAll('a[href]')).find(link =>
                /^ROUTE\s*→?$/i.test(link.textContent.trim())
            ) || card.querySelector('a[href*="google.com/maps/dir"], a[href*="maps.app.goo.gl"], .j-btn.primary, a[href*="google.com/maps"]');
            return {
                index,
                card,
                timeEl,
                title,
                route: route?.href || '',
                fixed: isFixedCard(card),
                rigid: isRigidCard(card),
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
        const departureEl = document.getElementById('now-departure');
        if (!dayEl || !titleEl || !timeEl || !countdownEl || !routeEl || !departureEl) return;

        const now = new Date();
        const timeline = Object.keys(TRIP_DAYS).flatMap(panelId => getEntries(panelId)).sort((a, b) => a.start - b.start);
        const fallbackDate = window.currentTripDate || getTokyoDateKey(now);
        const tripStart = timeline[0]?.start || new Date(`${Object.values(TRIP_DAYS)[0]?.date || fallbackDate}T00:00:00+09:00`);
        const tripEnd = timeline.at(-1)?.end || new Date(`${Object.values(TRIP_DAYS).at(-1)?.date || fallbackDate}T23:59:59+09:00`);
        let panelId = dayPanelForDate(now);
        let entry = null;
        let departureTarget = null;
        let routeEntry = null;

        if (now < tripStart) {
            panelId = Object.keys(TRIP_DAYS).sort((a, b) => TRIP_DAYS[a].date.localeCompare(TRIP_DAYS[b].date))[0];
            entry = getEntries(panelId)[0];
            dayEl.textContent = `${TRIP_DAYS[panelId]?.label || 'DAY 01'} · 旅行前`;
            countdownEl.textContent = `出発まで ${formatDuration(tripStart - now)}`;
            if (getTokyoDateKey(now) === TRIP_DAYS[panelId]?.date && entry) {
                departureTarget = { panelId, minute: entry.startMinute, title: entry.title };
                routeEntry = entry;
            }
        } else if (now > tripEnd) {
            dayEl.textContent = 'TRIP COMPLETE';
            titleEl.textContent = '旅行、おつかれさまでした！';
            timeEl.textContent = 'MEMORIES SAVED';
            countdownEl.textContent = '';
            routeEl.hidden = true;
            departureEl.disabled = true;
            departureEl.textContent = 'TRIP COMPLETE';
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
            if (current && next) {
                departureTarget = { panelId, minute: current.endMinute, title: next.title };
                routeEntry = next;
            } else if (!current && next) {
                departureTarget = { panelId, minute: next.startMinute, title: next.title };
                routeEntry = next;
            }
        } else {
            const future = Object.keys(TRIP_DAYS)
                .flatMap(id => getEntries(id).map(item => ({ panelId: id, item })))
                .find(candidate => candidate.item.start > now);
            panelId = future?.panelId || Object.keys(TRIP_DAYS).at(-1);
            entry = future?.item || getEntries(panelId).at(-1);
            dayEl.textContent = `${TRIP_DAYS[panelId]?.label || 'DAY'} · NEXT`;
            countdownEl.textContent = entry ? `出発まで ${formatDuration(entry.start - now)}` : '';
            if (entry) {
                departureTarget = { panelId, minute: entry.startMinute, title: entry.title };
                routeEntry = entry;
            }
        }

        if (!entry) {
            routeEl.hidden = true;
            departureEl.disabled = true;
            return;
        }
        titleEl.textContent = entry.title;
        timeEl.textContent = `${minuteLabel(entry.startMinute)} — ${minuteLabel(entry.endMinute)}`;
        if (routeEntry?.route || entry.route) {
            routeEl.href = routeEntry?.route || entry.route;
            routeEl.hidden = false;
        } else {
            routeEl.hidden = true;
        }
        if (departureTarget) {
            departureEl.dataset.targetMinute = String(departureTarget.minute);
            departureEl.dataset.panelId = departureTarget.panelId;
            departureEl.dataset.targetTitle = departureTarget.title;
            departureEl.disabled = false;
            departureEl.textContent = '次の予定へ出発';
        } else {
            departureEl.disabled = true;
            departureEl.textContent = '本日の予定完了';
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
        progressAnchorPanel = panelId;
        progressAnchorMinute = targetMinute;
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
            message.textContent = `次の予定「${button.dataset.targetTitle || '目的地'}」へ${timing}出発。これ以降だけを再調整しました。`;
        }
        button.textContent = 'RECORDED ✓';
        window.setTimeout(renderNowMode, 1800);
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

    function renderOptionalAdvice(panelId, signedMinutes, anchorMinute = -1) {
        const panel = document.getElementById(panelId);
        const advice = document.getElementById('optional-advice');
        if (!panel || !advice) return { canAdd: 0, cannotAdd: 0 };

        const earlyMinutes = Math.max(0, -signedMinutes);
        const lateMinutes = Math.max(0, signedMinutes);
        const decisions = [];

        const allCards = Array.from(panel.querySelectorAll('.j-card'));
        allCards.forEach((card, cardIndex) => {
            const timeText = card.querySelector('.j-card-time')?.childNodes[0]?.textContent.trim();
            if (timeText !== 'OPTIONAL') return;
            const nextTimed = allCards.slice(cardIndex + 1)
                .map(candidate => parseCardTime(candidate.querySelector('.j-card-time')?.textContent))
                .find(Boolean);
            const previousTimed = allCards.slice(0, cardIndex).reverse()
                .map(candidate => parseCardTime(candidate.querySelector('.j-card-time')?.textContent))
                .find(Boolean);
            const referenceMinute = nextTimed?.startMinute ?? previousTimed?.endMinute ?? Number.MAX_SAFE_INTEGER;
            if (referenceMinute <= anchorMinute) return;
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
            row.innerHTML = `<strong>${item.canAdd ? '入れてOK' : '今回は入れない'}</strong><span>${escapeMarkup(item.title)}</span>`;
            advice.appendChild(row);
        });
        const detour = document.createElement('div');
        detour.className = 'detour-advice';
        if (lateMinutes > 0) {
            detour.innerHTML = '<strong>寄り道判断</strong><span>いまは寄り道を見送り、次の固定予定を優先。</span>';
        } else if (bestDetour) {
            detour.innerHTML = `<strong>寄り道候補</strong><span>${escapeMarkup(bestDetour.text)}</span>`;
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
        const isToday = TRIP_DAYS[panelId]?.date === getTokyoDateKey(new Date());
        const anchorMinute = progressAnchorPanel === panelId && Number.isFinite(progressAnchorMinute)
            ? progressAnchorMinute
            : isToday ? tokyoMinuteOfDay(new Date()) : -1;
        let shortened = 0;
        let squeezedMinutes = 0;
        let impossible = 0;
        let previousAdjustedEnd = null;
        let segmentShift = activeProgressMinutes;

        entries.forEach((entry, index) => {
            const badge = document.createElement('span');
            badge.className = 'delay-preview';
            if (entry.endMinute <= anchorMinute) {
                badge.classList.add('completed');
                badge.textContent = 'DONE';
                entry.timeEl.appendChild(badge);
                return;
            }
            if (entry.fixed) {
                badge.classList.add('fixed');
                badge.textContent = `FIXED ${minuteLabel(entry.startMinute)}`;
                previousAdjustedEnd = entry.endMinute;
                segmentShift = 0;
            } else {
                const duration = Math.max(0, entry.endMinute - entry.startMinute);
                const nextFixed = entries.slice(index + 1).find(candidate => candidate.fixed);
                let shiftedStart = entry.startMinute + segmentShift;
                if (Number.isFinite(previousAdjustedEnd)) shiftedStart = Math.max(shiftedStart, previousAdjustedEnd);
                let shiftedEnd = shiftedStart + duration;
                let conflict = 0;

                if (nextFixed && shiftedEnd > nextFixed.startMinute) {
                    conflict = shiftedEnd - nextFixed.startMinute;
                    if (shiftedStart >= nextFixed.startMinute) {
                        shiftedStart = nextFixed.startMinute;
                        shiftedEnd = nextFixed.startMinute;
                    } else {
                        shiftedEnd = nextFixed.startMinute;
                    }
                }

                previousAdjustedEnd = shiftedEnd;
                badge.textContent = `${minuteLabel(shiftedStart)}–${minuteLabel(shiftedEnd)}`;
                if (conflict > 0) {
                    badge.classList.add('conflict');
                    if (entry.rigid) {
                        badge.textContent += ` / 移動時間${conflict}分不足`;
                        impossible += 1;
                    } else {
                        badge.textContent += ` / ${conflict}分短縮`;
                        shortened += 1;
                        squeezedMinutes += conflict;
                    }
                }
            }
            entry.timeEl.appendChild(badge);
        });
        const optional = renderOptionalAdvice(panelId, activeProgressMinutes, anchorMinute);
        if (advice) {
            const title = advice.querySelector('strong');
            const message = advice.querySelector('span');
            if (!activeProgressMinutes) {
                title.textContent = 'ON SCHEDULE';
                message.textContent = `${dayLabel}は予定どおり。Optionalは下の判定を確認してください。`;
            } else if (activeProgressMinutes < 0) {
                title.textContent = `${Math.abs(activeProgressMinutes)} MIN EARLY`;
                message.textContent = `${dayLabel}の現在地以降を前倒し。Optionalは${optional.canAdd}件が追加可能です。`;
            } else {
                title.textContent = `${activeProgressMinutes} MIN LATE`;
                message.textContent = impossible
                    ? `現在地以降では固定予定までの移動時間が不足します。Optionalを外し、Flexible予定の短縮・省略が必要です。`
                    : shortened
                        ? `現在地以降の${shortened}件を計${squeezedMinutes}分短縮し、固定時刻を守ります。`
                        : '現在地以降だけを調整しました。固定予定より後は元の時刻へ戻ります。';
            }
        }
    };

    window.resetProgressAdvisor = function () {
        const direction = document.getElementById('progress-direction');
        const minutes = document.getElementById('progress-minutes');
        if (direction) direction.value = '-1';
        if (minutes) minutes.value = '0';
        progressAnchorMinute = null;
        progressAnchorPanel = '';
        window.applyProgressAdvisor(0);
    };

    function setupProgressAdvisor() {
        const form = document.getElementById('progress-form');
        if (form && form.dataset.progressBound !== 'true') {
            form.dataset.progressBound = 'true';
            form.addEventListener('submit', event => {
                event.preventDefault();
                const direction = Number(document.getElementById('progress-direction')?.value) || -1;
                const minutes = Math.max(0, Number(document.getElementById('progress-minutes')?.value) || 0);
                progressAnchorPanel = selectedDayPanel();
                progressAnchorMinute = TRIP_DAYS[progressAnchorPanel]?.date === getTokyoDateKey(new Date())
                    ? tokyoMinuteOfDay(new Date())
                    : -1;
                window.applyProgressAdvisor(direction * minutes);
            });
        }
        document.querySelectorAll('.j-tab-btn').forEach(button => {
            if (button.dataset.progressBound === 'true') return;
            button.dataset.progressBound = 'true';
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
        const fallback = [{ id: 'aoi', name: 'メンバー1' }, { id: 'kotaro', name: 'メンバー2' }];
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
        const id = String(payer || '');
        if (members.some(member => member.id === id)) return id;
        if (id === 'aoi') return members[0]?.id || id;
        if (id === 'kotaro') return members[1]?.id || members[0]?.id || id;
        return id || members[0]?.id || 'aoi';
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
        window.dispatchEvent(new CustomEvent('shikoku-expense-action', { detail }));
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
        const savedOwner = safeLoad(DEVICE_OWNER_KEY, '');
        const optionIds = deviceOwner ? [...deviceOwner.options].map(option => option.value) : [];
        const fallbackOwner = optionIds[0] || expenseMembers()[0]?.id || 'aoi';
        if (deviceOwner) {
            const myName = localStorage.getItem('user_nickname');
            const ownOption = [...deviceOwner.options].find(option => option.textContent === myName);
            deviceOwner.value = optionIds.includes(savedOwner) ? savedOwner : (ownOption?.value || fallbackOwner);
        }
        if (payer) payer.value = deviceOwner?.value || fallbackOwner;
        if (deviceOwner && deviceOwner.dataset.expenseBound !== 'true') {
            deviceOwner.dataset.expenseBound = 'true';
            deviceOwner.addEventListener('change', () => {
                safeSave(DEVICE_OWNER_KEY, deviceOwner.value);
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
                if (payer) payer.value = deviceOwner?.value || safeLoad(DEVICE_OWNER_KEY, '');
                renderExpenses();
                notifyExpenseAction({ type: 'upsert', expense });
            });
        }
        if (!remoteExpensesBound) {
            remoteExpensesBound = true;
            window.addEventListener('shikoku-expenses-remote', event => {
                const expenses = Array.isArray(event.detail) ? event.detail : [];
                safeSave(EXPENSE_KEY, expenses);
                renderExpenses();
            });
        }
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
        if (payerField) payerField.value = deviceOwner?.value || safeLoad(DEVICE_OWNER_KEY, '');
        if (categoryField) categoryField.value = category;
        if (noteField) noteField.value = note.slice(0, 40);
        const form = document.getElementById('expense-form');
        form?.classList.add('expense-prefilled');
        window.setTimeout(() => form?.classList.remove('expense-prefilled'), 1800);
        form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => amountField?.focus(), 350);
    };

    function setupExpenseShortcuts() {
        // Only cards explicitly marked expenseShortcut=true receive a PAID button.
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
        if (!window.confirm('参加者全員の共有台帳から支出をすべて削除しますか？')) return;
        safeSave(EXPENSE_KEY, []);
        renderExpenses();
        notifyExpenseAction({ type: 'clear' });
    };

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
        if (!/^tab-(day\d+|checklist|paypay)$/.test(panelId)) return;
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

        // Use the exact config already rendered by the participant app. Re-fetching
        // the bundled JSON here would make NOW/Optional disagree with published data.
        const tripData = window.currentTripData || {};
        if (currentRunId !== enhancementRunId) return;
        window.currentTripMembers = Array.isArray(tripData.members) && tripData.members.length
            ? tripData.members
            : [{ id: 'aoi', name: 'メンバー1' }, { id: 'kotaro', name: 'メンバー2' }];
        OPTIONAL_RULES = {};
        if (tripData.optionalRules && typeof tripData.optionalRules === 'object') {
            Object.keys(tripData.optionalRules).forEach(dayKey => {
                OPTIONAL_RULES[dayKey] = (tripData.optionalRules[dayKey] || []).flatMap(rule => {
                    try {
                        return [{
                            match: new RegExp(rule.match),
                            required: Number(rule.required),
                            baseline: Number(rule.baseline)
                        }];
                    } catch (error) {
                        return [];
                    }
                });
            });
        }
        DETOUR_SUGGESTIONS = tripData.detourSuggestions || {};
        window.tripMapCenter = tripData.mapCenter || null;
        window.tripMapZoom = tripData.mapZoom || 9;
        initTripDays();
        setupChecklist();
        setupExpenses();
        setupExpenseShortcuts();
        setupOfflineSupport();
        setupProgressAdvisor();
        openLinkedTab();
        progressAnchorMinute = null;
        progressAnchorPanel = '';
        window.applyProgressAdvisor(0);
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
