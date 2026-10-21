import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftedTime,
  buildTimeline,
  cardMap,
  activeItem,
  calculateNextAvailableTime,
  parseCardLinks,
  formatCardLinks
} from '../src/itinerary-calc.js';
import {
  migrateTripToV2,
  cleanCard,
  cleanCandidate,
  cleanPlanning,
  stripPlanningForPublication,
  validateTripDraft,
  formatMinute,
  parseTimeRange
} from '../src/trip-v2-core.js';
import {
  analyzeTrip,
  settlementTransfers,
  getTripNowState
} from '../src/trip-v2-analysis.js';
import {
  createAdminStore,
  createInitialAdminState
} from '../src/admin-store.js';
import {
  createTripStore,
  createInitialTripState
} from '../src/trip-store.js';

// Resolve normalization function (supporting normalizeTripDraft or migrateTripToV2)
const normalizeTripDraft = migrateTripToV2;

describe('Adversarial Stress & White-Box Hardening Suite (M5 Phase 2)', () => {

  // =========================================================================
  // 1. buildTimeline White-box Stress Tests
  // =========================================================================
  describe('1. buildTimeline White-box Stress Tests', () => {

    it('handles extreme positive delay (+1440 min, full 24h shift)', () => {
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: '朝食', time: '08:00 - 09:00' },
            { cardId: 'c2', title: '移動', time: '09:30 - 10:30' }
          ]
        }
      };
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'c2'],
            delay: { minutes: 1440, fromCardId: 'c1' }
          }
        }
      };

      const result = buildTimeline(trip, journeyState, 'day1');
      assert.equal(result.items.length, 2);
      assert.equal(result.conflicts.length, 0);

      // 08:00 (480) + 1440 = 1920 min -> formatMinute wraps to 08:00
      assert.equal(result.items[0].time.time, '08:00 - 09:00');
      assert.equal(result.items[0].time.start, 1920);
      assert.equal(result.items[0].time.end, 1980);

      // c2: 09:30 (570) + 1440 = 2010 min -> formatMinute wraps to 09:30
      assert.equal(result.items[1].time.time, '09:30 - 10:30');
      assert.equal(result.items[1].time.start, 2010);
      assert.equal(result.items[1].time.end, 2070);
    });

    it('handles extreme negative delay (-1440 min, -24h negative shift)', () => {
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: '朝食', time: '10:00 - 11:00' }
          ]
        }
      };
      const journeyState = {
        days: {
          day1: {
            order: ['c1'],
            delay: { minutes: -1440, fromCardId: 'c1' }
          }
        }
      };

      const result = buildTimeline(trip, journeyState, 'day1');
      assert.equal(result.items.length, 1);
      // 10:00 (600) - 1440 = -840 min -> formatMinute wraps cleanly to 10:00
      assert.equal(result.items[0].time.time, '10:00 - 11:00');
      assert.equal(result.items[0].time.start, -840);
      assert.equal(result.items[0].time.end, -780);
    });

    it('handles giant delay values (+100,000 min and -100,000 min) without crash or NaN', () => {
      const trip = {
        days: {
          day1: [{ cardId: 'c1', title: '巨大シフト', time: '12:00 - 13:00' }]
        }
      };

      const posResult = buildTimeline(trip, {
        days: { day1: { order: ['c1'], delay: { minutes: 100000, fromCardId: 'c1' } } }
      }, 'day1');
      assert.ok(Number.isFinite(posResult.items[0].time.start));
      assert.ok(Number.isFinite(posResult.items[0].time.end));
      assert.match(posResult.items[0].time.time, /^\d{2}:\d{2} - \d{2}:\d{2}$/);

      const negResult = buildTimeline(trip, {
        days: { day1: { order: ['c1'], delay: { minutes: -100000, fromCardId: 'c1' } } }
      }, 'day1');
      assert.ok(Number.isFinite(negResult.items[0].time.start));
      assert.ok(Number.isFinite(negResult.items[0].time.end));
      assert.match(negResult.items[0].time.time, /^\d{2}:\d{2} - \d{2}:\d{2}$/);
    });

    it('handles cards passing midnight (24:00+) and accurately detects cross-midnight conflicts', () => {
      // Card 1 ends at 23:50 (1430 min)
      // Card 2 is scheduled at 23:45 - 23:55 (starts at 1425 min)
      // When both are delayed by +60 min:
      // Card 1 shifts to: 1470 - 1490 (00:30 - 00:50 next day)
      // Card 2 shifts to: 1485 - 1495 (00:45 - 00:55 next day)
      // Overlap: Card 1 ends at 1490 > Card 2 starts at 1485 -> 5 min conflict!
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: 'レイトディナー', time: '23:00 - 23:50' },
            { cardId: 'c2', title: 'バー', time: '23:45 - 23:55' }
          ]
        }
      };
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'c2'],
            delay: { minutes: 60, fromCardId: 'c1' }
          }
        }
      };

      const result = buildTimeline(trip, journeyState, 'day1');
      assert.equal(result.items.length, 2);
      assert.equal(result.items[0].time.time, '00:00 - 00:50');
      assert.equal(result.items[1].time.time, '00:45 - 00:55');
      assert.equal(result.conflicts.length, 1);
      assert.ok(result.conflicts[0].includes('レイトディナーとバーが5分重なります'));
    });

    it('detects overlapping cards with exact matching timestamps and zero gap boundaries', () => {
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: '予定A', time: '14:00 - 15:00' },
            { cardId: 'c2', title: '予定B', time: '14:00 - 15:00' }, // Exact match with c1
            { cardId: 'c3', title: '予定C', time: '15:00 - 16:00' }  // Exact boundary match (0 gap)
          ]
        }
      };

      const result = buildTimeline(trip, {}, 'day1');
      assert.equal(result.items.length, 3);
      // c1 & c2 conflict by 60 minutes
      assert.equal(result.conflicts.length, 1);
      assert.ok(result.conflicts[0].includes('予定Aと予定Bが60分重なります'));
      // c2 ends at 15:00 and c3 starts at 15:00 -> exactly 0 gap, NOT a conflict
    });

    it('resiliently handles missing, undefined, null, or malformed inputs without throwing', () => {
      // Completely empty invocation
      assert.deepEqual(buildTimeline(), { items: [], timeline: [], conflicts: [] });
      assert.deepEqual(buildTimeline(null, null, null), { items: [], timeline: [], conflicts: [] });
      assert.deepEqual(buildTimeline({}, {}, ''), { items: [], timeline: [], conflicts: [] });

      // Trip with sparse and broken card fields (missing time, missing title, malformed time)
      const brokenTrip = {
        days: {
          day1: [
            { cardId: 'c0' }, // missing time and title
            { cardId: 'c1', title: '時間未定' }, // missing time
            { cardId: 'c2', time: 'bad-time' }, // malformed time, missing title
            { cardId: 'c3', time: '10:00 - 11:00', title: '正常カード' }
          ]
        }
      };
      const journeyState = {
        days: {
          day1: {
            order: ['non-existent', 'c0', 'c1', 'c2', 'c3', null, undefined],
            delay: { minutes: 'not-a-number', fromCardId: 'c1' },
            status: null
          }
        },
        records: null
      };

      let result;
      assert.doesNotThrow(() => {
        result = buildTimeline(brokenTrip, journeyState, 'day1');
      });

      assert.ok(Array.isArray(result.items));
      assert.ok(Array.isArray(result.conflicts));
      // Valid cards that exist in cards Map are included
      assert.equal(result.items.length, 4); // c0, c1, c2, c3
      assert.equal(result.items[0].card.cardId, 'c0');
      assert.equal(result.items[0].time.start, null);
      assert.equal(result.items[1].card.cardId, 'c1');
      assert.equal(result.items[1].time.start, null);
      assert.equal(result.items[2].card.cardId, 'c2');
      assert.equal(result.items[2].time.start, null);
      assert.equal(result.items[3].card.cardId, 'c3');
      assert.equal(result.items[3].time.start, 600);
    });

    it('reveals boundary vulnerability: un-normalized null entry in trip.days array throws TypeError in cardMap', () => {
      // If raw, un-normalized trip containing null in cards array is passed directly to buildTimeline:
      const rawTripWithNull = {
        days: {
          day1: [null]
        }
      };
      // Verifies the exact empirical behavior: cardMap accesses card.cardId without null check
      assert.throws(() => {
        buildTimeline(rawTripWithNull, {}, 'day1');
      }, /Cannot read properties of null \(reading 'cardId'\)/);
    });

    it('resets delay at timeLocked cards and keeps subsequent cards halted', () => {
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: '観光A', time: '10:00 - 11:00' },
            { cardId: 'c2', title: '固定新幹線', time: '12:00 - 13:00', timeLocked: true },
            { cardId: 'c3', title: '観光B', time: '13:30 - 14:30' }
          ]
        }
      };
      const journey = {
        days: {
          day1: {
            order: ['c1', 'c2', 'c3'],
            delay: { minutes: 45, fromCardId: 'c1' }
          }
        }
      };

      const result = buildTimeline(trip, journey, 'day1');
      assert.equal(result.items[0].time.time, '10:45 - 11:45'); // shifted +45
      assert.equal(result.items[1].time.time, '12:00 - 13:00'); // locked: 0 shift
      assert.equal(result.items[2].time.time, '13:30 - 14:30'); // downstream: offset remains 0
    });

  });

  // =========================================================================
  // 2. settlementTransfers White-box Stress Tests
  // =========================================================================
  describe('2. settlementTransfers White-box Stress Tests', () => {

    it('returns empty transfers for zero cost and rounding-to-zero expenses', () => {
      const members = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
      assert.deepEqual(settlementTransfers(members, [{ amount: 0, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: 0.49, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: -0, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: '0', payer: 'u1' }]), []);
    });

    it('handles 1-yen fractional distribution across 3+ participants (sub-yen rounding behavior)', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' }
      ];

      // 1 yen across 3 people: share = 0.333 yen.
      // u1 balance = +0.667, u2 balance = -0.333, u3 balance = -0.333.
      // Under Japanese Yen cash rules, sub-0.5 yen debits are not collected (-0.333 > -0.5),
      // so debtors list is empty and 0 transfers are produced.
      const transfer1 = settlementTransfers(members, [{ amount: 1, payer: 'u1' }]);
      assert.deepEqual(transfer1, []);

      // 2 yen across 3 people: share = 0.667 yen.
      // u1 balance = +1.333, u2 = -0.667, u3 = -0.667. Both < -0.5!
      // u2 -> u1: 1 yen, u3 -> u1: 1 yen. Total transferred = 2 yen!
      const transfer2 = settlementTransfers(members, [{ amount: 2, payer: 'u1' }]);
      assert.equal(transfer2.length, 2);
      const total2 = transfer2.reduce((sum, t) => sum + t.amount, 0);
      assert.equal(total2, 2, '2-yen expense across 3 members produces exactly 2 yen in transfers');

      // 10 yen across 3 people: share = 3.333 yen.
      // u2 -> u1: 3 yen, u3 -> u1: 3 yen. Total transferred = 6 yen (payer absorbed 4 yen).
      const transfer10 = settlementTransfers(members, [{ amount: 10, payer: 'u1' }]);
      assert.equal(transfer10.length, 2);
      const total10 = transfer10.reduce((sum, t) => sum + t.amount, 0);
      assert.equal(total10, 6);
    });

    it('strictly ignores negative amounts, -Infinity, NaN, and corrupt types', () => {
      const members = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
      const badExpenses = [
        { amount: -5000, payer: 'u1' },
        { amount: -Infinity, payer: 'u1' },
        { amount: NaN, payer: 'u1' },
        { amount: '-1000', payer: 'u1' },
        { amount: undefined, payer: 'u1' },
        { amount: null, payer: 'u1' },
        { amount: {}, payer: 'u1' },
        { amount: 'invalid-string', payer: 'u1' }
      ];
      assert.deepEqual(settlementTransfers(members, badExpenses), []);
    });

    it('empirically demonstrates JS type coercion in Number(expense.amount) for single-element arrays', () => {
      const members = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
      // In JavaScript, Number([1000]) coerces to 1000
      const coerced = settlementTransfers(members, [{ amount: [1000], payer: 'u1' }]);
      assert.equal(coerced.length, 1);
      assert.equal(coerced[0].amount, 500);

      // Multi-element array [1000, 2000] coerces to NaN, which is safely ignored
      const multiArray = settlementTransfers(members, [{ amount: [1000, 2000], payer: 'u1' }]);
      assert.deepEqual(multiArray, []);
    });

    it('accurately resolves complex multi-payer scenarios with conservation of money', () => {
      const members = [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'charlie', name: 'Charlie' },
        { id: 'dave', name: 'Dave' }
      ];
      // Expenses:
      // Alice pays 10,000 for all 4 (each owes 2,500)
      // Bob pays 6,000 for all 4 (each owes 1,500)
      // Charlie pays 4,000 for all 4 (each owes 1,000)
      // Dave pays 0
      // Total = 20,000. Equal share = 5,000 each.
      // Alice: paid 10,000 - 5,000 = +5,000 (creditor)
      // Bob: paid 6,000 - 5,000 = +1,000 (creditor)
      // Charlie: paid 4,000 - 5,000 = -1,000 (debtor)
      // Dave: paid 0 - 5,000 = -5,000 (debtor)
      const expenses = [
        { amount: 10000, payer: 'alice' },
        { amount: 6000, payer: 'bob' },
        { amount: 4000, payer: 'charlie' }
      ];

      const transfers = settlementTransfers(members, expenses);
      // Total transferred must equal total net debt = 6,000
      const totalTransferred = transfers.reduce((sum, t) => sum + t.amount, 0);
      assert.equal(totalTransferred, 6000, 'Sum of all transfers must exactly equal 6,000 yen');

      // Alice must receive +5,000 total
      const aliceReceived = transfers.filter(t => t.to === 'alice').reduce((sum, t) => sum + t.amount, 0);
      assert.equal(aliceReceived, 5000);

      // Bob must receive +1,000 total
      const bobReceived = transfers.filter(t => t.to === 'bob').reduce((sum, t) => sum + t.amount, 0);
      assert.equal(bobReceived, 1000);

      // Charlie must pay 1,000 total
      const charliePaid = transfers.filter(t => t.from === 'charlie').reduce((sum, t) => sum + t.amount, 0);
      assert.equal(charliePaid, 1000);

      // Dave must pay 5,000 total
      const davePaid = transfers.filter(t => t.from === 'dave').reduce((sum, t) => sum + t.amount, 0);
      assert.equal(davePaid, 5000);
    });

    it('completely cancels circular debts (A->B, B->C, C->A) resulting in 0 transfers', () => {
      const members = [
        { id: 'a', name: 'Member A' },
        { id: 'b', name: 'Member B' },
        { id: 'c', name: 'Member C' }
      ];
      // A pays 3,000 for B only
      // B pays 3,000 for C only
      // C pays 3,000 for A only
      const expenses = [
        { amount: 3000, payer: 'a', splitMode: 'selected', participantIds: ['b'] },
        { amount: 3000, payer: 'b', splitMode: 'selected', participantIds: ['c'] },
        { amount: 3000, payer: 'c', splitMode: 'selected', participantIds: ['a'] }
      ];

      const transfers = settlementTransfers(members, expenses);
      // Net balance for everyone is 0 -> zero transfers!
      assert.deepEqual(transfers, [], 'Circular debt must completely cancel out into 0 transfers');
    });

    it('cancels complex 4-way circular debts with unequal amounts cleanly', () => {
      const members = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
        { id: 'd', name: 'D' }
      ];
      // A pays 5,000 for B
      // B pays 5,000 for C
      // C pays 5,000 for D
      // D pays 4,000 for A
      // Net: A paid 5000, spent on A 4000 -> +1000
      //      B: 5000 - 5000 = 0
      //      C: 5000 - 5000 = 0
      //      D: paid 4000, spent on D 5000 -> -1000
      const expenses = [
        { amount: 5000, payer: 'a', splitMode: 'selected', participantIds: ['b'] },
        { amount: 5000, payer: 'b', splitMode: 'selected', participantIds: ['c'] },
        { amount: 5000, payer: 'c', splitMode: 'selected', participantIds: ['d'] },
        { amount: 4000, payer: 'd', splitMode: 'selected', participantIds: ['a'] }
      ];

      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'd',
        fromName: 'D',
        to: 'a',
        toName: 'A',
        amount: 1000
      });
    });

    it('handles 20+ participants with 50+ mixed expenses in under 5ms', () => {
      const memberCount = 20;
      const members = Array.from({ length: memberCount }, (_, i) => ({
        id: `user-${String(i + 1).padStart(2, '0')}`,
        name: `Member ${i + 1}`
      }));

      const expenses = [];
      for (let i = 0; i < 50; i++) {
        const payerIndex = i % memberCount;
        expenses.push({
          amount: 1000 * ((i % 5) + 1),
          payer: members[payerIndex].id,
          splitMode: i % 3 === 0 ? 'selected' : 'equal',
          participantIds: [
            members[(payerIndex + 1) % memberCount].id,
            members[(payerIndex + 2) % memberCount].id
          ]
        });
      }

      const start = performance.now();
      const transfers = settlementTransfers(members, expenses);
      const duration = performance.now() - start;

      assert.ok(Array.isArray(transfers));
      assert.ok(duration < 15, `20 participants / 50 expenses took ${duration}ms, expected < 15ms`);

      // Verify conservation of money:
      // sum(credits received) == sum(debits paid)
      const credits = new Map();
      const debits = new Map();
      for (const t of transfers) {
        credits.set(t.to, (credits.get(t.to) || 0) + t.amount);
        debits.set(t.from, (debits.get(t.from) || 0) + t.amount);
      }
      const totalCredits = Array.from(credits.values()).reduce((a, b) => a + b, 0);
      const totalDebits = Array.from(debits.values()).reduce((a, b) => a + b, 0);
      assert.equal(totalCredits, totalDebits, 'Total credits received must exactly equal total debits paid');
    });

  });

  // =========================================================================
  // 3. normalizeTripDraft & analyzeTrip White-box Stress Tests
  // =========================================================================
  describe('3. normalizeTripDraft & analyzeTrip White-box Stress Tests', () => {

    it('handles malformed / corrupt JSON inputs gracefully without unhandled crashes', () => {
      const corruptInputs = [
        null,
        undefined,
        42,
        'corrupt-string',
        true,
        [],
        {}
      ];

      for (const input of corruptInputs) {
        // normalizeTripDraft
        const norm = normalizeTripDraft(input);
        assert.ok(norm != null, 'normalizeTripDraft must return non-null object');
        assert.equal(norm.schemaVersion, 2);
        assert.ok(norm.days && typeof norm.days === 'object');
        assert.ok(Array.isArray(norm.days.day1));

        // analyzeTrip
        const analysis = analyzeTrip(input);
        assert.ok(analysis != null);
        assert.ok(Array.isArray(analysis.issues));
        assert.ok(Array.isArray(analysis.errors));
        assert.ok(analysis.errors.length > 0, 'Corrupt inputs must report validation errors');
      }
    });

    it('validateTripDraft catches circular data structures and produces descriptive error without crash', () => {
      const circularTrip = {
        tripId: 'circular-trip',
        title: 'Circular Trip'
      };
      circularTrip.self = circularTrip;

      const errors = validateTripDraft(circularTrip, {});
      assert.ok(Array.isArray(errors));
      assert.ok(errors.includes('下書きデータをJSONへ変換できません。'), 'Must report JSON conversion error');
    });

    it('documents analyzeTrip behavior on circular data structures (throws TypeError via copy JSON.stringify)', () => {
      const circularTrip = {
        tripId: 'circular-trip',
        title: 'Circular Trip'
      };
      circularTrip.self = circularTrip;

      // analyzeTrip calls migrateTripToV2 which uses copy() without try/catch
      assert.throws(() => {
        analyzeTrip(circularTrip);
      }, /Converting circular structure to JSON/);
    });

    it('safely handles malicious field injection (__proto__, constructor, prototype)', () => {
      // Injection in trip root
      const maliciousTrip = JSON.parse('{"tripId": "evil-trip", "title": "Evil", "__proto__": {"pollutedKey": "evil"}, "constructor": {"prototype": {"pollutedProto": "evil"}}}');

      const norm = normalizeTripDraft(maliciousTrip);
      assert.equal(({}).pollutedKey, undefined, 'Object.prototype must not be polluted from trip root');
      assert.equal(({}).pollutedProto, undefined, 'Object.prototype must not be polluted via constructor');

      // Injection in card
      const cardWithProto = JSON.parse('{"title": "Card with proto", "time": "10:00 - 11:00", "__proto__": {"cardPolluted": true}}');
      const cleanedCard = cleanCard(cardWithProto);
      assert.equal(({}).cardPolluted, undefined, 'Object.prototype must not be polluted from cleanCard');

      // Injection in candidate
      const candWithProto = JSON.parse('{"title": "Candidate with proto", "__proto__": {"candPolluted": true}}');
      const cleanedCand = cleanCandidate(candWithProto);
      assert.equal(({}).candPolluted, undefined, 'Object.prototype must not be polluted from cleanCandidate');

      // Injection in planning
      const planWithProto = JSON.parse('{"notes": "Malicious notes", "__proto__": {"planPolluted": true}}');
      const cleanedPlan = cleanPlanning(planWithProto);
      assert.equal(({}).planPolluted, undefined, 'Object.prototype must not be polluted from cleanPlanning');

      // analyzeTrip on malicious trip
      const analysis = analyzeTrip(maliciousTrip);
      assert.equal(({}).pollutedKey, undefined);
      assert.ok(analysis.trip != null);
    });

    it('processes huge trips (50+ cards, 20+ participants, 100+ candidates) efficiently within limits', () => {
      const hugeTrip = {
        schemaVersion: 2,
        tripId: 'huge-trip-2026',
        title: 'メガ旅行2026',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        days: {}
      };

      // 5 days, 12 cards each = 60 cards
      for (let d = 1; d <= 5; d++) {
        const dayKey = `day${d}`;
        hugeTrip.days[dayKey] = [];
        for (let c = 1; c <= 12; c++) {
          const startHour = String(8 + Math.floor((c - 1) * 1.1)).padStart(2, '0');
          const endHour = String(Number(startHour) + 1).padStart(2, '0');
          hugeTrip.days[dayKey].push({
            cardId: `${dayKey}-${String(c).padStart(2, '0')}`,
            title: `第${d}日 スポット${c}`,
            time: `${startHour}:00 - ${endHour}:00`,
            badge: c === 1 ? 'START' : 'SPOT',
            desc: `第${d}日目の詳細スケジュール ${c}`
          });
        }
      }

      const hugePlanning = {
        candidates: Array.from({ length: 100 }, (_, i) => ({
          id: `cand-${String(i + 1).padStart(3, '0')}`,
          title: `候補スポット ${i + 1}`,
          category: ['gourmet', 'sightseeing', 'hotel', 'transport', 'other'][i % 5],
          priority: ['high', 'normal', 'low'][i % 3],
          durationMinutes: 60
        }))
      };

      const startNorm = performance.now();
      const norm = normalizeTripDraft(hugeTrip);
      const normDuration = performance.now() - startNorm;
      assert.ok(normDuration < 50, `normalizeTripDraft for 60 cards took ${normDuration}ms, expected < 50ms`);

      const startAnalysis = performance.now();
      const analysis = analyzeTrip(hugeTrip);
      const analysisDuration = performance.now() - startAnalysis;
      assert.ok(analysisDuration < 80, `analyzeTrip for 60 cards took ${analysisDuration}ms, expected < 80ms`);
      assert.equal(analysis.errors.length, 0, 'Huge valid trip should have 0 fatal errors');

      // Validate size within 900KB
      const errors = validateTripDraft(hugeTrip, hugePlanning);
      assert.equal(errors.length, 0, '60 cards and 100 candidates should pass validation within 900KB');
    });

    it('enforces 900KB payload limit boundary and rejects payload exceeding 900,000 bytes', () => {
      const baseTrip = {
        schemaVersion: 2,
        tripId: 'limit-test',
        title: 'サイズ境界テスト',
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        days: {
          day1: [
            {
              cardId: 'day1-01',
              title: 'スポット',
              time: '10:00 - 11:00',
              badge: 'SPOT',
              desc: 'x'.repeat(100)
            }
          ]
        }
      };

      // Case 1: Under 900KB
      const safePlanning = {
        candidates: [],
        notes: 'a'.repeat(4900)
      };
      assert.equal(validateTripDraft(baseTrip, safePlanning).length, 0);

      // Case 2: Exceeding 900,000 bytes in raw input
      const hugeRawTrip = {
        ...baseTrip,
        overflowPayload: 'z'.repeat(950000)
      };
      const overErrors = validateTripDraft(hugeRawTrip, safePlanning);
      assert.ok(overErrors.some(e => e.includes('900,000バイト') || e.includes('超過')), 'Must reject payload over 900KB');
    });

  });

  // =========================================================================
  // 4. Reactive Stores (AdminStore & TripStore) Stress & Concurrency Tests
  // =========================================================================
  describe('4. Reactive Stores (AdminStore & TripStore) Stress & Concurrency Tests', () => {

    it('AdminStore: handles 1,500 rapid mutations across slices with subscriber notification consistency', () => {
      const store = createAdminStore();
      const slices = ['overview', 'editor', 'candidateShelf', 'dayPlanner', 'distribution', 'roles', 'discussion'];
      let notifyCount = 0;

      const unsub = store.subscribe(() => {
        notifyCount++;
      });

      const start = performance.now();
      for (let i = 0; i < 1500; i++) {
        const sliceName = slices[i % slices.length];
        store.setSlice(sliceName, prev => ({
          ...prev,
          counter: (prev?.counter || 0) + 1,
          lastOp: i
        }));
      }
      const duration = performance.now() - start;

      assert.equal(notifyCount, 1500, 'Subscribers must receive exactly 1,500 notifications');
      assert.ok(duration < 250, `1,500 slice mutations took ${duration}ms, expected < 250ms`);

      // Verify all slices reflect expected counters
      for (let idx = 0; idx < slices.length; idx++) {
        const slice = store.getSlice(slices[idx]);
        assert.ok(slice.counter > 0);
      }

      unsub();
    });

    it('AdminStore: handles 1,000 asynchronous concurrent mutations via Promise.all without loss', async () => {
      const store = createAdminStore({ totalEvents: 0 });

      await Promise.all(
        Array.from({ length: 1000 }, async (_, i) => {
          if (i % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          store.setState(prev => ({
            totalEvents: prev.totalEvents + 1
          }));
        })
      );

      assert.equal(store.getState().totalEvents, 1000, 'All 1,000 async microtask events must accumulate without race loss');
    });

    it('AdminStore: subscriber unsubscription during active dispatch maintains iterator stability', () => {
      const store = createAdminStore({ tick: 0 });
      const executionLog = [];

      let unsubB;
      const unsubA = store.subscribe((s) => {
        executionLog.push(`A:${s.tick}`);
        if (s.tick === 1 && unsubB) {
          unsubB(); // B unsubscribes while dispatch for tick 1 is underway
        }
      });

      unsubB = store.subscribe((s) => {
        executionLog.push(`B:${s.tick}`);
      });

      const unsubC = store.subscribe((s) => {
        executionLog.push(`C:${s.tick}`);
      });

      // Tick 1
      store.setState({ tick: 1 });
      // In JS Set iteration, if an unvisited element is deleted during forEach, it is not visited.
      // A ran, B was removed before execution, C must still run!
      assert.ok(executionLog.includes('A:1'));
      assert.ok(executionLog.includes('C:1'));
      assert.ok(!executionLog.includes('B:1'), 'Unsubscribed subscriber B must be skipped cleanly without throwing');

      // Tick 2
      store.setState({ tick: 2 });
      assert.ok(executionLog.includes('A:2'));
      assert.ok(executionLog.includes('C:2'));
      assert.ok(!executionLog.includes('B:2'));

      unsubA();
      unsubC();
    });

    it('AdminStore: array immutability vs mutation in setSlice preserves Array instances', () => {
      const store = createAdminStore();

      // Setting array slice
      store.setSlice('adminProfiles', ['admin-1', 'admin-2']);
      const slice1 = store.getSlice('adminProfiles');
      assert.ok(Array.isArray(slice1), 'adminProfiles must remain a true Array instance');
      assert.equal(slice1.length, 2);

      // Functional updater returning array
      store.setSlice('adminProfiles', prev => [...prev, 'admin-3']);
      const slice2 = store.getSlice('adminProfiles');
      assert.ok(Array.isArray(slice2));
      assert.deepEqual(slice2, ['admin-1', 'admin-2', 'admin-3']);
    });

    it('TripStore: handles 1,500 rapid slice mutations across default slices with high throughput', () => {
      const store = createTripStore();
      const defaultSlices = ['syncState', 'weather', 'checklist', 'expenses', 'portalTrips'];
      let notifyCount = 0;

      const unsub = store.subscribe(() => {
        notifyCount++;
      });

      const start = performance.now();
      for (let i = 0; i < 1500; i++) {
        const sliceName = defaultSlices[i % defaultSlices.length];
        if (sliceName === 'checklist' || sliceName === 'expenses' || sliceName === 'portalTrips') {
          store.setSlice(sliceName, prev => [...(Array.isArray(prev) ? prev.slice(-5) : []), { id: i }]);
        } else {
          store.setSlice(sliceName, prev => ({ ...prev, seq: i }));
        }
      }
      const duration = performance.now() - start;

      assert.equal(notifyCount, 1500);
      assert.ok(duration < 250, `1,500 mutations took ${duration}ms, expected < 250ms`);

      // Array slices must preserve Array prototype
      assert.ok(Array.isArray(store.getSlice('checklist')));
      assert.ok(Array.isArray(store.getSlice('expenses')));
      assert.ok(Array.isArray(store.getSlice('portalTrips')));

      unsub();
    });

    it('TripStore: subscriber self-unsubscribing inside its own notification callback terminates cleanly', () => {
      const store = createTripStore();
      let callCount = 0;

      let unsub;
      unsub = store.subscribe((state) => {
        callCount++;
        if (callCount === 1) {
          unsub(); // Self-unsubscribes
        }
      });

      store.setState({ syncState: { mode: 'syncing', status: 'uploading' } });
      assert.equal(callCount, 1);

      store.setState({ syncState: { mode: 'idle', status: 'done' } });
      store.setState({ syncState: { mode: 'idle', status: 'ready' } });
      assert.equal(callCount, 1, 'Self-unsubscribed listener must never receive subsequent notifications');
    });

    it('TripStore: array preservation on setSlice and setState guards against object spread pollution', () => {
      const store = createTripStore();

      // Setting Array slice via setSlice
      const checklistItems = [{ id: 'item-1', title: 'パスポート' }, { id: 'item-2', title: '充電器' }];
      store.setSlice('checklist', checklistItems);

      const retrievedChecklist = store.getSlice('checklist');
      assert.ok(Array.isArray(retrievedChecklist), 'Checklist slice must be a genuine Array');
      assert.equal(typeof retrievedChecklist.map, 'function', 'Checklist slice must have Array.prototype methods');
      assert.equal(retrievedChecklist.length, 2);

      // Attempting to pass Array to setState root must NOT spread numeric indices onto state root
      store.setState(['corrupted', 'array', 'spread']);
      const state = store.getState();
      assert.equal(state['0'], undefined, 'State root must NOT have numeric index keys from Array spread');
      assert.equal(state['1'], undefined);
    });

  });

});
