import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTravelTimesOnReorder,
  planCascadeTimeAdjustment,
  planCardMoveDay,
  applyDayPlan,
  undoDayPlan
} from '../src/admin-day-planner.js';

describe('Admin Day Planner Suite', () => {

  describe('cleanTravelTimesOnReorder & 3-pass card matching', () => {
    test('removes travelMinutesFromPrevious when a card moves to index 0', () => {
      const cardA = { cardId: 'c-a', title: 'A' };
      const cardB = { cardId: 'c-b', title: 'B', travelMinutesFromPrevious: 30 };
      const beforeCards = [cardA, cardB];
      const afterCards = [{ ...cardB }, { ...cardA }];

      cleanTravelTimesOnReorder(beforeCards, afterCards);

      assert.equal(afterCards[0].cardId, 'c-b');
      assert.equal(afterCards[0].travelMinutesFromPrevious, undefined);
    });

    test('removes travelMinutesFromPrevious when a card predecessor has changed', () => {
      const cardA = { cardId: 'c-a', title: 'A' };
      const cardB = { cardId: 'c-b', title: 'B' };
      const cardC = { cardId: 'c-c', title: 'C', travelMinutesFromPrevious: 45 };
      // Before: A -> B -> C (C was after B)
      const beforeCards = [cardA, cardB, cardC];
      // After: B -> A -> C (C is now after A)
      const afterCards = [{ ...cardB }, { ...cardA }, { ...cardC }];

      cleanTravelTimesOnReorder(beforeCards, afterCards);

      assert.equal(afterCards[2].cardId, 'c-c');
      assert.equal(afterCards[2].travelMinutesFromPrevious, undefined);
    });

    test('preserves travelMinutesFromPrevious when predecessor remains the same', () => {
      const cardA = { cardId: 'c-a', title: 'A' };
      const cardB = { cardId: 'c-b', title: 'B', travelMinutesFromPrevious: 20 };
      const cardC = { cardId: 'c-c', title: 'C' };
      // Before: A -> B -> C
      const beforeCards = [cardA, cardB, cardC];
      // After: [NewX] -> A -> B -> C (A and B are still adjacent)
      const newCard = { cardId: 'c-new', title: 'New' };
      const afterCards = [newCard, { ...cardA }, { ...cardB }, { ...cardC }];

      cleanTravelTimesOnReorder(beforeCards, afterCards);

      assert.equal(afterCards[2].cardId, 'c-b');
      assert.equal(afterCards[2].travelMinutesFromPrevious, 20);
    });

    test('matches cloned cards using content fingerprint when IDs are identical or missing', () => {
      const card1 = { title: '展望台', desc: '景色を楽しむ', mapQuery: '展望台' };
      const card2 = { title: 'カフェ', desc: '休憩', mapQuery: 'カフェ', travelMinutesFromPrevious: 15 };
      const beforeCards = [card1, card2];
      const afterCards = [
        { title: 'カフェ', desc: '休憩', mapQuery: 'カフェ', travelMinutesFromPrevious: 15 },
        { title: '展望台', desc: '景色を楽しむ', mapQuery: '展望台' }
      ];

      cleanTravelTimesOnReorder(beforeCards, afterCards);

      // Now at index 0, so travelMinutesFromPrevious should be deleted
      assert.equal(afterCards[0].travelMinutesFromPrevious, undefined);
    });
  });

  describe('planCascadeTimeAdjustment', () => {
    test('cascades sequential time adjustment across subsequent cards', () => {
      const dayCards = [
        { cardId: 'c1', title: '集合', time: '09:00 - 09:30' },
        { cardId: 'c2', title: '移動と観光', time: '09:45 - 11:00', travelMinutesFromPrevious: 15 },
        { cardId: 'c3', title: '昼食', time: '11:15 - 12:30', travelMinutesFromPrevious: 15 }
      ];

      // Delay card 1 from 09:00 to 09:30 (duration 30m -> 09:30 - 10:00)
      const result = planCascadeTimeAdjustment(dayCards, 0, '09:30', 30, { dayKey: 'day1' });

      assert.deepEqual(result.errors, []);
      // Card 1: 09:30 - 10:00
      assert.equal(result.updatedCards[0].time, '09:30 - 10:00');
      // Card 2: starts 10:00 + 15m travel = 10:15, duration 75m -> 10:15 - 11:30
      assert.equal(result.updatedCards[1].time, '10:15 - 11:30');
      // Card 3: starts 11:30 + 15m travel = 11:45, duration 75m -> 11:45 - 13:00
      assert.equal(result.updatedCards[2].time, '11:45 - 13:00');
    });

    test('halts cascade at timeLocked barrier and checks conflict', () => {
      const dayCards = [
        { cardId: 'c1', title: 'アクティビティ', time: '09:00 - 10:00' },
        { cardId: 'c2', title: '新幹線（固定）', time: '12:00 - 14:00', timeLocked: true },
        { cardId: 'c3', title: 'ホテルチェックイン', time: '15:00 - 16:00' }
      ];

      // Extend activity duration to 150m (09:00 - 11:30)
      const result = planCascadeTimeAdjustment(dayCards, 0, '09:00', 150, { dayKey: 'day1' });

      assert.deepEqual(result.errors, []);
      assert.equal(result.updatedCards[0].time, '09:00 - 11:30');
      // Locked card should NOT be moved
      assert.equal(result.updatedCards[1].time, '12:00 - 14:00');
      // Card 3 past the locked barrier should NOT be shifted
      assert.equal(result.updatedCards[2].time, '15:00 - 16:00');
      assert.ok(result.warnings.some(w => w.includes('固定予定「新幹線（固定）」に到達したため')));
    });

    test('reports collision error when cascade overflows into a timeLocked card', () => {
      const dayCards = [
        { cardId: 'c1', title: 'アクティビティ', time: '09:00 - 10:00' },
        { cardId: 'c2', title: 'フライト（固定）', time: '11:00 - 13:00', timeLocked: true }
      ];

      // Extend card 1 so it ends at 11:30 (overlaps with 11:00 flight)
      const result = planCascadeTimeAdjustment(dayCards, 0, '09:00', 150, { dayKey: 'day1' });

      assert.ok(result.errors.some(e => e.includes('固定予定「フライト（固定）」(11:00 - 13:00)の開始前に直前の予定が終わりません')));
      assert.equal(result.updatedCards[1].time, '11:00 - 13:00'); // untouched
    });

    test('rejects adjustment that causes target card to end at or after 24:00 (midnight overflow)', () => {
      const dayCards = [
        { cardId: 'c1', title: '夜のドライブ', time: '22:00 - 23:00' }
      ];

      // 22:00 + 150m = 24:30 (1470 minutes >= 1440)
      const result = planCascadeTimeAdjustment(dayCards, 0, '22:00', 150, { dayKey: 'day1' });

      assert.ok(result.errors.some(e => e.includes('終了時刻が24:00以降になります。日跨ぎはできません。')));
    });

    test('rejects adjustment that causes subsequent card to overflow 24:00', () => {
      const dayCards = [
        { cardId: 'c1', title: '夕食', time: '20:00 - 21:00' },
        { cardId: 'c2', title: '夜景散策', time: '21:30 - 23:30', travelMinutesFromPrevious: 30 }
      ];

      // Shift c1 to 22:00 (ends 23:00) -> c2 starts 23:30, duration 120m -> ends 01:30 (25:30)
      const result = planCascadeTimeAdjustment(dayCards, 0, '22:00', 60, { dayKey: 'day1' });

      assert.ok(result.errors.some(e => e.includes('後続の「夜景散策」の終了時刻が24:00以降になります。')));
    });

    test('detects collision when startMinute collides with preceding card', () => {
      const dayCards = [
        { cardId: 'c1', title: '午前の部', time: '09:00 - 11:00' },
        { cardId: 'c2', title: '午後の部', time: '11:30 - 13:00' }
      ];

      // Try setting c2 to start at 10:30 (before c1 ends at 11:00)
      const result = planCascadeTimeAdjustment(dayCards, 1, '10:30', 90, { dayKey: 'day1' });

      assert.ok(result.errors.some(e => e.includes('直前の「午前の部」(09:00 - 11:00)と開始時刻が重複しています')));
    });
  });

  describe('planCardMoveDay', () => {
    test('moves a card from day1 to day2', () => {
      const trip = {
        tripId: 'cross-day-trip',
        days: {
          day1: [
            { cardId: 'c1', title: 'Day1 Card 1', time: '09:00 - 10:00' },
            { cardId: 'c2', title: 'Moving Card', time: '10:30 - 11:30' }
          ],
          day2: [
            { cardId: 'c3', title: 'Day2 Card 1', time: '09:00 - 10:00' }
          ]
        }
      };

      const result = planCardMoveDay(trip, 'day1', 1, 'day2', 'end', {
        startTime: '10:30',
        durationMinutes: 60
      });

      assert.deepEqual(result.errors, []);
      assert.equal(result.updatedTrip.days.day1.length, 1);
      assert.equal(result.updatedTrip.days.day1[0].cardId, 'c1');
      assert.equal(result.updatedTrip.days.day2.length, 2);
      assert.equal(result.updatedTrip.days.day2[1].cardId, 'c2');
    });

    test('returns error for invalid dayKey or invalid fromIndex', () => {
      const trip = { tripId: 't1', days: { day1: [] } };
      assert.ok(planCardMoveDay(trip, '', 0, 'day2', 'end').errors[0].includes('指定されていません'));
      assert.ok(planCardMoveDay(trip, 'day1', 5, 'day2', 'end').errors[0].includes('移動元のカードが見つかりません'));
    });
  });

  describe('applyDayPlan & undoDayPlan snapshot cycle', () => {
    test('creates undo snapshot and restores trip correctly', () => {
      const trip = {
        tripId: 'undo-trip-1',
        days: {
          day1: [{ cardId: 'c1', title: 'Original Day1', time: '09:00 - 10:00' }]
        }
      };
      const planning = { schemaVersion: 3, candidates: [] };
      const planResult = planCascadeTimeAdjustment(trip.days.day1, 0, '09:30', 60, { dayKey: 'day1' });

      // Apply
      const applied = applyDayPlan({
        currentTrip: trip,
        currentPlanning: planning,
        planResult
      });

      assert.equal(applied.error, '');
      assert.equal(applied.trip.days.day1[0].time, '09:30 - 10:30');
      assert.ok(applied.undoSnapshot);
      assert.equal(applied.undoSnapshot.tripId, 'undo-trip-1');

      // Undo
      const undone = undoDayPlan({
        currentTrip: applied.trip,
        currentPlanning: applied.planning,
        undoSnapshot: applied.undoSnapshot
      });

      assert.equal(undone.error, '');
      assert.equal(undone.trip.days.day1[0].title, 'Original Day1');
      assert.equal(undone.trip.days.day1[0].time, '09:00 - 10:00');
    });

    test('prevents undo if tripId does not match snapshot', () => {
      const trip = { tripId: 'trip-b', days: { day1: [] } };
      const undoSnapshot = { tripId: 'trip-a', previousDays: { day1: [] } };

      const result = undoDayPlan({
        currentTrip: trip,
        currentPlanning: {},
        undoSnapshot
      });

      assert.ok(result.error.includes('別旅行の変更履歴のため取り消しできません'));
    });
  });

});
