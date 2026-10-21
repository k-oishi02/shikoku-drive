import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { settlementTransfers } from '../src/trip-v2-analysis.js';

describe('Settlement Suite (settlementTransfers)', () => {

  describe('Edge cases: Empty, Single member, Zero amounts', () => {
    test('returns empty array when members list is empty, null, or undefined', () => {
      assert.deepEqual(settlementTransfers([], [{ amount: 1000, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(null, [{ amount: 1000, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(undefined, []), []);
    });

    test('returns empty array when expenses list is empty or null', () => {
      const members = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
      assert.deepEqual(settlementTransfers(members, []), []);
      assert.deepEqual(settlementTransfers(members, null), []);
    });

    test('returns empty array for single member', () => {
      const members = [{ id: 'u1', name: 'Solo Traveler' }];
      const expenses = [{ amount: 5000, payer: 'u1' }];
      assert.deepEqual(settlementTransfers(members, expenses), []);
    });

    test('ignores zero, negative, or invalid amounts', () => {
      const members = [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }];
      const expenses = [
        { amount: 0, payer: 'u1' },
        { amount: -5000, payer: 'u1' },
        { amount: 'invalid', payer: 'u1' },
        { amount: null, payer: 'u1' }
      ];
      assert.deepEqual(settlementTransfers(members, expenses), []);
    });

    test('safely ignores non-finite amounts (Infinity, -Infinity, NaN) without hanging or erroring', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' }
      ];
      assert.deepEqual(settlementTransfers(members, [{ amount: Infinity, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: -Infinity, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: NaN, payer: 'u1' }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: Infinity, payer: 'u1', splitMode: 'selected', participantIds: ['u2'] }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: -Infinity, payer: 'u1', splitMode: 'selected', participantIds: ['u2'] }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: NaN, payer: 'u1', splitMode: 'selected', participantIds: ['u2'] }]), []);
      assert.deepEqual(settlementTransfers(members, [{ amount: 1e309, payer: 'u1' }]), []);
    });

    test('ignores expense when payer is not in members list', () => {
      const members = [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }];
      const expenses = [{ amount: 5000, payer: 'unknown_user' }];
      assert.deepEqual(settlementTransfers(members, expenses), []);
    });
  });

  describe('Equal Split (Default Mode)', () => {
    test('calculates 2-person 50/50 split cleanly', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' }
      ];
      const expenses = [
        { amount: 10000, payer: 'u1' }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'u2',
        fromName: 'Bob',
        to: 'u1',
        toName: 'Alice',
        amount: 5000
      });
    });

    test('calculates 3-person split with multiple expenses from different payers', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' }
      ];
      // Total: 18,000. Equal share: 6,000 each.
      // Alice paid: 12,000 (net: +6,000)
      // Bob paid: 6,000 (net: 0)
      // Charlie paid: 0 (net: -6,000)
      const expenses = [
        { amount: 10000, payer: 'u1' },
        { amount: 6000, payer: 'u2' },
        { amount: 2000, payer: 'u1' }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'u3',
        fromName: 'Charlie',
        to: 'u1',
        toName: 'Alice',
        amount: 6000
      });
    });

    test('handles balanced expenses where all members paid equal total', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' }
      ];
      const expenses = [
        { amount: 5000, payer: 'u1' },
        { amount: 5000, payer: 'u2' }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.deepEqual(transfers, []);
    });
  });

  describe('Selected Participant Split (splitMode: selected)', () => {
    test('splits expense only among selected participants', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' }
      ];
      // Alice paid 4,000 for Alice and Bob only (Charlie did not participate)
      const expenses = [
        {
          amount: 4000,
          payer: 'u1',
          splitMode: 'selected',
          participantIds: ['u1', 'u2']
        }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'u2',
        fromName: 'Bob',
        to: 'u1',
        toName: 'Alice',
        amount: 2000
      });
    });

    test('filters out invalid or non-member participant IDs', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' }
      ];
      const expenses = [
        {
          amount: 6000,
          payer: 'u1',
          splitMode: 'selected',
          participantIds: ['u1', 'u2', 'ghost_user']
        }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.equal(transfers[0].amount, 3000);
      assert.equal(transfers[0].from, 'u2');
      assert.equal(transfers[0].to, 'u1');
    });

    test('ignores expense if selected participantIds has no valid members', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' }
      ];
      const expenses = [
        {
          amount: 6000,
          payer: 'u1',
          splitMode: 'selected',
          participantIds: ['stranger_1', 'stranger_2']
        }
      ];
      assert.deepEqual(settlementTransfers(members, expenses), []);
    });
  });

  describe('Two-pointer greedy debt resolution with multi-members', () => {
    test('resolves multiple debtors and multiple creditors correctly', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' },
        { id: 'u4', name: 'Diana' }
      ];
      // Total expenses: 40,000. Equal share: 10,000 each.
      // Alice paid: 25,000 (net: +15,000 creditor)
      // Bob paid: 15,000 (net: +5,000 creditor)
      // Charlie paid: 0 (net: -10,000 debtor)
      // Diana paid: 0 (net: -10,000 debtor)
      const expenses = [
        { amount: 25000, payer: 'u1' },
        { amount: 15000, payer: 'u2' }
      ];
      const transfers = settlementTransfers(members, expenses);

      // Verify that all transfers correctly satisfy the debts
      const netTransferred = new Map(members.map(m => [m.id, 0]));
      for (const t of transfers) {
        netTransferred.set(t.from, netTransferred.get(t.from) - t.amount);
        netTransferred.set(t.to, netTransferred.get(t.to) + t.amount);
      }

      assert.equal(netTransferred.get('u1'), 15000);
      assert.equal(netTransferred.get('u2'), 5000);
      assert.equal(netTransferred.get('u3'), -10000);
      assert.equal(netTransferred.get('u4'), -10000);
    });

    test('handles odd-amount division rounding cleanly', () => {
      const members = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Charlie' }
      ];
      // 10,000 split 3 ways -> 3,333.33...
      const expenses = [{ amount: 10000, payer: 'u1' }];
      const transfers = settlementTransfers(members, expenses);

      assert.equal(transfers.length, 2);
      assert.equal(transfers[0].amount, 3333);
      assert.equal(transfers[1].amount, 3333);
      assert.equal(transfers[0].to, 'u1');
      assert.equal(transfers[1].to, 'u1');
    });
  });

  describe('Member ID and Name fallbacks', () => {
    test('supports uid and nickname properties when id and name are absent', () => {
      const members = [
        { uid: 'uid-1', nickname: 'Ali' },
        { uid: 'uid-2' } // fallback to '参加者'
      ];
      const expenses = [{ amount: 2000, payer: 'uid-1' }];
      const transfers = settlementTransfers(members, expenses);

      assert.equal(transfers.length, 1);
      assert.equal(transfers[0].from, 'uid-2');
      assert.equal(transfers[0].fromName, '参加者');
      assert.equal(transfers[0].to, 'uid-1');
      assert.equal(transfers[0].toName, 'Ali');
      assert.equal(transfers[0].amount, 1000);
    });
  });

  describe('Duplicate member IDs and resilient membership', () => {
    test('duplicate members in the member list do not distort the division share', () => {
      const members = [
        { id: 'u1', name: 'Alice (Duplicate 1)' },
        { id: 'u1', name: 'Alice (Duplicate 2)' },
        { id: 'u2', name: 'Bob' }
      ];
      // 3,000 yen between 2 unique members (Alice, Bob) -> 1,500 each.
      // If duplicates are not deduplicated, it would divide by 3 (1,000 each) and Bob would pay only 1,000.
      const expenses = [{ amount: 3000, payer: 'u1' }];
      const transfers = settlementTransfers(members, expenses);

      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'u2',
        fromName: 'Bob',
        to: 'u1',
        toName: 'Alice (Duplicate 2)',
        amount: 1500
      });
    });

    test('duplicate members with multiple duplicates and selected splitMode', () => {
      const members = [
        { id: 'u1', name: 'A' },
        { id: 'u1', name: 'A' },
        { id: 'u2', name: 'B' },
        { id: 'u3', name: 'C' },
        { id: 'u3', name: 'C' }
      ];
      // 6,000 yen paid by u1 for all -> 3 unique members -> 2,000 each
      const expenses = [{ amount: 6000, payer: 'u1' }];
      const transfers = settlementTransfers(members, expenses);

      assert.equal(transfers.length, 2);
      const totalRepaid = transfers.reduce((sum, t) => sum + t.amount, 0);
      assert.equal(totalRepaid, 4000); // B owes 2000, C owes 2000
    });

    test('duplicate participant IDs in selected splitMode do not distort division share', () => {
      const members = [
        { id: 'u1', name: 'A' },
        { id: 'u2', name: 'B' },
        { id: 'u3', name: 'C' }
      ];
      // u1 pays 4000 for u1 and u2 (u2 is repeated in participantIds)
      const expenses = [
        {
          amount: 4000,
          payer: 'u1',
          splitMode: 'selected',
          participantIds: ['u1', 'u2', 'u2']
        }
      ];
      const transfers = settlementTransfers(members, expenses);
      assert.equal(transfers.length, 1);
      assert.deepEqual(transfers[0], {
        from: 'u2',
        fromName: 'B',
        to: 'u1',
        toName: 'A',
        amount: 2000
      });
    });
  });

});

