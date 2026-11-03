import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  KNOWN_MEMBERS_DOC_ID,
  computeParticipantInboxGrantId,
  collectKnownParticipants,
  syncKnownParticipantsDirectory,
  pushDistributionToMembers,
  revokeMemberInboxEntries
} from '../src/admin-trip-store.js';

const sha256Hex = async value => crypto.createHash('sha256').update(String(value)).digest('hex');

function createMockFirestore(initialDocs = {}) {
  const store = new Map(Object.entries(initialDocs));
  const doc = (_db, col, id) => ({ path: `${col}/${id}`, col, id });
  const snapOf = path => {
    const has = store.has(path);
    const val = store.get(path);
    return {
      exists: () => has,
      data: () => (has ? structuredClone(val) : undefined)
    };
  };
  const getDoc = async ref => snapOf(ref.path);
  const setDoc = async (ref, data, opts) => {
    if (opts?.merge && store.has(ref.path)) {
      store.set(ref.path, { ...store.get(ref.path), ...structuredClone(data) });
    } else {
      store.set(ref.path, structuredClone(data));
    }
  };
  const runTransaction = async (_db, fn) => {
    const staged = [];
    const tx = {
      get: async ref => snapOf(ref.path),
      set: (ref, data, opts) => staged.push({ op: 'set', ref, data, opts }),
      update: (ref, data) => staged.push({ op: 'update', ref, data })
    };
    const res = await fn(tx);
    for (const item of staged) {
      if (item.op === 'update') {
        if (!store.has(item.ref.path)) throw new Error(`Missing doc: ${item.ref.path}`);
        store.set(item.ref.path, { ...store.get(item.ref.path), ...structuredClone(item.data) });
      } else if (item.opts?.merge && store.has(item.ref.path)) {
        store.set(item.ref.path, { ...store.get(item.ref.path), ...structuredClone(item.data) });
      } else {
        store.set(item.ref.path, structuredClone(item.data));
      }
    }
    return res;
  };
  return { store, doc, getDoc, setDoc, runTransaction, serverTimestamp: () => 'SERVER_TS' };
}

describe('Direct Member Push Sharing (Known Participant Devices)', () => {
  it('computes deterministic SHA-256 inbox grant IDs and rejects invalid UIDs', async () => {
    const id1 = await computeParticipantInboxGrantId('uid_taro_123456', sha256Hex);
    const id2 = await computeParticipantInboxGrantId('uid_taro_123456', sha256Hex);
    assert.equal(id1, id2);
    assert.match(id1, /^[a-f0-9]{64}$/);
    await assert.rejects(() => computeParticipantInboxGrantId('bad/uid', sha256Hex), /無効な参加者端末ID/);
    await assert.rejects(() => computeParticipantInboxGrantId('short', sha256Hex), /無効な参加者端末ID/);
  });

  it('collects, deduplicates, prioritizes newest nicknames, ignores generic names, and marks recent group', () => {
    const savedDirectory = {
      uid_legacy_001: { nickname: 'はるか', lastTripId: '20260501', lastLabel: 'GW旅', lastActiveMs: 1000 },
      uid_taro_00001: { nickname: '古い名前', lastTripId: '20260501', lastLabel: 'GW旅', lastActiveMs: 1000 }
    };
    const distributions = [
      {
        id: '20261128_tokNew',
        tripId: '20261128',
        label: '秩父ドライブ',
        createdAt: { seconds: 300 },
        participants: [{ uid: 'uid_anon_99999', nickname: '名無し', lastActive: { seconds: 310 } }]
      },
      {
        id: '20261107_tokPrev',
        tripId: '20261107',
        label: '四国旅メンバー',
        createdAt: { seconds: 200 },
        participants: [
          { uid: 'uid_taro_00001', nickname: 'たろう', lastActive: { seconds: 250 } },
          { uid: 'uid_hana_00002', nickname: 'はなこ', joinedAt: { seconds: 240 } }
        ]
      }
    ];

    const list = collectKnownParticipants(distributions, savedDirectory, '20261128');
    assert.equal(list.length, 3);
    assert.equal(list.some(m => m.uid === 'uid_anon_99999'), false, 'Generic nickname 名無し must be excluded');
    const taro = list.find(m => m.uid === 'uid_taro_00001');
    const hana = list.find(m => m.uid === 'uid_hana_00002');
    const haruka = list.find(m => m.uid === 'uid_legacy_001');
    assert.equal(taro.nickname, 'たろう', 'Newer nickname must override older directory entry');
    assert.equal(taro.isRecent, true, '20261107 should be marked recent when 20261128 is excluded');
    assert.equal(hana.isRecent, true);
    assert.equal(haruka.isRecent, false);
  });

  it('syncs known participant directory with non-active status="directory" and skips redundant writes', async () => {
    const mock = createMockFirestore();
    const knownList = [
      { uid: 'uid_taro_00001', nickname: 'たろう', lastTripId: '20261107', lastLabel: '四国旅', lastActiveMs: 5000 }
    ];
    let writeCount = 0;
    const trackedSetDoc = async (...args) => { writeCount++; return mock.setDoc(...args); };

    const merged1 = await syncKnownParticipantsDirectory({
      db: {}, doc: mock.doc, getDoc: mock.getDoc, setDoc: trackedSetDoc, serverTimestamp: mock.serverTimestamp, knownList
    });
    assert.equal(writeCount, 1);
    const savedDoc = mock.store.get(`accessGrants/${KNOWN_MEMBERS_DOC_ID}`);
    assert.equal(savedDoc.status, 'directory', 'Directory doc must NOT have status="active" so non-admins cannot get() it');
    assert.equal(savedDoc.members.uid_taro_00001.nickname, 'たろう');

    await syncKnownParticipantsDirectory({
      db: {}, doc: mock.doc, getDoc: mock.getDoc, setDoc: trackedSetDoc, serverTimestamp: mock.serverTimestamp,
      knownList, existingDirectory: merged1
    });
    assert.equal(writeCount, 1, 'Unchanged directory must not trigger redundant Firestore write');
  });

  it('pushes distribution to selected members atomically, auto-expands capacity, and preserves existing inbox trips', async () => {
    const ledgerToken = 'A'.repeat(43);
    const roomId = `20261128_${ledgerToken}`;
    const existingInboxId = await computeParticipantInboxGrantId('uid_taro_00001', sha256Hex);
    const mock = createMockFirestore({
      [`rooms/${roomId}`]: {
        schemaVersion: 2,
        tripId: '20261128',
        status: 'active',
        capacity: 2,
        members: { uid_owner_0000: true }
      },
      [`adminDistributions/${roomId}`]: {
        roomId,
        tripId: '20261128',
        label: '秩父・長瀞 紅葉ドライブ',
        ledgerToken,
        accessId: 'ABCD2345EFGH',
        grantId: 'grant_hash_20261128',
        status: 'active',
        capacity: 2
      },
      [`accessGrants/${existingInboxId}`]: {
        kind: 'participantInbox',
        targetUid: 'uid_taro_00001',
        status: 'active',
        items: {
          old_room_1: { tripId: '20261107', roomId: 'old_room_1', accessId: 'ZZZZ2222YYYY', ledgerToken: 'B'.repeat(43) }
        }
      }
    });

    const result = await pushDistributionToMembers({
      db: {},
      doc: mock.doc,
      runTransaction: mock.runTransaction,
      serverTimestamp: mock.serverTimestamp,
      sha256Fn: sha256Hex,
      distribution: { id: roomId, roomId },
      membersToShare: [
        { uid: 'uid_taro_00001', nickname: 'たろう' },
        { uid: 'uid_hana_00002', nickname: 'はなこ' }
      ],
      adminUid: 'admin_user_1'
    });

    assert.equal(result.sharedCount, 2);
    assert.equal(result.capacity, 3, 'Capacity should auto-expand from 2 to 3 (1 existing + 2 pushed)');

    const updatedRoom = mock.store.get(`rooms/${roomId}`);
    assert.equal(updatedRoom.members.uid_taro_00001, true);
    assert.equal(updatedRoom.members.uid_hana_00002, true);
    assert.equal(updatedRoom.capacity, 3);

    const updatedDist = mock.store.get(`adminDistributions/${roomId}`);
    assert.equal(updatedDist.sharedMembers.uid_taro_00001.nickname, 'たろう');
    assert.equal(updatedDist.sharedMembers.uid_hana_00002.nickname, 'はなこ');

    const taroInbox = mock.store.get(`accessGrants/${existingInboxId}`);
    assert.equal(taroInbox.status, 'active');
    assert.ok(taroInbox.items.old_room_1, 'Previous trip in inbox must be preserved');
    assert.equal(taroInbox.items[roomId].tripId, '20261128');
    assert.equal(taroInbox.items[roomId].accessId, 'ABCD2345EFGH');

    // Now test revocation cleanup
    const revokedCount = await revokeMemberInboxEntries({
      db: {}, doc: mock.doc, getDoc: mock.getDoc, setDoc: mock.setDoc,
      serverTimestamp: mock.serverTimestamp, sha256Fn: sha256Hex,
      uids: ['uid_taro_00001'], roomId
    });
    assert.equal(revokedCount, 1);
    const cleanedInbox = mock.store.get(`accessGrants/${existingInboxId}`);
    assert.equal(cleanedInbox.items[roomId], undefined);
    assert.ok(cleanedInbox.items.old_room_1, 'Unrelated inbox entry must remain intact after revocation');
  });

  it('rejects pushing to revoked distributions', async () => {
    const ledgerToken = 'C'.repeat(43);
    const roomId = `20261128_${ledgerToken}`;
    const mock = createMockFirestore({
      [`rooms/${roomId}`]: { status: 'revoked', capacity: 2, members: {} },
      [`adminDistributions/${roomId}`]: { roomId, tripId: '20261128', ledgerToken, accessId: 'ABCD2345EFGH', grantId: 'g1', status: 'revoked' }
    });
    await assert.rejects(
      () => pushDistributionToMembers({
        db: {}, doc: mock.doc, runTransaction: mock.runTransaction, serverTimestamp: mock.serverTimestamp,
        sha256Fn: sha256Hex, distribution: { id: roomId, roomId },
        membersToShare: [{ uid: 'uid_taro_00001', nickname: 'たろう' }]
      }),
      /有効な配布先のみ直接共有できます/
    );
  });
});
