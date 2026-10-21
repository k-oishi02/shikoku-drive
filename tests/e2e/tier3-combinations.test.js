import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTimeRange,
  formatMinute,
  migrateTripToV2,
  cleanPlanning,
  cleanCandidate,
  stripPlanningForPublication,
  validateTripDraft
} from '../../src/trip-v2-core.js';

import {
  analyzeTrip,
  settlementTransfers
} from '../../src/trip-v2-analysis.js';

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

import {
  shiftedTime,
  buildTimeline
} from '../../src/itinerary-calc.js';

describe('Tier 3: Cross-Feature Combinations', () => {

  describe('Combination 1: Spot Adoption -> Cascade Adjustment -> Settlement -> Export/Import Roundtrip', () => {
    it('executes full state pipeline from candidate spot to public export and backup re-import', () => {
      // Step 1: Base Trip & Planning setup
      const trip = {
        schemaVersion: 2,
        tripId: 'ibaraki-combo',
        title: '茨城周遊コンビネーション',
        startDate: '2026-11-07',
        endDate: '2026-11-07',
        members: [
          { id: 'm-kimura', name: '木村' },
          { id: 'm-sato', name: '佐藤' },
          { id: 'm-tanaka', name: '田中' }
        ],
        days: {
          day1: [
            { cardId: 'day1-01-dep', time: '08:00 - 08:30', title: '出発', badge: '移動', desc: '集合場所' },
            { cardId: 'day1-02-sight', time: '09:00 - 10:00', title: '海浜公園', badge: '見学', desc: 'コキア散策', travelMinutesFromPrevious: 30 },
            { cardId: 'day1-03-aquarium', time: '13:00 - 15:00', title: 'ナイト水族館', badge: '見学', desc: '予約必須', timeLocked: true, travelMinutesFromPrevious: 60 }
          ]
        }
      };

      const planning = {
        schemaVersion: 3,
        candidates: [
          {
            id: 'cand-cafe-01',
            title: '海カフェ',
            category: 'gourmet',
            priority: 'high',
            durationMinutes: 45,
            notes: '絶景テラス席をチェック'
          }
        ],
        notes: '旅程打ち合わせ用社内メモ'
      };

      // Step 2: Adopt candidate spot into Day 1 at position 2 (between Day1-02 and Day1-03)
      const adoptedCard = {
        cardId: 'day1-cand-cafe-01',
        time: '10:30 - 11:15',
        title: planning.candidates[0].title,
        badge: 'カフェ',
        desc: '海カフェで梅ソーダ休憩',
        travelMinutesFromPrevious: 30
      };
      trip.days.day1.splice(2, 0, adoptedCard);

      // Reconcile candidate assignments
      planning.candidates[0].assignedCardId = adoptedCard.cardId;
      planning.candidates[0].assignedDay = 'day1';
      const reconciled = reconcileAssignments(trip, planning);
      assert.equal(reconciled.candidates[0].status, 'assigned');
      assert.equal(reconciled.candidates[0].assignedDay, 'day1');

      // Step 3: User extends cafe duration from 45 min to 90 min (10:30 - 12:00)
      // Trigger cascade adjustment from targetIndex 2
      const cascadeResult = planCascadeTimeAdjustment(
        trip.days.day1,
        2,
        '10:30',
        90,
        { dayKey: 'day1' }
      );

      assert.equal(cascadeResult.errors.length, 0, 'No overflow errors');
      trip.days.day1 = cascadeResult.updatedCards;

      // Verify cafe card duration updated
      assert.equal(trip.days.day1[2].time, '10:30 - 12:00');

      // Verify downstream locked aquarium card (index 3) is HALTED and retains its locked reservation
      assert.equal(trip.days.day1[3].time, '13:00 - 15:00');
      assert.equal(trip.days.day1[3].timeLocked, true);

      // Verify travel gap check: 12:00 end to 13:00 start = 60 min gap == travelMinutesFromPrevious (60 min) -> No collision
      const aquariumRange = parseTimeRange(trip.days.day1[3].time);
      assert.equal(aquariumRange.start - 720, 60, 'Exactly 60 minutes travel buffer preserved');

      // Step 4: Record expense at the adopted cafe
      const expenses = [
        {
          id: 'exp-cafe',
          title: '海カフェ 梅ソーダ＆ケーキセット',
          amount: 4500,
          payer: 'm-kimura',
          splitMode: 'equal' // split across all 3 members (¥1,500 each)
        }
      ];

      const transfers = settlementTransfers(trip.members, expenses);
      assert.equal(transfers.length, 2);
      // Both Sato and Tanaka must pay Kimura ¥1,500
      const toKimura = transfers.filter(t => t.to === 'm-kimura');
      assert.equal(toKimura.length, 2);
      assert.equal(toKimura[0].amount, 1500);
      assert.equal(toKimura[1].amount, 1500);

      // Step 5: Export public participant JSON
      const publicExport = buildTripExport(trip);
      assert.equal(publicExport.tripId, 'ibaraki-combo');
      assert.equal(publicExport.days.day1.length, 4);
      // Verify public export does not leak planning or candidate notes
      assert.equal(publicExport.planning, undefined);
      assert.equal(publicExport.candidates, undefined);
      assert.equal(publicExport.planningJson, undefined);

      // Step 6: Create full administrative backup with planning notes
      const adminBackup = buildAdminBackup(trip, reconciled);
      assert.equal(adminBackup.format, 'shiori-admin-backup');
      assert.equal(adminBackup.planning.candidates[0].notes, '絶景テラス席をチェック');

      // Step 7: Re-import both payloads and verify roundtrip integrity
      const importedPublic = parseTripImport(JSON.stringify(publicExport));
      assert.equal(importedPublic.kind, 'participant');
      assert.equal(importedPublic.trip.days.day1[2].title, '海カフェ');

      const importedBackup = parseTripImport(JSON.stringify(adminBackup));
      assert.equal(importedBackup.kind, 'admin-backup');
      assert.equal(importedBackup.trip.days.day1.length, 4);
      assert.equal(importedBackup.planning.candidates.length, 1);
      assert.equal(importedBackup.planning.candidates[0].status, 'assigned');
    });
  });

  describe('Combination 2: Cross-Day Card Move + Travel Time Reset + Timeline Invariants', () => {
    it('moves a card across days, automatically resets predecessor travel times, and updates timeline', () => {
      const trip = {
        schemaVersion: 2,
        tripId: 'cross-day-combo',
        title: '2日旅',
        startDate: '2026-11-07',
        endDate: '2026-11-08',
        days: {
          day1: [
            { cardId: 'day1-01', time: '09:00 - 10:00', title: 'Day1 Spot 1' },
            { cardId: 'day1-02', time: '10:30 - 12:00', title: 'Movable Spot', travelMinutesFromPrevious: 30 }
          ],
          day2: [
            { cardId: 'day2-01', time: '10:00 - 11:30', title: 'Day2 Spot 1' },
            { cardId: 'day2-02', time: '12:00 - 13:00', title: 'Day2 Spot 2', travelMinutesFromPrevious: 30 }
          ]
        }
      };

      // Move Movable Spot from Day 1 index 1 to Day 2 index 0 (top of day 2)
      const movePlan = planCardMoveDay(trip, 'day1', 1, 'day2', 0);
      assert.equal(movePlan.errors.length, 0);

      const updatedTrip = movePlan.updatedTrip;
      assert.equal(updatedTrip.days.day1.length, 1);
      assert.equal(updatedTrip.days.day2.length, 3);
      assert.equal(updatedTrip.days.day2[0].cardId, 'day1-02');

      // In Day 2, top card must have its travelMinutesFromPrevious stripped
      assert.equal(updatedTrip.days.day2[0].travelMinutesFromPrevious, undefined);

      // Verify timeline calculation on both days
      const tlDay1 = buildTimeline(updatedTrip, {}, 'day1');
      assert.equal(tlDay1.timeline.length, 1);

      const tlDay2 = buildTimeline(updatedTrip, {}, 'day2');
      assert.equal(tlDay2.timeline.length, 3);
    });
  });

  describe('Combination 3: Candidate Shelf Adoption and Unadoption Lifecycle', () => {
    it('transitions candidate through draft -> assigned -> draft without orphan references', () => {
      const trip = {
        schemaVersion: 2,
        tripId: 'cand-lifecycle',
        title: '候補ライフサイクル',
        startDate: '2026-11-07',
        endDate: '2026-11-07',
        days: {
          day1: [
            { cardId: 'card-fixed-1', time: '09:00 - 10:00', title: '常設スポット' }
          ]
        }
      };

      const planning = {
        schemaVersion: 3,
        candidates: [
          {
            id: 'cand-museum',
            title: '近代美術館',
            category: 'sightseeing',
            priority: 'normal',
            durationMinutes: 60,
            status: 'draft'
          }
        ],
        notes: ''
      };

      // 1. Initial State
      assert.equal(planning.candidates[0].status, 'draft');

      // 2. Adopt candidate to Day 1
      const newCardId = 'day1-cand-museum';
      trip.days.day1.push({
        cardId: newCardId,
        time: '10:30 - 11:30',
        title: '近代美術館',
        badge: '見学',
        desc: '美術展'
      });
      planning.candidates[0].assignedCardId = newCardId;
      planning.candidates[0].assignedDay = 'day1';

      let reconciled = reconcileAssignments(trip, planning);
      assert.equal(reconciled.candidates[0].status, 'assigned');
      assert.equal(reconciled.candidates[0].assignedDay, 'day1');

      // Inspect assignment
      const inspect = inspectAssignment(trip, reconciled, 'cand-museum');
      assert.equal(inspect.error, '');
      assert.equal(inspect.dayKey, 'day1');
      assert.equal(inspect.card.cardId, newCardId);

      // 3. User deletes the card from Day 1 schedule (unadopt)
      trip.days.day1 = trip.days.day1.filter(c => c.cardId !== newCardId);

      // Reconcile again: candidate should automatically revert to 'draft'
      reconciled = reconcileAssignments(trip, reconciled);
      assert.equal(reconciled.candidates[0].status, 'draft');
      assert.equal(reconciled.candidates[0].assignedCardId, undefined);
      assert.equal(reconciled.candidates[0].assignedDay, undefined);

      // Verification after unadoption
      const inspectAfter = inspectAssignment(trip, reconciled, 'cand-museum');
      assert.ok(inspectAfter.error, 'Inspect should report error when not assigned');
    });
  });

  describe('Combination 4: Complex Multi-Payer Split-Bill with Mixed Modes', () => {
    it('resolves multi-payer, multi-subgroup expenses into minimal net transfers with 0 residual', () => {
      const members = [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'charlie', name: 'Charlie' },
        { id: 'david', name: 'David' }
      ];

      const expenses = [
        // 1. Alice pays ¥20,000 for everyone (¥5,000 each)
        { payer: 'alice', amount: 20000, splitMode: 'equal' },
        // 2. Bob pays ¥6,000 for Alice and Bob only (¥3,000 each)
        { payer: 'bob', amount: 6000, splitMode: 'selected', participantIds: ['alice', 'bob'] },
        // 3. Charlie pays ¥4,000 for Bob, Charlie, David (¥1,333.33... each)
        { payer: 'charlie', amount: 4000, splitMode: 'selected', participantIds: ['bob', 'charlie', 'david'] },
        // 4. David pays ¥2,000 for Alice only
        { payer: 'david', amount: 2000, splitMode: 'selected', participantIds: ['alice'] }
      ];

      // Net Balances calculated by hand:
      // Alice:   +20000 (paid) - 5000 (exp1) - 3000 (exp2) - 2000 (exp4) = +10,000
      // Bob:     +6000 (paid)  - 5000 (exp1) - 3000 (exp2) - 1333.33 (exp3) = -3,333.33
      // Charlie: +4000 (paid)  - 5000 (exp1) - 1333.33 (exp3) = -2,333.33
      // David:   +2000 (paid)  - 5000 (exp1) - 1333.33 (exp3) = -4,333.33
      // Total Debts = 3333.33 + 2333.33 + 4333.33 = 10,000 == Total Credit (+10,000)

      const transfers = settlementTransfers(members, expenses);

      // All transfers must go to Alice (she is the only net creditor)
      assert.ok(transfers.every(t => t.to === 'alice'));
      // Exactly 3 debtors: Bob, Charlie, David
      assert.equal(transfers.length, 3);

      const totalTransferAmount = transfers.reduce((sum, t) => sum + t.amount, 0);
      assert.ok(Math.abs(totalTransferAmount - 10000) <= 1, 'Sum of all transfers must equal 10,000 within 1-yen integer rounding');
    });
  });

});
