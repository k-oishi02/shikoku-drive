import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeRange,
  formatMinute,
  cleanCard,
  cleanCandidate,
  cleanPlanning,
  migrateTripToV2,
  stripPlanningForPublication,
  SHIORI_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from '../src/trip-v2-core.js';

describe('Trip Core Suite', () => {

  describe('parseTimeRange', () => {
    test('parses valid time ranges into start and end minutes', () => {
      assert.deepEqual(parseTimeRange('09:00 - 10:30'), { start: 540, end: 630 });
      assert.deepEqual(parseTimeRange('00:00 - 23:59'), { start: 0, end: 1439 });
      assert.deepEqual(parseTimeRange('12:15 - 13:45'), { start: 735, end: 825 });
    });

    test('rejects ranges where end <= start', () => {
      assert.equal(parseTimeRange('10:00 - 10:00'), null);
      assert.equal(parseTimeRange('14:30 - 12:00'), null);
    });

    test('rejects out of bound hours or minutes', () => {
      assert.equal(parseTimeRange('24:00 - 25:00'), null);
      assert.equal(parseTimeRange('12:60 - 14:00'), null);
      assert.equal(parseTimeRange('10:00 - 12:75'), null);
    });

    test('rejects malformed strings or non-strings', () => {
      assert.equal(parseTimeRange('9:00 - 10:00'), null);
      assert.equal(parseTimeRange('09:00-10:00'), null);
      assert.equal(parseTimeRange('invalid'), null);
      assert.equal(parseTimeRange(''), null);
      assert.equal(parseTimeRange(null), null);
      assert.equal(parseTimeRange(undefined), null);
    });
  });

  describe('formatMinute', () => {
    test('formats minutes from midnight to HH:mm string', () => {
      assert.equal(formatMinute(0), '00:00');
      assert.equal(formatMinute(540), '09:00');
      assert.equal(formatMinute(630), '10:30');
      assert.equal(formatMinute(1439), '23:59');
    });

    test('handles modulo 1440 wrap-around for >= 1440', () => {
      assert.equal(formatMinute(1440), '00:00');
      assert.equal(formatMinute(1500), '01:00');
    });

    test('handles negative minute values cleanly', () => {
      assert.equal(formatMinute(-60), '23:00');
      assert.equal(formatMinute(-1), '23:59');
    });
  });

  describe('cleanCard', () => {
    test('preserves existing valid cardId and standard fields', () => {
      const card = {
        cardId: 'card-tokyo-01',
        title: '浅草寺',
        time: '09:00 - 10:30',
        desc: '雷門前で集合',
        badge: '観光',
        timeLocked: true,
        travelMinutesFromPrevious: 15
      };
      const cleaned = cleanCard(card, 'day1', 0);
      assert.equal(cleaned.cardId, 'card-tokyo-01');
      assert.equal(cleaned.title, '浅草寺');
      assert.equal(cleaned.time, '09:00 - 10:30');
      assert.equal(cleaned.timeLocked, true);
      assert.equal(cleaned.travelMinutesFromPrevious, 15);
    });

    test('generates deterministic fallback cardId if missing or malformed', () => {
      const card = {
        title: 'スカイツリー',
        time: '11:00 - 12:30'
      };
      const cleaned1 = cleanCard(card, 'day1', 1);
      const cleaned2 = cleanCard(card, 'day1', 1);
      assert.ok(cleaned1.cardId.startsWith('day1-02-'));
      assert.equal(cleaned1.cardId, cleaned2.cardId); // Deterministic hash
    });

    test('cleans and filters links correctly', () => {
      const card = {
        title: 'リンクテスト',
        links: [
          { label: 'Google Maps', url: 'https://maps.google.com' },
          { label: 'ルート', url: 'https://maps.google.com/?dir=1', kind: 'route' },
          { label: '無効リンク', url: 'javascript:alert(1)' }, // stripped
          { label: '', url: 'https://example.com' } // stripped due to empty label
        ]
      };
      const cleaned = cleanCard(card, 'day1', 0);
      assert.equal(cleaned.links.length, 2);
      assert.equal(cleaned.links[0].label, 'Google Maps');
      assert.equal(cleaned.links[1].kind, 'route');
    });

    test('cleans reservation and constraints structures', () => {
      const card = {
        title: '予約テスト',
        reservation: {
          number: 'RES-12345',
          name: '山田太郎',
          url: 'https://hotel.example.com/res/12345'
        },
        constraints: {
          opensAt: '09:00',
          closesAt: '18:00',
          arrivalBufferMinutes: 30
        },
        notifyBeforeMinutes: [10, 30, 10] // duplicate 10
      };
      const cleaned = cleanCard(card, 'day1', 0);
      assert.equal(cleaned.reservation.number, 'RES-12345');
      assert.equal(cleaned.constraints.opensAt, '09:00');
      assert.equal(cleaned.constraints.arrivalBufferMinutes, 30);
      assert.deepEqual(cleaned.notifyBeforeMinutes, [30, 10]); // sorted descending and deduped
    });
  });

  describe('cleanCandidate', () => {
    test('cleans and normalizes valid candidate', () => {
      const candidate = {
        id: 'cand-tsukiji-01',
        title: '築地市場',
        category: 'gourmet',
        priority: 'high',
        durationMinutes: 90,
        notes: '海鮮丼'
      };
      const cleaned = cleanCandidate(candidate);
      assert.equal(cleaned.id, 'cand-tsukiji-01');
      assert.equal(cleaned.title, '築地市場');
      assert.equal(cleaned.category, 'gourmet');
      assert.equal(cleaned.priority, 'high');
      assert.equal(cleaned.durationMinutes, 90);
      assert.equal(cleaned.status, 'draft');
      assert.ok(cleaned.createdAt);
      assert.ok(cleaned.updatedAt);
    });

    test('returns null for missing title or non-object', () => {
      assert.equal(cleanCandidate(null), null);
      assert.equal(cleanCandidate({ title: '' }), null);
      assert.equal(cleanCandidate({}), null);
    });

    test('supplies defaults for invalid category, priority, duration', () => {
      const candidate = {
        title: 'デフォルト確認',
        category: 'invalid',
        priority: 'invalid',
        durationMinutes: 'invalid'
      };
      const cleaned = cleanCandidate(candidate);
      assert.equal(cleaned.category, 'sightseeing');
      assert.equal(cleaned.priority, 'normal');
      assert.equal(cleaned.durationMinutes, 60);
    });

    test('generates uuid fallback for candidate ID', () => {
      const candidate = { title: 'IDなし候補' };
      const cleaned = cleanCandidate(candidate);
      assert.ok(cleaned.id.startsWith('cand-'));
    });
  });

  describe('cleanPlanning', () => {
    test('normalizes planning object with schema version 3', () => {
      const raw = {
        candidates: [
          { id: 'cand-001', title: '候補1' },
          { title: '' } // skipped
        ],
        notes: '計画の全体メモ'
      };
      const cleaned = cleanPlanning(raw);
      assert.equal(cleaned.schemaVersion, PLANNING_SCHEMA_VERSION);
      assert.equal(cleaned.candidates.length, 1);
      assert.equal(cleaned.candidates[0].id, 'cand-001');
      assert.equal(cleaned.notes, '計画の全体メモ');
      assert.ok(cleaned.lastSavedAt);
    });

    test('handles empty or null input gracefully', () => {
      const cleaned = cleanPlanning(null);
      assert.equal(cleaned.schemaVersion, 3);
      assert.deepEqual(cleaned.candidates, []);
      assert.equal(cleaned.notes, '');
    });
  });

  describe('migrateTripToV2', () => {
    test('migrates trip to schema v2 with defaults', () => {
      const raw = {
        tripId: 'kyoto-2026',
        title: '京都散策',
        startDate: '2026-11-10',
        endDate: '2026-11-12',
        days: {
          day1: [{ cardId: 'card-k1', title: '金閣寺' }]
        }
      };
      const trip = migrateTripToV2(raw);
      assert.equal(trip.schemaVersion, SHIORI_SCHEMA_VERSION);
      assert.equal(trip.tripId, 'kyoto-2026');
      assert.equal(trip.title, '京都散策');
      assert.equal(trip.theme.mode, 'auto');
      assert.equal(trip.features.nowMode, true);
      assert.equal(trip.features.expenses, true);
      assert.equal(trip.features.notifications, false);
      assert.equal(trip.days.day1.length, 1);
      assert.equal(trip.dayLabels.day1, 'DAY1');
    });

    test('ensures at least day1 exists if days object is empty', () => {
      const trip = migrateTripToV2({});
      assert.ok(trip.days.day1);
      assert.deepEqual(trip.days.day1, []);
      assert.equal(trip.dayLabels.day1, 'DAY1');
    });

    test('strips obsolete legacy fields', () => {
      const raw = {
        title: 'レガシーしおり',
        theme: { mode: 'light', coverImage: 'https://example.com/cover.jpg' },
        features: { offline: true, expenses: true },
        OPTIONAL: true,
        wallet: 50000
      };
      const trip = migrateTripToV2(raw);
      assert.equal(trip.theme.coverImage, undefined);
      assert.equal(trip.features.offline, undefined);
      assert.equal(trip.OPTIONAL, undefined);
      assert.equal(trip.wallet, undefined);
    });
  });

  describe('stripPlanningForPublication', () => {
    test('removes internal planning and candidate properties for publication', () => {
      const tripWithPlanning = {
        tripId: 'publish-trip',
        title: '公開旅行',
        days: { day1: [] },
        planning: { schemaVersion: 3, candidates: [] },
        candidates: [{ id: 'c1', title: '非公開候補' }],
        planningJson: '{"schemaVersion":3}'
      };
      const stripped = stripPlanningForPublication(tripWithPlanning);
      assert.equal(stripped.schemaVersion, 2);
      assert.equal(stripped.tripId, 'publish-trip');
      assert.equal(stripped.planning, undefined);
      assert.equal(stripped.candidates, undefined);
      assert.equal(stripped.planningJson, undefined);
    });
  });

});
