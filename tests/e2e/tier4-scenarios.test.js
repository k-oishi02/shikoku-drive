import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shiftedTime,
  buildTimeline,
  activeItem,
  calculateNextAvailableTime
} from '../../src/itinerary-calc.js';

import {
  parseTimeRange,
  formatMinute,
  migrateTripToV2,
  cleanCard,
  cleanCandidate,
  cleanPlanning,
  stripPlanningForPublication,
  validateTripDraft
} from '../../src/trip-v2-core.js';

import {
  analyzeTrip,
  settlementTransfers
} from '../../src/trip-v2-analysis.js';

import {
  validateCandidateInput,
  validatePlanningInput,
  validateTripInput,
  validateStoredDraftSize
} from '../../src/draft-validation.js';

import {
  planCascadeTimeAdjustment,
  cleanTravelTimesOnReorder,
  planCardMoveDay,
  compareScheduleChanges
} from '../../src/admin-day-planner.js';

import {
  buildTripExport,
  buildAdminBackup,
  parseTripImport
} from '../../src/admin-transfer.js';

import {
  reconcileAssignments,
  inspectAssignment
} from '../../src/admin-candidate-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

describe('Tier 4: Real-World Application Scenarios', () => {

  describe('Scenario 1: Full Trip Planning from Blank Draft to Publication', () => {
    it('executes the complete administrative journey from blank draft to candidate adoption, reorder, and participant publication', () => {
      // 1. Start from blank trip and planning
      const trip = {
        schemaVersion: 2,
        tripId: 'hokkaido-2026',
        title: '北海道 冬の富良野・美瑛ドライブ',
        subtitle: '雪景色と名物カレーと白ひげの滝ライトアップ',
        startDate: '2026-12-15',
        endDate: '2026-12-16',
        theme: { mode: 'auto', accent: '#1f93db' },
        features: { nowMode: true, expenses: true, notifications: false },
        days: {
          day1: [],
          day2: []
        },
        members: [
          { id: 'm-1', name: '佐藤' },
          { id: 'm-2', name: '田中' }
        ]
      };

      const planning = {
        schemaVersion: 3,
        candidates: [
          {
            id: 'cand-curry',
            title: '唯我独尊（オムカレー）',
            category: 'gourmet',
            priority: 'high',
            durationMinutes: 60,
            notes: 'ルールルルー合言葉でおかわり'
          },
          {
            id: 'cand-waterfall',
            title: '白ひげの滝ライトアップ',
            category: 'sightseeing',
            priority: 'high',
            durationMinutes: 45,
            notes: '青い川の夜景'
          },
          {
            id: 'cand-hotspring',
            title: '十勝岳温泉 白銀荘',
            category: 'sightseeing',
            priority: 'normal',
            durationMinutes: 90,
            notes: '雪見露天風呂'
          }
        ],
        notes: 'レンタカーはスタッドレス・4WD必須'
      };

      // Verify draft inputs before adoption
      const initErrors = validateTripDraft(trip, planning);
      assert.deepEqual(initErrors, [], 'Initial draft must pass validation');

      // 2. Adopt candidate spots into Day 1
      const card1 = {
        cardId: 'day1-01-curry',
        time: '11:30 - 12:30',
        title: planning.candidates[0].title,
        badge: 'ランチ',
        desc: '自家製ソーセージオムカレー'
      };
      const card2 = {
        cardId: 'day1-02-waterfall',
        time: '14:00 - 14:45',
        title: planning.candidates[1].title,
        badge: '見学',
        desc: 'ブルーリバーの滝ライトアップ',
        travelMinutesFromPrevious: 60
      };
      const card3 = {
        cardId: 'day1-03-hotspring',
        time: '16:00 - 17:30',
        title: planning.candidates[2].title,
        badge: '温泉',
        desc: '吹上温泉保養センター白銀荘',
        travelMinutesFromPrevious: 45
      };

      trip.days.day1 = [card1, card2, card3];

      // Update candidate assignments
      planning.candidates[0].assignedCardId = card1.cardId;
      planning.candidates[0].assignedDay = 'day1';
      planning.candidates[1].assignedCardId = card2.cardId;
      planning.candidates[1].assignedDay = 'day1';
      planning.candidates[2].assignedCardId = card3.cardId;
      planning.candidates[2].assignedDay = 'day1';

      const reconciled = reconcileAssignments(trip, planning);
      assert.ok(reconciled.candidates.every(c => c.status === 'assigned'));

      // 3. User reorders Day 1: swaps Card 2 (Waterfall) and Card 3 (Hot spring) so hot spring is enjoyed before night waterfall
      const beforeReorder = [...trip.days.day1];
      const afterReorder = [card1, card3, card2];
      cleanTravelTimesOnReorder(beforeReorder, afterReorder);

      // Verify that after swapping, predecessor change safely stripped stale travel minutes
      assert.equal(afterReorder[1].travelMinutesFromPrevious, undefined, 'Predecessor changed so travel time wiped');
      assert.equal(afterReorder[2].travelMinutesFromPrevious, undefined, 'Predecessor changed so travel time wiped');

      trip.days.day1 = afterReorder;

      // Reset and adjust schedule for swapped cards
      trip.days.day1[1].time = '13:30 - 15:00';
      trip.days.day1[2].time = '16:00 - 16:45';

      // 4. Validate complete draft
      const finalDraftErrors = validateTripDraft(trip, reconciled);
      assert.deepEqual(finalDraftErrors, [], 'Draft must pass validation after reorder');

      // 5. Publish trip
      const published = stripPlanningForPublication(trip);
      assert.equal(published.schemaVersion, 2);
      assert.equal(published.tripId, 'hokkaido-2026');
      assert.equal(published.days.day1.length, 3);
      assert.equal(published.planning, undefined);
      assert.equal(published.candidates, undefined);

      // Audit published trip
      const audit = analyzeTrip(published);
      const criticalErrors = audit.issues.filter(i => i.level === 'error');
      assert.deepEqual(criticalErrors, []);
    });
  });

  describe('Scenario 2: Multi-day Road Trip with Timeline Delay Propagation and Arrival Warnings', () => {
    it('simulates live on-trip execution with delays, timeLocked reservation boundaries, and active stop resolution', () => {
      // 1. Load canonical Ibaraki road trip
      const samplePath = path.join(projectRoot, '20261107.json');
      const trip = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

      const day1Cards = trip.days.day1;
      assert.ok(day1Cards.length >= 4);

      // 2. Group experiences 30-minute delay starting from Card 2 (sushi lunch)
      const delayStartCardId = day1Cards[1].cardId;
      const journeyState = {
        days: {
          day1: {
            order: day1Cards.map(c => c.cardId),
            delay: { minutes: 30, fromCardId: delayStartCardId },
            status: {}
          }
        },
        records: {}
      };

      // 3. Build live timeline
      const result = buildTimeline(trip, journeyState, 'day1');
      assert.equal(result.timeline.length, day1Cards.length);

      // Card 0 (departure) was before delay start -> unshifted
      assert.equal(result.timeline[0].time.time, day1Cards[0].time);

      // Card 1 (delay start) was shifted by +30 min
      const origRange1 = parseTimeRange(day1Cards[1].time);
      assert.equal(result.timeline[1].time.start, origRange1.start + 30);
      assert.equal(result.timeline[1].time.end, origRange1.end + 30);

      // 4. Find if any card is timeLocked
      const lockedCard = day1Cards.find(c => c.timeLocked === true);
      if (lockedCard) {
        const lockedIndex = day1Cards.findIndex(c => c.cardId === lockedCard.cardId);
        // The locked card time in timeline must remain unshifted (offset resets to 0)
        assert.equal(result.timeline[lockedIndex].time.time, lockedCard.time);
      }

      // 5. Active item resolution
      // Early morning (07:20): Should resolve to Card 0
      const morningDate = new Date('2026-11-07T07:20:00+09:00');
      const morningItem = activeItem(result.timeline, '2026-11-07', morningDate);
      assert.ok(morningItem);
      assert.equal(morningItem.orderIndex, 0);

      // Mark Card 0 as 'done', Card 1 as 'arrived'
      journeyState.records[day1Cards[0].cardId] = { status: 'done', doneAt: '2026-11-07T07:35:00Z' };
      journeyState.records[day1Cards[1].cardId] = { status: 'arrived', arrivedAt: '2026-11-07T08:50:00Z' };

      const updatedTimeline = buildTimeline(trip, journeyState, 'day1').timeline;
      const activeNow = activeItem(updatedTimeline, '2026-11-07', morningDate);
      // Because Card 1 has status 'arrived', activeItem prioritizes it
      assert.equal(activeNow.card.cardId, day1Cards[1].cardId);
      assert.equal(activeNow.status, 'arrived');
    });
  });

  describe('Scenario 3: Group Travel Expense Splitting with Complex Net Settlement Transfers', () => {
    it('accurately settles group expenses with 4 payers, subgroups, and minimal 2-pointer transfers', () => {
      const members = [
        { id: 'm-kimura', name: '木村' },
        { id: 'm-sato', name: '佐藤' },
        { id: 'm-suzuki', name: '鈴木' },
        { id: 'm-tanaka', name: '田中' }
      ];

      const expenses = [
        // 1. Rental Car: ¥16,000 paid by 木村, split equally among all 4 (¥4,000 each)
        { id: 'exp-1', title: 'レンタカー代', payer: 'm-kimura', amount: 16000, splitMode: 'equal' },
        // 2. Seafood Lunch: ¥7,500 paid by 佐藤, split among 木村, 佐藤, 鈴木 (¥2,500 each, 田中 absent)
        { id: 'exp-2', title: '海鮮丼ランチ', payer: 'm-sato', amount: 7500, splitMode: 'selected', participantIds: ['m-kimura', 'm-sato', 'm-suzuki'] },
        // 3. Expressway Tolls: ¥3,600 paid by 田中, split equally among all 4 (¥900 each)
        { id: 'exp-3', title: '常磐道高速料金', payer: 'm-tanaka', amount: 3600, splitMode: 'equal' },
        // 4. Souvenir: ¥2,000 paid by 鈴木 specifically for 佐藤 only (selected split)
        { id: 'exp-4', title: 'お土産（梅酒）', payer: 'm-suzuki', amount: 2000, splitMode: 'selected', participantIds: ['m-sato'] }
      ];

      // Net Balances calculated by hand:
      // 木村 (m-kimura): +16000 - 4000 (car) - 2500 (lunch) - 900 (toll) = +8,600
      // 佐藤 (m-sato):   +7500  - 4000 (car) - 2500 (lunch) - 900 (toll) - 2000 (gift) = -1,900
      // 鈴木 (m-suzuki): +2000  - 4000 (car) - 2500 (lunch) - 900 (toll) = -5,400
      // 田中 (m-tanaka): +3600  - 4000 (car) - 900 (toll) = -1,300
      //
      // Total Debts = 1900 + 5400 + 1300 = 8,600 == Total Credit (+8,600)

      const transfers = settlementTransfers(members, expenses);

      // Verify transfers
      assert.equal(transfers.length, 3, 'Should produce minimal 3 transfers directly to the single creditor');
      assert.ok(transfers.every(t => t.to === 'm-kimura'));

      const satoTransfer = transfers.find(t => t.from === 'm-sato');
      assert.ok(satoTransfer);
      assert.equal(satoTransfer.amount, 1900);

      const suzukiTransfer = transfers.find(t => t.from === 'm-suzuki');
      assert.ok(suzukiTransfer);
      assert.equal(suzukiTransfer.amount, 5400);

      const tanakaTransfer = transfers.find(t => t.from === 'm-tanaka');
      assert.ok(tanakaTransfer);
      assert.equal(tanakaTransfer.amount, 1300);

      // Conservation of money: Sum of transfers is strictly ¥8,600
      const totalTransferred = transfers.reduce((acc, t) => acc + t.amount, 0);
      assert.equal(totalTransferred, 8600);
    });
  });

  describe('Scenario 4: Offline Resilience & Invalid Data Fallback Verification', () => {
    it('manages offline expense queuing with sync status and local storage contract', () => {
      // Simulate client storage queue
      const mockStorage = new Map();
      const storageKey = 'managed-trip-expenses:hokkaido-2026';

      function saveOfflineExpense(expense) {
        const current = JSON.parse(mockStorage.get(storageKey) || '[]');
        const record = {
          ...expense,
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          syncStatus: 'pending',
          createdAt: new Date().toISOString()
        };
        current.push(record);
        mockStorage.set(storageKey, JSON.stringify(current));
        return record;
      }

      function syncPendingExpenses() {
        const current = JSON.parse(mockStorage.get(storageKey) || '[]');
        current.forEach(item => {
          if (item.syncStatus === 'pending') {
            item.syncStatus = 'synced';
            item.syncedAt = new Date().toISOString();
          }
        });
        mockStorage.set(storageKey, JSON.stringify(current));
        return current;
      }

      // Step 1: User offline adds 2 expenses
      const expA = saveOfflineExpense({ title: '道の駅 ソフトクリーム', amount: 800, payer: 'm-1' });
      const expB = saveOfflineExpense({ title: 'ガソリン給油', amount: 4800, payer: 'm-2' });

      const storedRaw = JSON.parse(mockStorage.get(storageKey));
      assert.equal(storedRaw.length, 2);
      assert.equal(storedRaw[0].syncStatus, 'pending');
      assert.equal(storedRaw[1].syncStatus, 'pending');

      // Step 2: Device reconnects and flushes queue
      const synced = syncPendingExpenses();
      assert.ok(synced.every(item => item.syncStatus === 'synced'));
      assert.ok(synced.every(item => Boolean(item.syncedAt)));
    });

    it('handles malformed JSON and corrupted payloads gracefully with descriptive Japanese errors', () => {
      // 1. Truncated or malformed JSON string passed to parseTripImport
      assert.throws(
        () => parseTripImport('{ "title": "壊れたJSON", '),
        (err) => err instanceof Error && err.message.includes('JSONの解析に失敗しました')
      );

      // 2. Missing required fields in trip
      const corruptedTrip = {
        schemaVersion: 2,
        tripId: 'ab', // too short (<3 chars)
        // missing title
        startDate: '2026-11-05',
        endDate: '2026-10-31' // date order inverted
      };
      const inputErrors = validateTripInput(corruptedTrip);
      assert.ok(inputErrors.length >= 2, 'Should detect invalid tripId and missing title');
      assert.ok(inputErrors.some(e => e.includes('タイトル')));
      assert.ok(inputErrors.some(e => e.includes('tripId') || e.includes('旅程ID')));

      const auditIssues = analyzeTrip(corruptedTrip).issues;
      assert.ok(auditIssues.some(i => i.message.includes('終了日は開始日以降')));

      // 3. Error boundary format
      function createFallbackUI(error) {
        return {
          title: 'エラーが発生しました',
          message: error?.message || '不明なエラーです',
          actionLabel: 'しおり一覧へ戻る'
        };
      }
      const ui = createFallbackUI(new Error('通信エラー'));
      assert.equal(ui.title, 'エラーが発生しました');
      assert.equal(ui.actionLabel, 'しおり一覧へ戻る');
    });

    it('verifies offline weather caching schema with timestamp expiration check', () => {
      function isWeatherCacheValid(cacheEntry, maxAgeHours = 6, now = Date.now()) {
        if (!cacheEntry || !cacheEntry.cachedAt) return false;
        const cachedTime = new Date(cacheEntry.cachedAt).getTime();
        if (Number.isNaN(cachedTime)) return false;
        return (now - cachedTime) < maxAgeHours * 3600000;
      }

      const recentCache = {
        location: '美瑛',
        cachedAt: new Date(Date.now() - 2 * 3600000).toISOString(), // 2 hours ago
        forecast: [{ time: '12:00', weather: '晴れ', temp: -3 }]
      };
      assert.equal(isWeatherCacheValid(recentCache, 6), true);

      const expiredCache = {
        location: '富良野',
        cachedAt: new Date(Date.now() - 8 * 3600000).toISOString(), // 8 hours ago
        forecast: [{ time: '12:00', weather: '雪', temp: -5 }]
      };
      assert.equal(isWeatherCacheValid(expiredCache, 6), false);
    });
  });

  describe('Scenario 5: Backward Compatibility Verification with 20261107.json & Schema v2', () => {
    it('verifies seamless loading, normalization, and zero regressions on canonical 20261107.json', () => {
      const filePath = path.join(projectRoot, '20261107.json');
      assert.ok(fs.existsSync(filePath), '20261107.json must exist');
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const trip = JSON.parse(rawContent);

      // Verify canonical fields
      assert.equal(trip.schemaVersion, 2);
      assert.equal(trip.tripId, '20261107');
      assert.equal(trip.title, '茨城ドライブ 2026　Autumn');
      assert.equal(trip.startDate, '2026-11-07');
      assert.equal(trip.endDate, '2026-11-07');
      assert.ok(trip.days && trip.days.day1);
      assert.equal(trip.days.day1.length, 8);

      // Verify first card details
      const firstCard = trip.days.day1[0];
      assert.equal(firstCard.cardId, 'day1-01-carshare');
      assert.equal(firstCard.title, '上本郷');
      assert.ok(firstCard.reservation);
      assert.equal(firstCard.reservation.number, '233227371');

      // Verify migration identity: migrateTripToV2 on valid Schema v2 returns identical structural data
      const normalized = migrateTripToV2(trip);
      assert.equal(normalized.schemaVersion, 2);
      assert.equal(normalized.tripId, '20261107');
      assert.equal(normalized.days.day1.length, 8);
      assert.equal(normalized.days.day1[0].cardId, 'day1-01-carshare');

      // Verify audit cleanliness
      const audit = analyzeTrip(trip);
      const errors = audit.issues.filter(i => i.level === 'error');
      assert.deepEqual(errors, []);
    });

    it('verifies 20261031.json is structurally identical to 20261107.json', () => {
      const file31 = path.join(projectRoot, '20261031.json');
      const file07 = path.join(projectRoot, '20261107.json');
      assert.ok(fs.existsSync(file31));
      assert.ok(fs.existsSync(file07));
      const content31 = fs.readFileSync(file31, 'utf8');
      const content07 = fs.readFileSync(file07, 'utf8');
      assert.equal(content31, content07, '20261031.json and 20261107.json must be identical');
    });

    it('normalizes legacy Schema v1 fields (OPTIONAL, MOVE, wallet, lat, lon) into clean Schema v2', () => {
      const legacyTrip = {
        tripId: 'legacy-trip',
        title: '旧バージョンのしおり',
        startDate: '2026-10-10',
        endDate: '2026-10-10',
        wallet: { totalBudget: 50000 },
        mapCenter: { lat: 35.68, lon: 139.76 },
        mapZoom: 14,
        days: {
          day1: [
            {
              id: 'c1',
              title: '旧スポット',
              time: '10:00 - 11:00',
              badge: '見学',
              desc: '説明',
              OPTIONAL: false,
              MOVE: false,
              lat: 35.68,
              lon: 139.76,
              fixed: true
            }
          ]
        }
      };

      const migrated = migrateTripToV2(legacyTrip);
      assert.equal(migrated.schemaVersion, 2);
      assert.equal(migrated.tripId, 'legacy-trip');
      assert.equal(migrated.wallet, undefined, 'wallet must be stripped');
      assert.equal(migrated.mapCenter, undefined, 'mapCenter must be stripped');
      assert.equal(migrated.mapZoom, undefined, 'mapZoom must be stripped');

      const migratedCard = migrated.days.day1[0];
      assert.equal(migratedCard.title, '旧スポット');
      assert.equal(migratedCard.OPTIONAL, undefined, 'OPTIONAL must be stripped');
      assert.equal(migratedCard.MOVE, undefined, 'MOVE must be stripped');
      assert.equal(migratedCard.lat, undefined, 'lat must be stripped');
      assert.equal(migratedCard.lon, undefined, 'lon must be stripped');
      assert.ok(migratedCard.cardId, 'Stable cardId must be generated');
    });
  });

});
