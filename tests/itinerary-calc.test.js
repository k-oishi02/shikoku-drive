import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftedTime,
  buildTimeline,
  activeItem,
  calculateNextAvailableTime,
  parseCardLinks,
  formatCardLinks,
  localDateKey
} from '../src/itinerary-calc.js';

describe('Itinerary Calculation Suite (itinerary-calc)', () => {

  describe('shiftedTime', () => {
    test('shifts valid time range by positive offset minutes', () => {
      const card = { time: '09:00 - 10:30' };
      const shifted = shiftedTime(card, 30);
      assert.equal(shifted.time, '09:30 - 11:00');
      assert.equal(shifted.label, '09:30 - 11:00');
      assert.equal(shifted.start, 570);
      assert.equal(shifted.end, 660);
    });

    test('shifts valid time range by negative offset minutes', () => {
      const card = { time: '10:00 - 11:30' };
      const shifted = shiftedTime(card, -45);
      assert.equal(shifted.time, '09:15 - 10:45');
      assert.equal(shifted.start, 555);
      assert.equal(shifted.end, 645);
    });

    test('handles zero offset cleanly', () => {
      const card = { time: '08:00 - 09:00' };
      const shifted = shiftedTime(card, 0);
      assert.equal(shifted.time, '08:00 - 09:00');
      assert.equal(shifted.start, 480);
      assert.equal(shifted.end, 540);
    });

    test('returns null start and end for unparseable or missing times', () => {
      assert.deepEqual(shiftedTime({ time: '終日' }, 30), {
        time: '終日',
        label: '終日',
        start: null,
        end: null
      });
      assert.deepEqual(shiftedTime(null, 15), {
        time: '',
        label: '',
        start: null,
        end: null
      });
    });
  });

  describe('buildTimeline', () => {
    const mockTrip = {
      days: {
        day1: [
          { cardId: 'c1', title: '羽田空港集合', time: '09:00 - 09:30' },
          { cardId: 'c2', title: 'フライト移動', time: '10:00 - 11:30' },
          { cardId: 'c3', title: '到着後ランチ', time: '12:00 - 13:00' }
        ]
      }
    };

    test('builds standard timeline without delays', () => {
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'c2', 'c3'],
            status: {},
            delay: { minutes: 0, fromCardId: '' },
            extraCards: []
          }
        },
        records: {}
      };

      const result = buildTimeline(mockTrip, journeyState, 'day1');
      assert.equal(result.items.length, 3);
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.items[0].time.time, '09:00 - 09:30');
      assert.equal(result.items[1].time.time, '10:00 - 11:30');
      assert.equal(result.items[2].time.time, '12:00 - 13:00');
    });

    test('propagates delay starting from fromCardId', () => {
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'c2', 'c3'],
            status: {},
            delay: { minutes: 20, fromCardId: 'c2' }, // delay starts at c2
            extraCards: []
          }
        },
        records: {}
      };

      const result = buildTimeline(mockTrip, journeyState, 'day1');
      // c1 has no delay
      assert.equal(result.items[0].time.time, '09:00 - 09:30');
      // c2 has +20m delay -> 10:20 - 11:50
      assert.equal(result.items[1].time.time, '10:20 - 11:50');
      // c3 has +20m delay -> 12:20 - 13:20
      assert.equal(result.items[2].time.time, '12:20 - 13:20');
    });

    test('resets delay at timeLocked cards', () => {
      const tripWithLocked = {
        days: {
          day1: [
            { cardId: 'c1', title: '観光1', time: '09:00 - 10:00' },
            { cardId: 'c2', title: '観光2', time: '10:30 - 11:30' },
            { cardId: 'c3', title: '予約列車（固定）', time: '13:00 - 14:00', timeLocked: true },
            { cardId: 'c4', title: '観光3', time: '14:30 - 15:30' }
          ]
        }
      };
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'c2', 'c3', 'c4'],
            status: {},
            delay: { minutes: 30, fromCardId: 'c1' },
            extraCards: []
          }
        },
        records: {}
      };

      const result = buildTimeline(tripWithLocked, journeyState, 'day1');
      // c1: delayed to 09:30 - 10:30
      assert.equal(result.items[0].time.time, '09:30 - 10:30');
      // c2: delayed to 11:00 - 12:00
      assert.equal(result.items[1].time.time, '11:00 - 12:00');
      // c3: locked, so delay is 0 -> 13:00 - 14:00
      assert.equal(result.items[2].time.time, '13:00 - 14:00');
      // c4: subsequent cards after locked also reset delay -> 14:30 - 15:30
      assert.equal(result.items[3].time.time, '14:30 - 15:30');
    });

    test('detects overlapping time conflicts between consecutive items', () => {
      const conflictingTrip = {
        days: {
          day1: [
            { cardId: 'c1', title: '長引いた会議', time: '09:00 - 11:00' },
            { cardId: 'c2', title: '次のアポ', time: '10:30 - 12:00' }
          ]
        }
      };
      const result = buildTimeline(conflictingTrip, {}, 'day1');
      assert.equal(result.conflicts.length, 1);
      assert.ok(result.conflicts[0].includes('長引いた会議と次のアポが30分重なります'));
    });

    test('integrates extraCards added on-site in journeyState', () => {
      const journeyState = {
        days: {
          day1: {
            order: ['c1', 'extra-1', 'c2'],
            status: {},
            delay: { minutes: 0, fromCardId: '' },
            extraCards: [
              { cardId: 'extra-1', title: '寄り道カフェ', time: '09:35 - 09:55' }
            ]
          }
        }
      };
      const result = buildTimeline(mockTrip, journeyState, 'day1');
      assert.equal(result.items.length, 3);
      assert.equal(result.items[1].card.title, '寄り道カフェ');
    });
  });

  describe('activeItem', () => {
    const timeline = {
      items: [
        { card: { cardId: 'c1', title: '朝食' }, time: { start: 480, end: 540, label: '08:00 - 09:00' }, status: 'done' },
        { card: { cardId: 'c2', title: '散策' }, time: { start: 570, end: 660, label: '09:30 - 11:00' }, status: '' },
        { card: { cardId: 'c3', title: '昼食' }, time: { start: 720, end: 780, label: '12:00 - 13:00' }, status: '' }
      ]
    };

    test('returns null when all items are done or skipped', () => {
      const allDone = {
        items: [
          { card: { cardId: 'c1' }, status: 'done' },
          { card: { cardId: 'c2' }, status: 'skipped' }
        ]
      };
      assert.equal(activeItem(allDone, '2026-11-01'), null);
    });

    test('prioritizes item with arrived status immediately', () => {
      const withArrived = {
        items: [
          { card: { cardId: 'c1' }, time: { start: 480, end: 540 }, status: 'done' },
          { card: { cardId: 'c2' }, time: { start: 570, end: 660 }, status: '' },
          { card: { cardId: 'c3' }, time: { start: 720, end: 780 }, status: 'arrived' }
        ]
      };
      const active = activeItem(withArrived, '2026-11-01');
      assert.equal(active.card.cardId, 'c3');
    });

    test('returns currently ongoing item on the active date', () => {
      const testDate = new Date('2026-11-01T10:15:00+09:00'); // 10:15 JST = minute 615 (within 09:30 - 11:00)
      const dateKey = '2026-11-01';
      const active = activeItem(timeline, dateKey, testDate);
      assert.equal(active.card.cardId, 'c2');
    });

    test('returns upcoming item if before start time on the active date', () => {
      const testDate = new Date('2026-11-01T09:15:00+09:00'); // 09:15 JST = minute 555 (before 09:30)
      const dateKey = '2026-11-01';
      const active = activeItem(timeline, dateKey, testDate);
      assert.equal(active.card.cardId, 'c2');
    });

    test('falls back to first pending item when dateKey is not today', () => {
      const active = activeItem(timeline, '2026-12-25', new Date('2026-11-01T10:00:00+09:00'));
      assert.equal(active.card.cardId, 'c2'); // c1 is done, c2 is first pending
    });
  });

  describe('calculateNextAvailableTime', () => {
    test('returns default 09:00 when cards list is empty', () => {
      assert.equal(calculateNextAvailableTime([], 15), '09:00');
      assert.equal(calculateNextAvailableTime(null, 15), '09:00');
    });

    test('supports custom default fallback time', () => {
      assert.equal(calculateNextAvailableTime([], 15, '08:30'), '08:30');
    });

    test('calculates start time based on last card end time plus travel minutes', () => {
      const cards = [
        { time: '09:00 - 10:00' },
        { time: '10:30 - 11:45' } // end is 11:45 = 705 minutes
      ];
      // 705 + 15 = 720 -> 12:00
      assert.equal(calculateNextAvailableTime(cards, 15), '12:00');
      // 705 + 0 = 705 -> 11:45
      assert.equal(calculateNextAvailableTime(cards, 0), '11:45');
    });

    test('returns default if last card time is invalid', () => {
      const cards = [{ time: '終日未定' }];
      assert.equal(calculateNextAvailableTime(cards, 15), '09:00');
    });
  });

  describe('parseCardLinks & formatCardLinks roundtrip', () => {
    test('parses multiline pipe-separated link text into structured objects', () => {
      const linkText = `
        ルート | https://maps.google.com/?dir=1
        ANA | https://www.ana.co.jp/ | intent://ana | anaapp:// | ana
        公式サイト | https://example.com/info
      `;
      const parsed = parseCardLinks(linkText);
      assert.equal(parsed.length, 3);
      assert.deepEqual(parsed[0], {
        label: 'ルート',
        url: 'https://maps.google.com/?dir=1',
        kind: 'route'
      });
      assert.deepEqual(parsed[1], {
        label: 'ANA',
        url: 'https://www.ana.co.jp/',
        androidUrl: 'intent://ana',
        iosUrl: 'anaapp://',
        icon: 'ana'
      });
      assert.deepEqual(parsed[2], {
        label: '公式サイト',
        url: 'https://example.com/info'
      });
    });

    test('formats structured link objects into pipe-separated string', () => {
      const links = [
        { label: 'ルート', url: 'https://maps.google.com/?dir=1' },
        { label: 'ANA', url: 'https://www.ana.co.jp/', androidUrl: 'intent://ana', iosUrl: 'anaapp://', icon: 'ana' }
      ];
      const formatted = formatCardLinks(links);
      assert.equal(
        formatted,
        'ルート | https://maps.google.com/?dir=1\nANA | https://www.ana.co.jp/ | intent://ana | anaapp:// | ana'
      );
    });

    test('handles empty or null link formats gracefully', () => {
      assert.deepEqual(parseCardLinks(''), []);
      assert.deepEqual(parseCardLinks(null), []);
      assert.equal(formatCardLinks([]), '');
      assert.equal(formatCardLinks(null), '');
    });

    test('roundtrip consistency: parse(format(links)) matches original structure', () => {
      const original = [
        { label: 'ルート', url: 'https://maps.google.com', kind: 'route' },
        { label: 'ホテル', url: 'https://hotel.jp', androidUrl: 'intent://hotel', iosUrl: 'hotel://', icon: 'bed' }
      ];
      const roundtripped = parseCardLinks(formatCardLinks(original));
      assert.deepEqual(roundtripped, original);
    });
  });

});
