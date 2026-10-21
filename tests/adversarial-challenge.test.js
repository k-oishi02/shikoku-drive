import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shiftedTime,
  buildTimeline,
  activeItem,
  calculateNextAvailableTime,
  parseCardLinks,
  formatCardLinks
} from '../src/itinerary-calc.js';

import {
  validateCandidateInput,
  validatePlanningInput,
  validateTripInput,
  validateStoredDraftSize
} from '../src/draft-validation.js';

import {
  settlementTransfers
} from '../src/trip-v2-analysis.js';

import {
  planCascadeTimeAdjustment,
  cleanTravelTimesOnReorder
} from '../src/admin-day-planner.js';

describe('Adversarial Challenge & Stress Suite', () => {

  describe('1. itinerary-calc Adversarial Testing', () => {

    it('shiftedTime: handles null, undefined, and non-object card safely', () => {
      assert.deepEqual(shiftedTime(null, 30), { time: '', label: '', start: null, end: null });
      assert.deepEqual(shiftedTime(undefined, 30), { time: '', label: '', start: null, end: null });
      assert.deepEqual(shiftedTime({}, 30), { time: '', label: '', start: null, end: null });
      assert.deepEqual(shiftedTime({ time: null }, 30), { time: '', label: '', start: null, end: null });
    });

    it('shiftedTime: handles malformed time ranges without crashing', () => {
      const malformed = ['invalid', '25:00 - 26:00', '10:00 - 09:00', '10:00', '', 123, true];
      for (const t of malformed) {
        const res = shiftedTime({ time: t }, 15);
        assert.equal(res.start, null);
        assert.equal(res.end, null);
      }
    });

    it('shiftedTime: 24-hour wrap-around and extreme offsets', () => {
      const card = { time: '10:00 - 11:30' }; // 600 - 690 min
      // +1440 min (exactly 24 hours)
      const res24h = shiftedTime(card, 1440);
      assert.equal(res24h.time, '10:00 - 11:30');
      assert.equal(res24h.start, 2040);
      assert.equal(res24h.end, 2130);

      // Negative offset causing negative start minutes
      const resNeg = shiftedTime(card, -700); // 600 - 700 = -100 min => (1440-100) = 1340 => 22:20
      assert.equal(resNeg.time, '22:20 - 23:50');

      // NaN and non-numeric offset defaults to 0
      assert.equal(shiftedTime(card, NaN).time, '10:00 - 11:30');
      assert.equal(shiftedTime(card, 'invalid').time, '10:00 - 11:30');
      assert.equal(shiftedTime(card, '45').time, '10:45 - 12:15');
    });

    it('buildTimeline: handles missing or corrupt trip and journeyState', () => {
      const res1 = buildTimeline(null, null, null);
      assert.deepEqual(res1.items, []);
      assert.deepEqual(res1.conflicts, []);

      const res2 = buildTimeline({ days: {} }, { days: {} }, 'day1');
      assert.deepEqual(res2.items, []);
    });

    it('buildTimeline: consecutive timeLocked cards and non-matching delay fromCardId', () => {
      const trip = {
        days: {
          day1: [
            { cardId: 'c1', title: 'Card 1', time: '09:00 - 10:00' },
            { cardId: 'c2', title: 'Card 2', time: '10:00 - 11:00', timeLocked: true },
            { cardId: 'c3', title: 'Card 3', time: '11:00 - 12:00', timeLocked: true },
            { cardId: 'c4', title: 'Card 4', time: '12:00 - 13:00' }
          ]
        }
      };

      // Delay from non-existent card ID: delay never starts
      const js1 = {
        days: {
          day1: {
            delay: { minutes: 30, fromCardId: 'non-existent' }
          }
        }
      };
      const res1 = buildTimeline(trip, js1, 'day1');
      assert.equal(res1.items[0].time.time, '09:00 - 10:00');
      assert.equal(res1.items[3].time.time, '12:00 - 13:00');

      // Delay starting at c1: shifts c1 (+30 min -> 09:30-10:30)
      // c2 is timeLocked -> resets delay to 0, shifts 0 -> 10:00-11:00
      // Conflict: c1 ends at 10:30, c2 starts at 10:00 -> 30 min overlap detected!
      // c3 is timeLocked -> stays 11:00-12:00
      // c4 -> delay is 0 -> stays 12:00-13:00
      const js2 = {
        days: {
          day1: {
            delay: { minutes: 30, fromCardId: 'c1' }
          }
        }
      };
      const res2 = buildTimeline(trip, js2, 'day1');
      assert.equal(res2.items[0].time.time, '09:30 - 10:30');
      assert.equal(res2.items[1].time.time, '10:00 - 11:00');
      assert.equal(res2.items[2].time.time, '11:00 - 12:00');
      assert.equal(res2.items[3].time.time, '12:00 - 13:00');
      assert.equal(res2.conflicts.length, 1);
      assert.match(res2.conflicts[0], /30分重なります/);
    });

    it('buildTimeline: extraCards integration and high card volume stress', () => {
      const cards = [];
      for (let i = 0; i < 200; i++) {
        const start = 8 * 60 + i * 2;
        const end = start + 1;
        const sh = String(Math.floor(start / 60)).padStart(2, '0');
        const sm = String(start % 60).padStart(2, '0');
        const eh = String(Math.floor(end / 60)).padStart(2, '0');
        const em = String(end % 60).padStart(2, '0');
        cards.push({ cardId: `c-${i}`, title: `Card ${i}`, time: `${sh}:${sm} - ${eh}:${em}` });
      }

      const trip = { days: { day1: cards } };
      const t0 = performance.now();
      const res = buildTimeline(trip, {}, 'day1');
      const duration = performance.now() - t0;
      assert.equal(res.items.length, 200);
      assert.ok(duration < 100, `buildTimeline for 200 cards took ${duration}ms, expected < 100ms`);
    });

    it('activeItem: handles edge dates, invalid timestamps, and all-done states', () => {
      const timeline = [
        { card: { cardId: 'c1' }, time: { start: 540, end: 600 }, status: 'done' },
        { card: { cardId: 'c2' }, time: { start: 600, end: 660 }, status: 'done' }
      ];
      // All items done
      assert.equal(activeItem(timeline, '2026-11-07'), null);

      // Null timeline input
      assert.equal(activeItem(null, '2026-11-07'), null);

      // Arrived status priority
      const tArrived = [
        { card: { cardId: 'c1' }, time: { start: 540, end: 600 }, status: 'pending' },
        { card: { cardId: 'c2' }, time: { start: 600, end: 660 }, status: 'arrived' },
        { card: { cardId: 'c3' }, time: { start: 660, end: 720 }, status: 'pending' }
      ];
      assert.equal(activeItem(tArrived, '2026-11-07')?.card.cardId, 'c2');

      // Invalid timestamp string does not crash
      assert.ok(activeItem(tArrived, '2026-11-07', 'not-a-valid-date'));
    });

    it('calculateNextAvailableTime: midnight wrap, custom default, and travel minutes', () => {
      assert.equal(calculateNextAvailableTime([], 15, '08:30'), '08:30');
      assert.equal(calculateNextAvailableTime(null, 0), '09:00');

      // Card ending at 23:45 + 30 min travel wraps past midnight to 00:15
      const lateCards = [{ cardId: 'c1', time: '22:00 - 23:45' }];
      assert.equal(calculateNextAvailableTime(lateCards, 30), '00:15');

      // Negative travel minutes
      assert.equal(calculateNextAvailableTime(lateCards, -45), '23:00');
    });

    it('parseCardLinks & formatCardLinks: edge formatting, extra fields, and 1,000 links stress', () => {
      // Multiline with varying whitespace and empty lines
      const raw = '  Label 1 | https://a.com | android://a | ios://a | icon-1  \n\n  Label 2 | https://b.com \n';
      const parsed = parseCardLinks(raw);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].label, 'Label 1');
      assert.equal(parsed[0].androidUrl, 'android://a');
      assert.equal(parsed[1].label, 'Label 2');
      assert.equal(parsed[1].url, 'https://b.com');
      assert.equal(parsed[1].androidUrl, undefined);

      // Route keyword generates kind: route
      const routeRaw = 'ルート | https://maps.google.com';
      assert.equal(parseCardLinks(routeRaw)[0].kind, 'route');

      // Stress test: format and parse 1,000 links
      const links = [];
      for (let i = 0; i < 1000; i++) {
        links.push({
          label: `Link ${i}`,
          url: `https://example.com/${i}`,
          androidUrl: `app://example/${i}`,
          iosUrl: `app://example/${i}`,
          icon: 'map'
        });
      }
      const t0 = performance.now();
      const formatted = formatCardLinks(links);
      const reParsed = parseCardLinks(formatted);
      const duration = performance.now() - t0;
      assert.equal(reParsed.length, 1000);
      assert.equal(reParsed[999].label, 'Link 999');
      assert.ok(duration < 100, `Links roundtrip took ${duration}ms, expected < 100ms`);
    });

  });

  describe('2. draft-validation Adversarial Payload Injection', () => {

    it('validateCandidateInput: rejects primitives and array types', () => {
      const primitives = [null, undefined, 123, 'string', true, false, [1, 2, 3]];
      for (const p of primitives) {
        const errs = validateCandidateInput(p);
        assert.ok(errs.length > 0);
        assert.match(errs[0], /オブジェクトである必要があります/);
      }
    });

    it('validateCandidateInput: prototype pollution keys rejected by whitelist', () => {
      // Craft object with inherited or own prototype property
      const malformed = {
        title: 'Valid Title',
        __proto__: { polluted: true },
        constructor: 'exploit'
      };
      const errs = validateCandidateInput(malformed);
      assert.ok(errs.some(e => e.includes('未対応の候補項目「constructor」')));
      assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
    });

    it('validateCandidateInput: durationMinutes boundary testing (0, 1, 1440, 1441, floats)', () => {
      const base = { title: 'Test' };
      assert.ok(validateCandidateInput({ ...base, durationMinutes: 1 }).length === 0);
      assert.ok(validateCandidateInput({ ...base, durationMinutes: 1440 }).length === 0);

      // Boundaries out of range
      assert.ok(validateCandidateInput({ ...base, durationMinutes: 0 }).some(e => e.includes('所要時間')));
      assert.ok(validateCandidateInput({ ...base, durationMinutes: 1441 }).some(e => e.includes('所要時間')));
      assert.ok(validateCandidateInput({ ...base, durationMinutes: 60.5 }).some(e => e.includes('所要時間')));
      assert.ok(validateCandidateInput({ ...base, durationMinutes: -10 }).some(e => e.includes('所要時間')));
      assert.ok(validateCandidateInput({ ...base, durationMinutes: NaN }).some(e => e.includes('所要時間')));
    });

    it('validateCandidateInput: dangerous URL schemes rejected across all URL fields', () => {
      const dangerousSchemes = [
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'file:///etc/passwd',
        'blob:https://example.com/uuid',
        'vbscript:msgbox(1)',
        'http://insecure.example.com' // only https allowed
      ];

      for (const badUrl of dangerousSchemes) {
        const c = { title: 'Test', official: badUrl, tabelog: badUrl, jalan: badUrl };
        const errs = validateCandidateInput(c);
        assert.ok(errs.length >= 3, `Expected at least 3 errors for scheme ${badUrl}, got ${errs.length}`);
      }
    });

    it('validatePlanningInput: detects duplicate candidate IDs and enforces max notes length', () => {
      const validCand = { title: 'Candidate 1', id: 'cand-001' };
      const dupCand = { title: 'Candidate 2', id: 'cand-001' };
      const pDup = {
        schemaVersion: 3,
        candidates: [validCand, dupCand]
      };
      const errsDup = validatePlanningInput(pDup);
      assert.ok(errsDup.some(e => e.includes('候補ID「cand-001」が重複しています')));

      // Notes length boundary: 5000 valid, 5001 invalid
      const p5000 = { schemaVersion: 3, notes: 'a'.repeat(5000) };
      assert.equal(validatePlanningInput(p5000).length, 0);

      const p5001 = { schemaVersion: 3, notes: 'a'.repeat(5001) };
      assert.ok(validatePlanningInput(p5001).some(e => e.includes('5000文字以内')));
    });

    it('validateTripInput: card constraints and links dangerous schemes', () => {
      const trip = {
        tripId: 'valid-trip-id',
        title: 'Trip Title',
        days: {
          day1: [
            {
              cardId: 'card-001',
              title: 'Spot 1',
              constraints: {
                opensAt: '24:00', // invalid HH:mm
                arrivalBufferMinutes: 400 // max 360
              },
              links: [
                { label: 'Bad Link', url: 'javascript:alert(document.cookie)' }
              ]
            }
          ]
        }
      };
      const errs = validateTripInput(trip);
      assert.ok(errs.some(e => e.includes('opensAtはHH:mm形式')));
      assert.ok(errs.some(e => e.includes('到着バッファは0〜360分')));
      assert.ok(errs.some(e => e.includes('有効なHTTPS URL')));
    });

    it('validateStoredDraftSize: UTF-8 multibyte boundary testing', () => {
      // 300,000 Japanese characters = 900,000 UTF-8 bytes (3 bytes per Japanese char)
      // JSON overhead adds ~30 bytes
      const japaneseStr = 'あ'.repeat(299900); // ~899,700 bytes + overhead < 900,000
      const passInput = { payloadJson: japaneseStr, planningJson: '{}' };
      assert.equal(validateStoredDraftSize(passInput).length, 0);

      const overflowJapanese = 'あ'.repeat(300100); // ~900,300 bytes > 900,000
      const failInput = { payloadJson: overflowJapanese, planningJson: '{}' };
      const failErrs = validateStoredDraftSize(failInput);
      assert.ok(failErrs.some(e => e.includes('900,000バイト')));
    });

  });

  describe('3. trip-v2-analysis (settlementTransfers) Stress & Adversarial Testing', () => {

    it('settlementTransfers: 10+ participants with complex circular debts (net zero)', () => {
      // 10 participants in a circular debt ring where each pays 3000 for the next
      const members = Array.from({ length: 10 }, (_, i) => ({
        id: `user-${i}`,
        name: `User ${i}`
      }));

      const expenses = [];
      for (let i = 0; i < 10; i++) {
        const next = (i + 1) % 10;
        expenses.push({
          payer: `user-${i}`,
          amount: 3000,
          splitMode: 'selected',
          participantIds: [`user-${next}`]
        });
      }

      // Everyone paid 3000 and incurred 3000 in debt -> Net balance for all 10 is 0!
      const transfers = settlementTransfers(members, expenses);
      assert.deepEqual(transfers, [], 'Circular equal debts must resolve to exactly 0 transfers');
    });

    it('settlementTransfers: 15 participants asymmetric settlement and conservation of money', () => {
      const members = Array.from({ length: 15 }, (_, i) => ({
        id: `u${i}`,
        name: `Person ${i}`
      }));

      // 3 major payers pay for everyone
      const expenses = [
        { payer: 'u0', amount: 45000, splitMode: 'equal' }, // 3,000 each
        { payer: 'u1', amount: 15000, splitMode: 'equal' }, // 1,000 each
        { payer: 'u2', amount: 30000, splitMode: 'equal' }, // 2,000 each
        // Subgroup expense
        { payer: 'u3', amount: 7500, splitMode: 'selected', participantIds: ['u3', 'u4', 'u5'] } // 2,500 each
      ];

      const transfers = settlementTransfers(members, expenses);
      assert.ok(transfers.length > 0);

      // Verify conservation of money: sum of all transfers
      const debits = new Map();
      const credits = new Map();
      let totalTransferred = 0;

      for (const t of transfers) {
        assert.ok(t.amount > 0, 'Transfer amount must be positive');
        totalTransferred += t.amount;
        debits.set(t.from, (debits.get(t.from) || 0) + t.amount);
        credits.set(t.to, (credits.get(t.to) || 0) + t.amount);
      }

      const sumDebits = [...debits.values()].reduce((a, b) => a + b, 0);
      const sumCredits = [...credits.values()].reduce((a, b) => a + b, 0);
      assert.equal(sumDebits, sumCredits, 'Total debits must strictly equal total credits');
      assert.equal(sumDebits, totalTransferred);
    });

    it('settlementTransfers: handles fractional amounts and odd divisions', () => {
      const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
      // 1000.75 rounds to 1001. Split by 3 = 333.67 each.
      // B and C each owe A: rounded to 334 or 333.
      const expenses = [{ payer: 'a', amount: 1000.75 }];
      const transfers = settlementTransfers(members, expenses);
      assert.ok(transfers.length > 0);
      const totalRepaid = transfers.reduce((acc, t) => acc + t.amount, 0);
      // Expected total repayment to A is ~667 yen (2/3 of 1001)
      assert.ok(Math.abs(totalRepaid - 667) <= 1, `Total repaid ${totalRepaid} must be within 1 yen of 667`);
    });

    it('settlementTransfers: negative, zero, and invalid amounts are safely ignored', () => {
      const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
      const invalidExpenses = [
        { payer: 'a', amount: -5000 },
        { payer: 'a', amount: 0 },
        { payer: 'a', amount: 'invalid-number' },
        { payer: 'a', amount: null },
        { payer: 'unknown-payer', amount: 10000 }
      ];
      const transfers = settlementTransfers(members, invalidExpenses);
      assert.deepEqual(transfers, []);
    });

    it('settlementTransfers: 50 participants stress performance', () => {
      const members = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
      const expenses = [];
      for (let i = 0; i < 200; i++) {
        const payer = `p${i % 50}`;
        const amount = 1000 + (i * 37) % 5000;
        expenses.push({ payer, amount, splitMode: 'equal' });
      }

      const t0 = performance.now();
      const transfers = settlementTransfers(members, expenses);
      const duration = performance.now() - t0;
      assert.ok(duration < 50, `50-member 200-expense settlement took ${duration}ms, expected < 50ms`);
      assert.ok(transfers.length > 0);
    });

  });

  describe('4. admin-day-planner (planCascadeTimeAdjustment) Adversarial Testing', () => {

    it('planCascadeTimeAdjustment: consecutive locked cards halt adjustment at first barrier', () => {
      const cards = [
        { cardId: 'c1', title: 'Start Spot', time: '09:00 - 10:00' },
        { cardId: 'c2', title: 'Locked Spot A', time: '11:00 - 12:00', timeLocked: true },
        { cardId: 'c3', title: 'Locked Spot B', time: '12:00 - 13:00', timeLocked: true },
        { cardId: 'c4', title: 'Free Spot C', time: '13:00 - 14:00' }
      ];

      // Shift c1 to 09:30 - 10:30 (ends before c2 at 11:00)
      const res = planCascadeTimeAdjustment(cards, 0, '09:30', 60);
      assert.equal(res.errors.length, 0);
      assert.ok(res.warnings.some(w => w.includes('固定予定「Locked Spot A」に到達したため')));
      // c1 is shifted
      assert.equal(res.updatedCards[0].time, '09:30 - 10:30');
      // c2, c3, c4 remain untouched
      assert.equal(res.updatedCards[1].time, '11:00 - 12:00');
      assert.equal(res.updatedCards[2].time, '12:00 - 13:00');
      assert.equal(res.updatedCards[3].time, '13:00 - 14:00');
    });

    it('planCascadeTimeAdjustment: collision error with locked card reports exact overlap minutes', () => {
      const cards = [
        { cardId: 'c1', title: 'Card 1', time: '09:00 - 10:00' },
        { cardId: 'c2', title: 'Locked Card 2', time: '10:30 - 11:30', timeLocked: true }
      ];

      // Shift c1 to start at 09:30 with 90 min duration -> ends at 11:00 (overlaps c2 by 30 min)
      const res = planCascadeTimeAdjustment(cards, 0, '09:30', 90);
      assert.ok(res.errors.some(e => e.includes('30分衝突')));
    });

    it('planCascadeTimeAdjustment: reverse order cards are shifted forward sequentially', () => {
      // Cards initially entered in reverse time order
      const cards = [
        { cardId: 'c1', title: 'Spot 1', time: '16:00 - 17:00' },
        { cardId: 'c2', title: 'Spot 2', time: '12:00 - 13:00' },
        { cardId: 'c3', title: 'Spot 3', time: '09:00 - 10:00' }
      ];

      // Adjust c1 to 09:00 with 60 min -> cascades c2 to 10:00-11:00 and c3 to 11:00-12:00
      const res = planCascadeTimeAdjustment(cards, 0, '09:00', 60);
      assert.equal(res.errors.length, 0);
      assert.equal(res.updatedCards[0].time, '09:00 - 10:00');
      assert.equal(res.updatedCards[1].time, '10:00 - 11:00');
      assert.equal(res.updatedCards[2].time, '11:00 - 12:00');
    });

    it('planCascadeTimeAdjustment: midnight boundary rejection (23:59 vs 24:00)', () => {
      const cards = [{ cardId: 'c1', title: 'Late Spot', time: '20:00 - 21:00' }];

      // Starts at 23:00 for 60 min -> ends at 24:00 (1440 min) -> rejected
      const res2400 = planCascadeTimeAdjustment(cards, 0, '23:00', 60);
      assert.ok(res2400.errors.some(e => e.includes('24:00以降')));

      // Starts at 23:59 for 1 min -> ends at 24:00 -> rejected
      const resMidnight = planCascadeTimeAdjustment(cards, 0, '23:59', 1);
      assert.ok(resMidnight.errors.some(e => e.includes('24:00以降')));

      // Starts at 23:58 for 1 min -> ends at 23:59 (1439 min) -> valid
      const resValid = planCascadeTimeAdjustment(cards, 0, '23:58', 1);
      assert.equal(resValid.errors.length, 0);
      assert.equal(resValid.updatedCards[0].time, '23:58 - 23:59');
    });

    it('planCascadeTimeAdjustment: invalid targetIndex and malformed parameters', () => {
      const cards = [{ cardId: 'c1', title: 'Spot', time: '10:00 - 11:00' }];

      assert.ok(planCascadeTimeAdjustment(cards, -1, '10:00', 60).errors.some(e => e.includes('対象カードが見つかりません')));
      assert.ok(planCascadeTimeAdjustment(cards, 5, '10:00', 60).errors.some(e => e.includes('対象カードが見つかりません')));
      assert.ok(planCascadeTimeAdjustment(cards, 0, '25:00', 60).errors.some(e => e.includes('開始時刻を正しい形式')));
      assert.ok(planCascadeTimeAdjustment(cards, 0, '10:00', 0).errors.some(e => e.includes('滞在時間を1〜1440分')));
      assert.ok(planCascadeTimeAdjustment(cards, 0, '10:00', 1441).errors.some(e => e.includes('滞在時間を1〜1440分')));
    });

    it('cleanTravelTimesOnReorder: travel time preserved only when immediate predecessor matches', () => {
      const before = [
        { cardId: 'c1', title: 'Spot 1' },
        { cardId: 'c2', title: 'Spot 2', travelMinutesFromPrevious: 30 },
        { cardId: 'c3', title: 'Spot 3', travelMinutesFromPrevious: 45 }
      ];

      // Reorder: [c1, c3, c2]
      // c1: index 0 -> deleted travel
      // c3: predecessor was c2, now is c1 -> predecessor changed -> travel deleted!
      // c2: predecessor was c1, now is c3 -> predecessor changed -> travel deleted!
      const after = [
        { cardId: 'c1', title: 'Spot 1' },
        { cardId: 'c3', title: 'Spot 3', travelMinutesFromPrevious: 45 },
        { cardId: 'c2', title: 'Spot 2', travelMinutesFromPrevious: 30 }
      ];

      cleanTravelTimesOnReorder(before, after);
      assert.equal(after[0].travelMinutesFromPrevious, undefined);
      assert.equal(after[1].travelMinutesFromPrevious, undefined);
      assert.equal(after[2].travelMinutesFromPrevious, undefined);
    });

  });

});
