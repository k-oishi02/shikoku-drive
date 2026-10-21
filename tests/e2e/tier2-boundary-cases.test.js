import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTimeRange,
  formatMinute,
  migrateTripToV2,
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
  cleanTravelTimesOnReorder
} from '../../src/admin-day-planner.js';

import {
  isGoogleMapsUrl,
  validateMapFields
} from '../../src/map-links.js';

describe('Tier 2: Boundary Value Analysis & Edge Cases', () => {

  describe('1. Empty / Minimal Trips', () => {
    it('migrateTripToV2 handles empty object and assigns defaults', () => {
      const migrated = migrateTripToV2({}, 'empty-trip');
      assert.equal(migrated.schemaVersion, 2);
      assert.equal(migrated.tripId, 'empty-trip');
      assert.deepEqual(migrated.days, { day1: [] });
      assert.deepEqual(migrated.checklist, []);
      assert.equal(migrated.title, '旅行しおり');
    });

    it('settlementTransfers with 0 expenses or 0 members returns empty transfers', () => {
      assert.deepEqual(settlementTransfers([], []), []);
      assert.deepEqual(settlementTransfers([{ id: 'm1', name: '木村' }], []), []);
      assert.deepEqual(settlementTransfers([], [{ payer: 'm1', amount: 5000 }]), []);
    });

    it('cleanTravelTimesOnReorder handles empty before/after lists gracefully', () => {
      assert.doesNotThrow(() => cleanTravelTimesOnReorder([], []));
      assert.doesNotThrow(() => cleanTravelTimesOnReorder(null, null));
    });

    it('validateTripInput rejects completely empty trip without tripId and title', () => {
      const errors = validateTripInput({});
      assert.ok(errors.length > 0);
      assert.ok(errors.some(e => e.includes('tripId') || e.includes('旅行ID')));
      assert.ok(errors.some(e => e.includes('タイトル')));
    });
  });

  describe('2. Midnight Boundaries & Overnight Prevention', () => {
    it('parseTimeRange: 23:59 (1439 min) is valid day end', () => {
      const res = parseTimeRange('23:00 - 23:59');
      assert.deepEqual(res, { start: 1380, end: 1439 });
    });

    it('parseTimeRange: 24:00 is rejected (hours must be <= 23)', () => {
      assert.equal(parseTimeRange('23:00 - 24:00'), null);
      assert.equal(parseTimeRange('24:00 - 25:00'), null);
    });

    it('parseTimeRange: 00:00 is valid midnight start', () => {
      const res = parseTimeRange('00:00 - 00:30');
      assert.deepEqual(res, { start: 0, end: 30 });
    });

    it('parseTimeRange: reversed time range (end <= start) is rejected', () => {
      assert.equal(parseTimeRange('12:00 - 12:00'), null);
      assert.equal(parseTimeRange('14:30 - 13:00'), null);
    });

    it('formatMinute handles exactly 0, 1439, and rolls over at 1440', () => {
      assert.equal(formatMinute(0), '00:00');
      assert.equal(formatMinute(1439), '23:59');
      assert.equal(formatMinute(1440), '00:00');
      assert.equal(formatMinute(-1), '23:59');
    });

    it('planCascadeTimeAdjustment rejects schedule extending into or beyond 24:00', () => {
      const cards = [
        { cardId: 'c-night-1', title: 'Night Spot', time: '23:00 - 23:30' }
      ];
      // Target start 23:30 with 60 min duration -> end 24:30 (1470 min)
      const res = planCascadeTimeAdjustment(cards, 0, '23:30', 60, { dayKey: 'day1' });
      assert.ok(res.errors.length > 0);
      assert.ok(res.errors.some(e => e.includes('24:00') || e.includes('日跨ぎ')));
    });

    it('planCascadeTimeAdjustment downstream card pushing past 24:00 triggers error', () => {
      const cards = [
        { cardId: 'c-night-1', title: 'Late Dinner', time: '22:00 - 23:00' },
        { cardId: 'c-night-2', title: 'Bar Tour', time: '23:15 - 23:45', travelMinutesFromPrevious: 15 }
      ];
      // Push Card 1 to end at 23:30 -> Card 2 starts at 23:45, duration 30 min -> 24:15!
      const res = planCascadeTimeAdjustment(cards, 0, '22:00', 90, { dayKey: 'day1' });
      assert.ok(res.errors.length > 0);
      assert.ok(res.errors.some(e => e.includes('24:00以降')));
    });
  });

  describe('3. Locked Cards (timeLocked: true) Boundary Halting', () => {
    it('cascade adjustment shifts unlocked cards but strictly halts at timeLocked card', () => {
      const cards = [
        { cardId: 'card-001', title: 'Morning Walk', time: '09:00 - 10:00' },
        { cardId: 'card-002', title: 'Cafe Break', time: '10:15 - 11:00', travelMinutesFromPrevious: 15 },
        { cardId: 'card-003', title: 'Reserved Train', time: '13:00 - 14:00', timeLocked: true, travelMinutesFromPrevious: 30 },
        { cardId: 'card-004', title: 'Hotel Checkin', time: '14:30 - 15:00', travelMinutesFromPrevious: 30 }
      ];

      // Delay Card 1 by 30 min (09:30 - 10:30)
      const res = planCascadeTimeAdjustment(cards, 0, '09:30', 60, { dayKey: 'day1' });
      assert.equal(res.errors.length, 0);

      // Card 2 must be shifted: starts 10:30 + 15 = 10:45, duration 45m -> 11:30
      assert.equal(res.updatedCards[1].time, '10:45 - 11:30');

      // Card 3 is locked -> MUST NOT be shifted (stays 13:00 - 14:00)
      assert.equal(res.updatedCards[2].time, '13:00 - 14:00');

      // Card 4 is after locked card -> MUST NOT be shifted by cascade
      assert.equal(res.updatedCards[3].time, '14:30 - 15:00');

      // Warning should document that cascade halted at locked card
      assert.ok(res.warnings.some(w => w.includes('固定予定') && w.includes('停止')));
    });

    it('cascade detects collision when shifted predecessor encroaches into locked card', () => {
      const cards = [
        { cardId: 'card-001', title: 'Sightseeing', time: '11:00 - 12:00' },
        { cardId: 'card-002', title: 'Reserved Flight', time: '13:00 - 14:30', timeLocked: true }
      ];

      // Expand Card 1 to 150 minutes (11:00 - 13:30), overlapping locked flight at 13:00
      const res = planCascadeTimeAdjustment(cards, 0, '11:00', 150, { dayKey: 'day1' });
      assert.ok(res.errors.length > 0);
      assert.ok(res.errors.some(e => e.includes('固定予定') && e.includes('衝突')));
      assert.equal(res.updatedCards[1].time, '13:00 - 14:30', 'Locked card time must remain unaltered');
    });
  });

  describe('4. Odd Yen Splits & Conservation of Money', () => {
    it('10,000 yen split across 3 members produces exact integer transfers', () => {
      const members = [
        { id: 'm1', name: '木村' },
        { id: 'm2', name: '佐藤' },
        { id: 'm3', name: '田中' }
      ];
      const expenses = [
        { payer: 'm1', amount: 10000, splitMode: 'equal' }
      ];

      const transfers = settlementTransfers(members, expenses);
      // Member 1 paid 10,000, individual share is 3,333.33...
      // Net balances: m1 = +6666.66..., m2 = -3333.33..., m3 = -3333.33...
      // Transfers: m2 -> m1 (3,333), m3 -> m1 (3,333)
      assert.equal(transfers.length, 2);
      assert.ok(transfers.every(t => t.to === 'm1'));
      assert.ok(transfers.every(t => Number.isInteger(t.amount)));

      const totalTransferred = transfers.reduce((acc, t) => acc + t.amount, 0);
      // Sum of transfers is 6,666 (or 6,667), within 1 yen of 6,666.66...
      assert.ok(Math.abs(totalTransferred - 6667) <= 1);
    });

    it('conservation of money: sum of credits strictly equals sum of debits', () => {
      const members = [
        { id: 'm1', name: 'A' },
        { id: 'm2', name: 'B' },
        { id: 'm3', name: 'C' },
        { id: 'm4', name: 'D' }
      ];
      const expenses = [
        { payer: 'm1', amount: 7777, splitMode: 'equal' },
        { payer: 'm2', amount: 3333, splitMode: 'selected', participantIds: ['m2', 'm3', 'm4'] },
        { payer: 'm3', amount: 1250, splitMode: 'selected', participantIds: ['m1', 'm3'] }
      ];

      const transfers = settlementTransfers(members, expenses);
      assert.ok(transfers.length > 0);
      transfers.forEach(t => {
        assert.ok(t.amount > 0);
        assert.notEqual(t.from, t.to);
      });
    });

    it('payer paying for self only produces 0 transfers', () => {
      const members = [
        { id: 'm1', name: '木村' },
        { id: 'm2', name: '佐藤' }
      ];
      const expenses = [
        { payer: 'm1', amount: 5000, splitMode: 'selected', participantIds: ['m1'] }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.deepEqual(transfers, []);
    });

    it('zero-yen or negative expenses are safely ignored without corruption', () => {
      const members = [{ id: 'm1' }, { id: 'm2' }];
      const expenses = [
        { payer: 'm1', amount: 0 },
        { payer: 'm1', amount: -500 },
        { payer: 'm1', amount: NaN }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.deepEqual(transfers, []);
    });
  });

  describe('5. Max Payload Size Boundary (900KB)', () => {
    it('payload under 900,000 bytes passes validation', () => {
      // 890,000 bytes
      const padding = 'a'.repeat(889900);
      const input = {
        payloadJson: JSON.stringify({ note: padding }),
        planningJson: '{}'
      };
      const errors = validateStoredDraftSize(input);
      assert.deepEqual(errors, []);
    });

    it('payload exceeding 900,000 bytes is strictly rejected', () => {
      // Create string that pushes JSON total byte count over 900,000
      const hugePadding = 'z'.repeat(900050);
      const input = {
        payloadJson: JSON.stringify({ data: hugePadding }),
        planningJson: '{}'
      };
      const errors = validateStoredDraftSize(input);
      assert.ok(errors.length > 0);
      assert.ok(errors.some(e => e.includes('900,000バイト') || e.includes('安全上限')));
    });
  });

  describe('6. Input Constraints & String Boundaries', () => {
    it('tripId boundaries: 3 chars valid, 2 chars invalid, 40 chars valid, 41 invalid', () => {
      // 2 chars -> error
      const shortTrip = { schemaVersion: 2, tripId: 'ab', title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      assert.ok(validateTripInput(shortTrip).some(e => e.includes('tripId') || e.includes('旅行ID')));

      // 3 chars -> valid
      const minTrip = { schemaVersion: 2, tripId: 'abc', title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      const minErrors = validateTripInput(minTrip).filter(e => e.includes('tripId'));
      assert.deepEqual(minErrors, []);

      // 40 chars -> valid
      const id40 = 'a'.repeat(40);
      const trip40 = { schemaVersion: 2, tripId: id40, title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      const errors40 = validateTripInput(trip40).filter(e => e.includes('tripId'));
      assert.deepEqual(errors40, []);

      // 41 chars -> error
      const id41 = 'a'.repeat(41);
      const trip41 = { schemaVersion: 2, tripId: id41, title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      assert.ok(validateTripInput(trip41).some(e => e.includes('tripId') || e.includes('旅行ID')));
    });

    it('tripId with uppercase or disallowed symbols is rejected', () => {
      const upperTrip = { schemaVersion: 2, tripId: 'Trip_2026', title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      assert.ok(validateTripInput(upperTrip).some(e => e.includes('tripId') || e.includes('旅行ID')));

      const spaceTrip = { schemaVersion: 2, tripId: 'trip 2026', title: 'テスト', startDate: '2026-11-01', endDate: '2026-11-01', days: { day1: [] } };
      assert.ok(validateTripInput(spaceTrip).some(e => e.includes('tripId') || e.includes('旅行ID')));
    });

    it('rejects dangerous URL schemes in map fields and candidate fields', () => {
      assert.equal(isGoogleMapsUrl('javascript:alert(1)'), false);
      assert.equal(isGoogleMapsUrl('data:text/html;base64,PHNjcmlwdD4='), false);
      assert.equal(isGoogleMapsUrl('file:///etc/passwd'), false);

      const candidateBadUrl = {
        title: '危険な候補',
        category: 'gourmet',
        priority: 'normal',
        durationMinutes: 30,
        official: 'javascript:alert(1)'
      };
      const errors = validateCandidateInput(candidateBadUrl);
      assert.ok(errors.some(e => e.includes('HTTPS URL')));
    });
  });

});
