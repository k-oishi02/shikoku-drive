import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCandidateInput,
  validatePlanningInput,
  validateTripInput,
  validateStoredDraftSize
} from '../src/draft-validation.js';

describe('Draft Validation Suite', () => {

  describe('validateCandidateInput', () => {
    test('accepts valid minimal candidate', () => {
      const candidate = {
        id: 'cand-001',
        title: '浅草寺観光',
        category: 'sightseeing',
        priority: 'high',
        durationMinutes: 90,
        status: 'draft'
      };
      const errors = validateCandidateInput(candidate);
      assert.deepEqual(errors, []);
    });

    test('accepts valid candidate with all supported optional fields', () => {
      const candidate = {
        id: 'cand-full-1',
        candidateId: 'cand-full-1',
        title: '築地場外市場',
        category: 'gourmet',
        priority: 'normal',
        durationMinutes: 60,
        status: 'assigned',
        mapQuery: '築地場外市場',
        mapUrl: 'https://maps.google.com/?q=tsukiji',
        official: 'https://www.tsukiji.or.jp/',
        officialLabel: '公式サイト',
        tabelog: 'https://tabelog.com/tokyo/A1313/A131301/13000000/',
        jalan: 'https://www.jalan.net/kankou/spt_13102aj2200024479/',
        notes: '海鮮丼を食べる予定',
        assignedDay: 'day1',
        assignedCardId: 'card-123456',
        createdAt: '2026-10-20T10:00:00.000Z',
        updatedAt: '2026-10-20T10:00:00.000Z',
        placementUndo: { previousDay: 'day2' },
        sourceSuggestion: {
          roomId: 'room-tokyo-2026',
          suggestionId: 'sugg-999',
          adoptedAt: '2026-10-20T10:00:00.000Z'
        }
      };
      const errors = validateCandidateInput(candidate);
      assert.deepEqual(errors, []);
    });

    test('rejects non-object inputs', () => {
      assert.ok(validateCandidateInput(null)[0].includes('オブジェクト'));
      assert.ok(validateCandidateInput(undefined)[0].includes('オブジェクト'));
      assert.ok(validateCandidateInput('string')[0].includes('オブジェクト'));
      assert.ok(validateCandidateInput([1, 2, 3])[0].includes('オブジェクト'));
    });

    test('validates title requirement and length', () => {
      assert.ok(validateCandidateInput({ title: '' }).some(e => e.includes('タイトルは必須')));
      assert.ok(validateCandidateInput({ title: '   ' }).some(e => e.includes('タイトルは必須')));
      assert.ok(validateCandidateInput({}).some(e => e.includes('タイトルは必須')));
      assert.ok(validateCandidateInput({ title: 'a'.repeat(121) }).some(e => e.includes('120文字以内')));
    });

    test('enforces key whitelisting and rejects unknown fields', () => {
      const candidate = {
        title: '有効タイトル',
        unknownField: 'bad',
        extraProperty: 123
      };
      const errors = validateCandidateInput(candidate);
      assert.ok(errors.some(e => e.includes('未対応の候補項目「unknownField」')));
      assert.ok(errors.some(e => e.includes('未対応の候補項目「extraProperty」')));
    });

    test('detects ID format and ID mismatch', () => {
      const mismatch = {
        id: 'cand-001',
        candidateId: 'cand-002',
        title: 'テスト候補'
      };
      assert.ok(validateCandidateInput(mismatch).some(e => e.includes('一致していません')));

      const invalidId = {
        id: 'bad', // too short (< 4 chars)
        title: 'テスト候補'
      };
      assert.ok(validateCandidateInput(invalidId).some(e => e.includes('候補IDの形式が不正')));
    });

    test('validates category, priority, and status enums', () => {
      assert.ok(validateCandidateInput({ title: 'T', category: 'invalid-cat' }).some(e => e.includes('カテゴリーが不正')));
      assert.ok(validateCandidateInput({ title: 'T', priority: 'ultra-high' }).some(e => e.includes('優先度が不正')));
      assert.ok(validateCandidateInput({ title: 'T', status: 'deleted' }).some(e => e.includes('ステータスが不正')));
    });

    test('validates durationMinutes integer boundaries', () => {
      assert.deepEqual(validateCandidateInput({ title: 'T', durationMinutes: 1 }), []);
      assert.deepEqual(validateCandidateInput({ title: 'T', durationMinutes: 1440 }), []);
      assert.ok(validateCandidateInput({ title: 'T', durationMinutes: 0 }).some(e => e.includes('所要時間は1〜1440分')));
      assert.ok(validateCandidateInput({ title: 'T', durationMinutes: 1441 }).some(e => e.includes('所要時間は1〜1440分')));
      assert.ok(validateCandidateInput({ title: 'T', durationMinutes: 30.5 }).some(e => e.includes('所要時間は1〜1440分')));
    });

    test('validates URLs and blocks dangerous or non-HTTPS schemes', () => {
      assert.ok(validateCandidateInput({ title: 'T', official: 'http://insecure.com' }).some(e => e.includes('公式URL')));
      assert.ok(validateCandidateInput({ title: 'T', tabelog: 'javascript:alert(1)' }).some(e => e.includes('食べログURL')));
      assert.ok(validateCandidateInput({ title: 'T', jalan: 'file:///etc/passwd' }).some(e => e.includes('じゃらんURL')));
    });

    test('validates sourceSuggestion structure and required keys', () => {
      const badKeys = {
        title: 'T',
        sourceSuggestion: { roomId: 'r1', suggestionId: 's1', extraKey: true }
      };
      assert.ok(validateCandidateInput(badKeys).some(e => e.includes('未対応の項目「extraKey」')));

      const emptyRoom = {
        title: 'T',
        sourceSuggestion: { roomId: '', suggestionId: 's1' }
      };
      assert.ok(validateCandidateInput(emptyRoom).some(e => e.includes('ルームID（roomId）が不正')));
    });
  });

  describe('validatePlanningInput', () => {
    test('accepts valid planning structure', () => {
      const planning = {
        schemaVersion: 3,
        candidates: [
          { id: 'cand-001', title: '東京タワー', category: 'sightseeing' },
          { id: 'cand-002', title: '六本木ヒルズ', category: 'sightseeing' }
        ],
        notes: '全体のメモ',
        lastSavedAt: '2026-10-20T10:00:00.000Z'
      };
      const errors = validatePlanningInput(planning);
      assert.deepEqual(errors, []);
    });

    test('rejects non-object inputs', () => {
      assert.ok(validatePlanningInput(null)[0].includes('計画データはオブジェクト'));
      assert.ok(validatePlanningInput('string')[0].includes('計画データはオブジェクト'));
    });

    test('enforces key whitelisting on planning root', () => {
      const planning = {
        schemaVersion: 3,
        candidates: [],
        extraProperty: 123
      };
      const errors = validatePlanningInput(planning);
      assert.ok(errors.some(e => e.includes('未対応の計画項目「extraProperty」')));
    });

    test('detects duplicate candidate IDs in candidates list', () => {
      const planning = {
        schemaVersion: 3,
        candidates: [
          { id: 'cand-dup-1', title: '候補1' },
          { id: 'cand-dup-1', title: '候補2' }
        ]
      };
      const errors = validatePlanningInput(planning);
      assert.ok(errors.some(e => e.includes('候補ID「cand-dup-1」が重複')));
    });

    test('propagates nested candidate validation errors with index prefix', () => {
      const planning = {
        schemaVersion: 3,
        candidates: [
          { id: 'cand-ok-1', title: '正常候補' },
          { title: '' } // missing title
        ]
      };
      const errors = validatePlanningInput(planning);
      assert.ok(errors.some(e => e.startsWith('候補[2]:') && e.includes('タイトルは必須')));
    });

    test('enforces schemaVersion === 3', () => {
      assert.ok(validatePlanningInput({ schemaVersion: 2 }).some(e => e.includes('スキーマバージョンは3である必要')));
      assert.ok(validatePlanningInput({ schemaVersion: 4 }).some(e => e.includes('スキーマバージョンは3である必要')));
    });

    test('enforces notes length limit (5000 chars)', () => {
      const longNotes = {
        schemaVersion: 3,
        notes: 'a'.repeat(5001)
      };
      assert.ok(validatePlanningInput(longNotes).some(e => e.includes('5000文字以内')));
    });
  });

  describe('validateTripInput', () => {
    test('accepts valid complete trip object', () => {
      const trip = {
        tripId: 'tokyo-autumn-2026',
        title: '秋の東京ツアー2026',
        subtitle: '歴史とグルメを巡る2泊3日',
        catchphrase: '東京の魅力を再発見',
        startDate: '2026-11-01',
        endDate: '2026-11-03',
        days: {
          day1: [
            {
              cardId: 'card-tokyo-01',
              title: '東京駅集合',
              time: '09:00 - 09:30',
              desc: '丸の内北口改札前',
              travelMinutesFromPrevious: 0,
              timeLocked: true
            },
            {
              cardId: 'card-tokyo-02',
              title: '皇居東御苑散策',
              time: '09:45 - 11:15',
              travelMinutesFromPrevious: 15,
              links: [
                { label: 'ルート', url: 'https://maps.google.com/?dir=1' },
                { label: '皇居ガイド', url: 'https://www.env.go.jp/garden/kokyogaien/' }
              ]
            }
          ]
        },
        dayLabels: { day1: '1日目: 東京駅・皇居' },
        daySettings: {
          day1: { departureTime: '09:00', note: '歩きやすい靴で集合' }
        },
        theme: { mode: 'light', accent: '#f4d35e' },
        features: { nowMode: true, expenses: true, notifications: false }
      };
      const errors = validateTripInput(trip);
      assert.deepEqual(errors, []);
    });

    test('rejects non-object inputs', () => {
      assert.ok(validateTripInput(null)[0].includes('旅程データはオブジェクト'));
    });

    test('validates tripId format', () => {
      assert.ok(validateTripInput({ tripId: 'a', title: 'T' }).some(e => e.includes('旅程ID（tripId）は半角英数字')));
      assert.ok(validateTripInput({ tripId: 'INVALID_CAPS_WITH_!', title: 'T' }).some(e => e.includes('旅程ID（tripId）は半角英数字')));
      assert.deepEqual(validateTripInput({ tripId: 'valid-id-123', title: 'T' }), []);
    });

    test('validates trip title requirement and length limit', () => {
      assert.ok(validateTripInput({ tripId: 'valid-id', title: '' }).some(e => e.includes('旅程のタイトルは必須')));
      assert.ok(validateTripInput({ tripId: 'valid-id', title: 'a'.repeat(121) }).some(e => e.includes('120文字以内')));
    });

    test('detects duplicate card IDs across days', () => {
      const trip = {
        tripId: 'valid-id',
        title: '旅行タイトル',
        days: {
          day1: [{ cardId: 'duplicate-card-id', title: 'カード1' }],
          day2: [{ cardId: 'duplicate-card-id', title: 'カード2' }]
        }
      };
      const errors = validateTripInput(trip);
      assert.ok(errors.some(e => e.includes('カードID「duplicate-card-id」が他のカードと重複')));
    });

    test('validates day key format', () => {
      const trip = {
        tripId: 'valid-id',
        title: '旅行タイトル',
        days: {
          invalidDayKey: []
        }
      };
      const errors = validateTripInput(trip);
      assert.ok(errors.some(e => e.includes('日程キー「invalidDayKey」の形式が不正')));
    });

    test('validates card links and blocks dangerous schemes', () => {
      const trip = {
        tripId: 'valid-id',
        title: '旅行タイトル',
        days: {
          day1: [
            {
              cardId: 'card-link-test-1',
              title: 'カード1',
              links: [
                { label: '危険リンク', url: 'javascript:alert(1)' },
                { label: '正常リンク', url: 'https://example.com', androidUrl: 'javascript:alert(2)' }
              ]
            }
          ]
        }
      };
      const errors = validateTripInput(trip);
      assert.ok(errors.some(e => e.includes('有効なHTTPS URL')));
      assert.ok(errors.some(e => e.includes('危険なスキーム')));
    });

    test('validates card constraints and buffer integer range', () => {
      const trip = {
        tripId: 'valid-id',
        title: '旅行タイトル',
        days: {
          day1: [
            {
              cardId: 'card-const-test-1',
              title: 'カード1',
              constraints: {
                opensAt: '25:00', // invalid HH:mm
                arrivalBufferMinutes: 400 // > 360
              }
            }
          ]
        }
      };
      const errors = validateTripInput(trip);
      assert.ok(errors.some(e => e.includes('opensAtはHH:mm形式')));
      assert.ok(errors.some(e => e.includes('到着バッファは0〜360分')));
    });

    test('validates theme mode and accent color format', () => {
      const trip = {
        tripId: 'valid-id',
        title: '旅行タイトル',
        theme: {
          mode: 'neon', // invalid mode
          accent: 'red' // invalid #RRGGBB
        }
      };
      const errors = validateTripInput(trip);
      assert.ok(errors.some(e => e.includes('表示モードが不正')));
      assert.ok(errors.some(e => e.includes('テーマ色は#RRGGBB形式')));
    });
  });

  describe('validateStoredDraftSize', () => {
    test('passes for standard size payloads under 900KB', () => {
      const input = {
        payloadJson: JSON.stringify({ tripId: 'test-trip', title: '小さな下書き' }),
        planningJson: JSON.stringify({ schemaVersion: 3, candidates: [] })
      };
      const errors = validateStoredDraftSize(input);
      assert.deepEqual(errors, []);
    });

    test('rejects non-object or non-string inputs', () => {
      assert.ok(validateStoredDraftSize(null)[0].includes('入力が不正'));
      assert.ok(validateStoredDraftSize({ payloadJson: 123, planningJson: 'str' }).some(e => e.includes('payloadJsonは文字列')));
      assert.ok(validateStoredDraftSize({ payloadJson: 'str', planningJson: {} }).some(e => e.includes('planningJsonは文字列')));
    });

    test('detects and rejects payloads exceeding 900KB Firestore limit', () => {
      // 900,000 bytes boundary test
      const largePayload = 'x'.repeat(900050);
      const input = {
        payloadJson: largePayload,
        planningJson: '{}'
      };
      const errors = validateStoredDraftSize(input);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('900,000バイト'));
    });
  });

});
