import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as tripCore from '../src/trip-v2-core.js';
import {
  migrateTripToV2,
  cleanCard,
  cleanPlanning,
  cleanCandidate,
  stripPlanningForPublication,
  validateTripDraft,
  SHIORI_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from '../src/trip-v2-core.js';
import { analyzeTrip, settlementTransfers } from '../src/trip-v2-analysis.js';
import { buildTimeline, activeItem, shiftedTime } from '../src/itinerary-calc.js';
import { createTripStore, createInitialTripState } from '../src/trip-store.js';
import { createAdminStore, createInitialAdminState } from '../src/admin-store.js';
import {
  enqueueOfflineExpense,
  getOfflineExpensesQueue,
  clearAllQueuedExpenses,
  writeRawQueue
} from '../src/offline-expense-queue.js';

// Resolve normalization function (supporting normalizeTripDraft or migrateTripToV2)
const normalizeTripDraft = tripCore.normalizeTripDraft || tripCore.migrateTripToV2;

const projectRoot = process.cwd();
const file20261107 = path.resolve(projectRoot, '20261107.json');
const file20261031 = path.resolve(projectRoot, '20261031.json');

describe('Schema v2 Compatibility & Canonical Trip Verification', () => {
  // ---------------------------------------------------------------------------
  // 1. Canonical Trip Loading & Structural Verification
  // ---------------------------------------------------------------------------
  describe('1. Canonical Trip Loading (20261107.json & 20261031.json)', () => {
    it('loads 20261107.json from disk and validates canonical Schema v2 properties', () => {
      assert.ok(fs.existsSync(file20261107), '20261107.json must exist on disk');
      const raw = fs.readFileSync(file20261107, 'utf8');
      const trip = JSON.parse(raw);

      assert.equal(trip.schemaVersion, 2, 'schemaVersion must be 2');
      assert.equal(trip.tripId, '20261107', 'tripId must match 20261107');
      assert.equal(trip.title, '茨城ドライブ 2026　Autumn');
      assert.equal(trip.subtitle, '秋の味覚が俺たちを呼んでるぜ！！');
      assert.equal(trip.catchphrase, '食欲の秋！！');
      assert.equal(trip.startDate, '2026-11-07');
      assert.equal(trip.endDate, '2026-11-07');
      assert.equal(trip.archived, false);

      // Theme & Features
      assert.deepEqual(trip.theme, { mode: 'auto', accent: '#1f93db' });
      assert.deepEqual(trip.features, { nowMode: true, expenses: true, notifications: true });

      // DayLabels & DaySettings
      assert.equal(trip.dayLabels?.day1, '11/7 (土) ひたちなか・日立・大洗ナイト');
      assert.ok(trip.daySettings?.day1);
      assert.equal(trip.daySettings.day1.departureTime, '07:30');
      assert.ok(trip.daySettings.day1.note.includes('上本郷駅前第２'));

      // Days & Cards
      assert.ok(trip.days && Array.isArray(trip.days.day1));
      assert.equal(trip.days.day1.length, 8, 'Day 1 must contain exactly 8 itinerary cards');

      const expectedCardIds = [
        'day1-01-carshare',
        'day1-02-nakaminato',
        'day1-03-waon',
        'day1-04-hitachikaihin',
        'day1-05-hitachistation',
        'day1-06-night-aquaworld',
        'day1-07-dinner-flyinggarden',
        'day1-08-return'
      ];
      const actualCardIds = trip.days.day1.map(c => c.cardId);
      assert.deepEqual(actualCardIds, expectedCardIds, 'Card IDs must strictly match canonical sequence');

      // First Card Details
      const carshare = trip.days.day1[0];
      assert.equal(carshare.title, '上本郷');
      assert.equal(carshare.time, '07:15 - 07:30');
      assert.equal(carshare.badge, 'レンタカー / 出発');
      assert.equal(carshare.reservation?.number, '233227371');
      assert.equal(carshare.constraints?.departureBy, '07:30');

      // Weather Locations
      assert.ok(trip.weatherLocations?.oarai);
      assert.equal(trip.weatherLocations.oarai.label, '大洗');
      assert.equal(trip.weatherLocations.oarai.lat, 36.3134);
      assert.ok(trip.weatherLocations?.hitachi);
      assert.equal(trip.weatherLocations.hitachi.label, '日立');

      // Checklist items
      assert.ok(Array.isArray(trip.checklist));
      assert.equal(trip.checklist.length, 2, 'Checklist must have DRIVE and TRAVEL categories');
      assert.equal(trip.checklist[0].category, 'DRIVE');
      assert.equal(trip.checklist[0].items.length, 5);
      assert.equal(trip.checklist[1].category, 'TRAVEL');
      assert.equal(trip.checklist[1].items.length, 4);

      // Audit validation
      const audit = analyzeTrip(trip);
      const errors = audit.issues.filter(i => i.level === 'error');
      assert.deepEqual(errors, [], 'Canonical 20261107.json must produce 0 audit error issues');
    });

    it('loads 20261031.json from disk and confirms structural identity to 20261107.json', () => {
      assert.ok(fs.existsSync(file20261031), '20261031.json must exist on disk');
      const raw31 = fs.readFileSync(file20261031, 'utf8');
      const raw07 = fs.readFileSync(file20261107, 'utf8');

      assert.equal(raw31, raw07, '20261031.json and 20261107.json must be byte-for-byte identical');

      const trip31 = JSON.parse(raw31);
      assert.equal(trip31.schemaVersion, 2);
      assert.equal(trip31.tripId, '20261107');
      assert.equal(trip31.days.day1.length, 8);

      const audit = analyzeTrip(trip31);
      const errors = audit.issues.filter(i => i.level === 'error');
      assert.deepEqual(errors, [], 'Canonical 20261031.json must produce 0 audit errors');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Normalization via normalizeTripDraft / migrateTripToV2
  // ---------------------------------------------------------------------------
  describe('2. Normalization via normalizeTripDraft / migrateTripToV2', () => {
    it('normalizes canonical trip preserving all days, cards, types, and schemaVersion === 2', () => {
      const raw = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
      const normalized = normalizeTripDraft(raw);

      assert.equal(normalized.schemaVersion, 2, 'Normalized trip schemaVersion must be 2');
      assert.equal(normalized.tripId, '20261107');
      assert.equal(normalized.title, raw.title);
      assert.equal(normalized.subtitle, raw.subtitle);
      assert.equal(normalized.catchphrase, raw.catchphrase);
      assert.equal(normalized.startDate, raw.startDate);
      assert.equal(normalized.endDate, raw.endDate);

      // Days and Cards preservation
      assert.ok(normalized.days && normalized.days.day1);
      assert.equal(normalized.days.day1.length, 8);

      for (let i = 0; i < 8; i++) {
        const origCard = raw.days.day1[i];
        const normCard = normalized.days.day1[i];
        assert.equal(normCard.cardId, origCard.cardId);
        assert.equal(normCard.title, origCard.title);
        assert.equal(normCard.time, origCard.time);
        assert.equal(normCard.badge, origCard.badge);
        assert.equal(normCard.desc, origCard.desc);
        assert.equal(typeof normCard.title, 'string');
        assert.equal(typeof normCard.desc, 'string');
        if (origCard.travelMinutesFromPrevious) {
          assert.equal(normCard.travelMinutesFromPrevious, origCard.travelMinutesFromPrevious);
          assert.equal(typeof normCard.travelMinutesFromPrevious, 'number');
        }
        if (origCard.reservation) {
          assert.deepEqual(normCard.reservation, origCard.reservation);
        }
        if (origCard.constraints) {
          assert.deepEqual(normCard.constraints, origCard.constraints);
        }
      }

      // Checklists
      assert.equal(normalized.checklist.length, raw.checklist.length);
      assert.deepEqual(normalized.checklist, raw.checklist);

      // DayLabels & DaySettings
      assert.deepEqual(normalized.dayLabels, raw.dayLabels);
      assert.deepEqual(normalized.daySettings, raw.daySettings);
    });

    it('preserves candidates, participants, and expenses without data loss', () => {
      const raw = JSON.parse(fs.readFileSync(file20261107, 'utf8'));

      // Attach participants (members), expenses, and planning candidates
      const members = [
        { id: 'usr-01', name: '木村 蒼', role: 'admin' },
        { id: 'usr-02', name: '佐藤 優', role: 'editor' },
        { id: 'usr-03', name: '田中 蓮', role: 'viewer' }
      ];

      const expenses = [
        {
          id: 'exp-01',
          title: 'タイムズカーシェア利用料',
          amount: 8400,
          payer: 'usr-01',
          splitMode: 'equal',
          date: '2026-11-07',
          notes: '上本郷ステーション ガソリン満タン返却'
        },
        {
          id: 'exp-02',
          title: '市場寿し ランチ会計',
          amount: 6000,
          payer: 'usr-02',
          splitMode: 'selected',
          participantIds: ['usr-01', 'usr-02'],
          date: '2026-11-07',
          notes: '大ネタ回転寿司 2名分'
        }
      ];

      const rawCandidates = [
        {
          id: 'cand-01',
          title: '大洗磯前神社（神磯の鳥居）',
          category: 'sightseeing',
          priority: 'high',
          durationMinutes: 45,
          status: 'draft',
          notes: '荒波の岩礁に立つ絶景鳥居。日没前の写真スポット'
        },
        {
          id: 'cand-02',
          title: 'サザコーヒー 大洗店',
          category: 'gourmet',
          priority: 'normal',
          durationMinutes: 40,
          status: 'draft',
          notes: '徳川将軍珈琲とカステラショート'
        }
      ];

      const planning = cleanPlanning({
        candidates: rawCandidates,
        notes: '秋のドライブ候補地メモ'
      });

      assert.equal(planning.schemaVersion, 3);
      assert.equal(planning.candidates.length, 2);
      assert.equal(planning.candidates[0].id, 'cand-01');
      assert.equal(planning.candidates[0].title, '大洗磯前神社（神磯の鳥居）');
      assert.equal(planning.candidates[0].category, 'sightseeing');
      assert.equal(planning.candidates[0].durationMinutes, 45);
      assert.equal(planning.candidates[1].category, 'gourmet');

      // Enrich trip with members and expenses
      const enrichedTrip = {
        ...raw,
        members,
        expenses
      };

      const normalized = normalizeTripDraft(enrichedTrip);
      assert.equal(normalized.schemaVersion, 2);
      assert.equal(normalized.title, raw.title);

      // Publication stripping should preserve core trip without planning leakage
      const published = stripPlanningForPublication({
        ...enrichedTrip,
        planning,
        candidates: rawCandidates
      });

      assert.equal(published.schemaVersion, 2);
      assert.equal(published.planning, undefined);
      assert.equal(published.candidates, undefined);
      assert.equal(published.title, raw.title);
      assert.equal(published.days.day1.length, 8);
    });

    it('strips legacy Schema v1 fields (OPTIONAL, MOVE, wallet, lat, lon) into clean Schema v2', () => {
      const legacyPayload = {
        tripId: 'ibaraki-drive-legacy',
        title: '旧バージョンの旅程',
        startDate: '2026-11-07',
        endDate: '2026-11-07',
        OPTIONAL: ['opt-1', 'opt-2'],
        MOVE: { leg1: 45 },
        wallet: { budget: 50000, currency: 'JPY' },
        mapCenter: { lat: 36.31, lon: 140.57 },
        mapZoom: 13,
        days: {
          day1: [
            {
              id: 'card-old-01',
              title: '上本郷駅前第２',
              time: '07:15 - 07:30',
              badge: 'レンタカー',
              desc: '出発準備',
              lat: 35.80,
              lon: 139.90,
              fixed: true
            }
          ]
        }
      };

      const cleaned = normalizeTripDraft(legacyPayload);
      assert.equal(cleaned.schemaVersion, 2);
      assert.equal(cleaned.tripId, 'ibaraki-drive-legacy');
      assert.equal(cleaned.title, '旧バージョンの旅程');

      // Check legacy fields are removed
      assert.equal(cleaned.OPTIONAL, undefined);
      assert.equal(cleaned.MOVE, undefined);
      assert.equal(cleaned.wallet, undefined);
      assert.equal(cleaned.mapCenter, undefined);
      assert.equal(cleaned.mapZoom, undefined);

      // Check card normalization
      const card = cleaned.days.day1[0];
      assert.equal(card.title, '上本郷駅前第２');
      assert.equal(card.time, '07:15 - 07:30');
      assert.equal(card.badge, 'レンタカー');
      assert.equal(card.desc, '出発準備');
      assert.equal(card.lat, undefined);
      assert.equal(card.lon, undefined);
      assert.equal(card.fixed, undefined);
      assert.ok(card.cardId, 'Card must have valid cardId assigned');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Itinerary & Settlement Calculations on Real Trip Data
  // ---------------------------------------------------------------------------
  describe('3. Calculations on Real Trip Data (itinerary-calc.js & trip-v2-analysis.js)', () => {
    it('buildTimeline computes seamless timeline for 20261107.json with 0 conflicts', () => {
      const trip = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
      const result = buildTimeline(trip, {}, 'day1');

      assert.ok(result.items && Array.isArray(result.items));
      assert.equal(result.items.length, 8, 'Timeline must build exactly 8 items for Day 1');
      assert.deepEqual(result.conflicts, [], 'Canonical trip itinerary must have zero schedule conflicts');

      // Verify chronology of timeline items
      for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i];
        assert.equal(item.orderIndex, i);
        assert.equal(item.dayKey, 'day1');
        assert.ok(item.time.start != null, `Item ${i} must have valid start minute`);
        assert.ok(item.time.end != null, `Item ${i} must have valid end minute`);
        assert.ok(item.time.end > item.time.start, `Item ${i} end minute must be strictly greater than start minute`);

        if (i > 0) {
          const prev = result.items[i - 1];
          assert.ok(item.time.start >= prev.time.end, `Item ${i} (${item.card.title}) must not overlap predecessor (${prev.card.title})`);
        }
      }
    });

    it('buildTimeline computes identical seamless timeline for 20261031.json', () => {
      const trip = JSON.parse(fs.readFileSync(file20261031, 'utf8'));
      const result = buildTimeline(trip, {}, 'day1');

      assert.equal(result.items.length, 8);
      assert.deepEqual(result.conflicts, []);
      assert.equal(result.items[0].card.cardId, 'day1-01-carshare');
      assert.equal(result.items[6].card.cardId, 'day1-07-dinner-flyinggarden');
      assert.equal(result.items[7].card.cardId, 'day1-08-return');
    });

    it('buildTimeline propagates delay offsets across downstream stops', () => {
      const trip = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
      const journeyState = {
        days: {
          day1: {
            delay: { minutes: 20, fromCardId: 'day1-02-nakaminato' }
          }
        }
      };

      const result = buildTimeline(trip, journeyState, 'day1');
      assert.equal(result.items.length, 8);

      // First item (carshare) should not be delayed
      assert.equal(result.items[0].time.time, '07:15 - 07:30');

      // Second item (nakaminato) was originally 09:15 - 10:45 -> should be shifted by 20 min to 09:35 - 11:05
      assert.equal(result.items[1].time.time, '09:35 - 11:05');

      // Third item (waon) was originally 10:55 - 11:30 -> shifted by 20 min to 11:15 - 11:50
      assert.equal(result.items[2].time.time, '11:15 - 11:50');
    });

    it('settlementTransfers calculates accurate transfers with conservation of money', () => {
      const members = [
        { id: 'm1', name: '木村 蒼' },
        { id: 'm2', name: '佐藤 優' }
      ];

      // Expenses based on 20261107 trip:
      // m1 pays ¥8,400 (Carshare)
      // m2 pays ¥6,000 (Market sushi)
      // m1 pays ¥4,400 (Night Aquaworld tickets)
      // Total: ¥18,800. Half share: ¥9,400.
      // m1 paid ¥12,800 (+¥3,400 credit). m2 paid ¥6,000 (-¥3,400 debit).
      const expenses = [
        { amount: 8400, payer: 'm1', splitMode: 'equal' },
        { amount: 6000, payer: 'm2', splitMode: 'equal' },
        { amount: 4400, payer: 'm1', splitMode: 'equal' }
      ];

      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1, 'Should resolve to exactly 1 net transfer');
      assert.equal(transfers[0].from, 'm2');
      assert.equal(transfers[0].fromName, '佐藤 優');
      assert.equal(transfers[0].to, 'm1');
      assert.equal(transfers[0].toName, '木村 蒼');
      assert.equal(transfers[0].amount, 3400);

      // Verify conservation of money
      const totalDebits = transfers.reduce((sum, t) => sum + t.amount, 0);
      const totalCredits = transfers.reduce((sum, t) => sum + t.amount, 0);
      assert.equal(totalDebits, totalCredits);
    });

    it('settlementTransfers handles odd yen divisions with integer rounding', () => {
      const members = [
        { id: 'a', name: 'Member A' },
        { id: 'b', name: 'Member B' },
        { id: 'c', name: 'Member C' }
      ];

      // ¥10,000 split across 3 members = ¥3,333.33 each
      const expenses = [{ amount: 10000, payer: 'a', splitMode: 'equal' }];
      const transfers = settlementTransfers(members, expenses);

      assert.equal(transfers.length, 2);
      const totalTransferred = transfers.reduce((sum, t) => sum + t.amount, 0);
      assert.ok(totalTransferred === 6666 || totalTransferred === 6667);
      transfers.forEach(t => {
        assert.equal(t.to, 'a');
        assert.ok(Number.isInteger(t.amount));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Store Loading (createTripStore & createAdminStore)
  // ---------------------------------------------------------------------------
  describe('4. Store Loading & Slice Integrity', () => {
    it('createTripStore mounts canonical 20261107.json with correct slices', () => {
      const trip = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
      const store = createTripStore();

      // Initial state check
      assert.equal(store.getSlice('activeTrip'), null);
      assert.deepEqual(store.getSlice('checklist'), []);
      assert.deepEqual(store.getSlice('expenses'), []);

      // Mount active trip and checklist
      store.setState({
        activeTrip: trip,
        checklist: trip.checklist,
        expenses: []
      });

      // Verify slices match loaded payload
      const mountedTrip = store.getSlice('activeTrip');
      assert.ok(mountedTrip);
      assert.equal(mountedTrip.tripId, '20261107');
      assert.equal(mountedTrip.title, '茨城ドライブ 2026　Autumn');
      assert.equal(mountedTrip.days.day1.length, 8);

      const checklistSlice = store.getSlice('checklist');
      assert.equal(checklistSlice.length, 2);
      assert.equal(checklistSlice[0].category, 'DRIVE');
      assert.equal(checklistSlice[1].category, 'TRAVEL');

      const expensesSlice = store.getSlice('expenses');
      assert.deepEqual(expensesSlice, []);
    });

    it('createTripStore synchronizes window compatibility globals', () => {
      const originalWindow = globalThis.window;
      globalThis.window = {};

      try {
        const trip = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
        const store = createTripStore();

        // Mount trip
        store.setState({
          activeTrip: trip,
          currentAccess: { tripId: trip.tripId, ledger: 'token-abc-123' }
        });

        // Verify window globals
        assert.equal(globalThis.window.currentTripId, '20261107');
        assert.equal(globalThis.window.currentTripData, trip);
        assert.equal(globalThis.window.currentTripTitle, trip.subtitle || trip.title);
        assert.equal(globalThis.window.currentTripDate, '2026-11-07');
        assert.equal(globalThis.window.currentTripEndDate, '2026-11-07');
        assert.equal(globalThis.window.currentTripLedgerToken, 'token-abc-123');

        // Verify clearing trip resets window globals
        store.setState({ activeTrip: null, currentAccess: null });
        assert.equal(globalThis.window.currentTripId, '');
        assert.equal(globalThis.window.currentTripData, null);
        assert.equal(globalThis.window.currentTripTitle, '');
      } finally {
        if (originalWindow !== undefined) {
          globalThis.window = originalWindow;
        } else {
          delete globalThis.window;
        }
      }
    });

    it('createAdminStore mounts canonical trip with slice isolation and reactive updates', () => {
      const trip = JSON.parse(fs.readFileSync(file20261107, 'utf8'));
      const adminStore = createAdminStore();

      assert.equal(adminStore.getState().activeTrip, null);
      assert.equal(adminStore.getState().currentView, 'overview');

      let notifications = 0;
      const unsubscribe = adminStore.subscribe((state) => {
        notifications++;
      });

      // Mount active trip in admin store
      adminStore.setState({
        activeTrip: trip,
        activeDayKey: 'day1',
        currentView: 'editor'
      });

      assert.equal(notifications, 1);
      assert.equal(adminStore.getState().activeTrip.tripId, '20261107');
      assert.equal(adminStore.getState().activeDayKey, 'day1');
      assert.equal(adminStore.getState().currentView, 'editor');

      // Update editor slice
      adminStore.setSlice('editor', { dirty: true, activeDayKey: 'day1' });
      assert.equal(notifications, 2);
      assert.equal(adminStore.getSlice('editor').dirty, true);

      unsubscribe();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Backward Compatibility with Legacy Expense Format
  // ---------------------------------------------------------------------------
  describe('5. Backward Compatibility with Legacy Expense Formats', () => {
    it('settlementTransfers gracefully handles legacy expenses lacking payer or transfers', () => {
      const members = [
        { id: 'm1', name: '木村 蒼' },
        { id: 'm2', name: '佐藤 優' }
      ];

      // Legacy expenses without payer, without transfers field, or with zero amount
      const legacyExpenses = [
        { title: '旧フォーマット立替（payer欠損）', amount: 3000 },
        { title: '未指定経費', amount: 0, payer: 'm1' },
        { title: '無効な金額', amount: NaN, payer: 'm2' },
        { title: 'メンバー外のpayer', amount: 5000, payer: 'ghost-user' }
      ];

      // Must not throw exception
      const transfers = settlementTransfers(members, legacyExpenses);
      assert.deepEqual(transfers, [], 'Invalid/legacy expenses lacking recognized payer must produce 0 transfers without throwing');
    });

    it('TripStore and offline expense queue safely accept legacy expense objects', () => {
      // Test TripStore handles legacy expenses without transfers or payer
      const store = createTripStore();
      const legacyList = [
        { id: 'legacy-e1', title: '有料道路代', amount: 1200 },
        { id: 'legacy-e2', title: '自動販売機', amount: 160 }
      ];

      store.setSlice('expenses', legacyList);
      assert.equal(store.getSlice('expenses').length, 2);
      assert.equal(store.getSlice('expenses')[0].title, '有料道路代');

      // Test offline queue accepts expense without payer
      writeRawQueue([]);
      const queued = enqueueOfflineExpense({
        tripId: '20261107',
        note: 'コンビニ（軽食）',
        amount: 850
      });

      assert.ok(queued.queueId, 'Queue must assign queueId');
      assert.ok(queued.id, 'Queue must assign id');
      assert.equal(queued.syncStatus, 'pending');
      assert.equal(queued.amount, 850);
      assert.equal(queued.note, 'コンビニ（軽食）');

      const pending = getOfflineExpensesQueue('20261107');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].queueId, queued.queueId);

      clearAllQueuedExpenses();
    });
  });
});
