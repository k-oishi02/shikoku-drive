import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deleteTripRecord } from '../src/admin-trip-store.js';
import { renderTripLibrary } from '../src/admin-view-overview.js';
import { createAdminStore } from '../src/admin-store.js';

function createFakeDb({ adminTrips = [], publishedTrips = [], adminDistributions = [], histories = {}, denyHistories = false } = {}) {
  const store = new Map();
  adminTrips.forEach(id => store.set(`adminTrips/${id}`, { tripId: id }));
  publishedTrips.forEach(id => store.set(`publishedTrips/${id}`, { tripId: id, published: true }));
  adminDistributions.forEach(d => store.set(`adminDistributions/${d.id}`, d));
  Object.entries(histories).forEach(([tripId, ids]) => {
    ids.forEach(ver => store.set(`tripHistories/${tripId}/versions/${ver}`, { revision: ver }));
  });

  const doc = (_db, ...segs) => ({ path: segs.join('/'), id: segs.at(-1) });
  const collection = (_db, ...segs) => ({ path: segs.join('/'), isCollection: true });
  const limit = n => ({ limit: n });
  const query = (col, ...constraints) => ({ ...col, constraints });
  const getDocs = async target => {
    const prefix = `${target.path}/`;
    if (denyHistories && prefix.startsWith('tripHistories/')) {
      const err = new Error('Missing or insufficient permissions.');
      err.code = 'permission-denied';
      throw err;
    }
    let docs = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map(([k, v]) => ({ id: k.slice(prefix.length), ref: { path: k }, data: () => v }));
    const lim = target.constraints?.find(c => c.limit)?.limit;
    if (lim) docs = docs.slice(0, lim);
    return { empty: docs.length === 0, size: docs.length, docs };
  };
  const writeBatch = () => {
    const ops = [];
    return {
      delete: ref => ops.push(ref.path),
      commit: async () => { ops.forEach(p => store.delete(p)); }
    };
  };

  return { store, doc, collection, getDocs, writeBatch, query, limit };
}

function createOverviewDom() {
  const elements = new Map();
  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.textContent = '';
      this.type = '';
      this.disabled = false;
      this.children = [];
      this.listeners = new Map();
      this.classList = { toggle: () => {} };
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      (this.listeners.get('click') || []).forEach(fn => fn({ preventDefault() {} }));
    }
  }
  const listEl = new FakeEl('div');
  elements.set('admin-trip-list', listEl);
  elements.set('metric-trips', new FakeEl('span'));
  elements.set('metric-published', new FakeEl('span'));
  elements.set('overview-updated', new FakeEl('span'));
  const doc = {
    createElement: tag => new FakeEl(tag),
    getElementById: id => elements.get(id) || null
  };
  return { doc, listEl };
}

function collectButtons(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.tagName === 'BUTTON') acc.push(node);
  (node.children || []).forEach(ch => collectButtons(ch, acc));
  return acc;
}

describe('Trip Deletion (deleteTripRecord & Overview UI)', () => {
  it('deletes adminTrips, publishedTrips, and tripHistories versions when no distributions exist', async () => {
    const fake = createFakeDb({
      adminTrips: ['20261128', '20261107'],
      publishedTrips: ['20261128', '20261107'],
      adminDistributions: [{ id: '20261107_tok1', tripId: '20261107', status: 'active' }],
      histories: { '20261128': ['v1', 'v2', 'v3'], '20261107': ['v1'] }
    });

    const result = await deleteTripRecord({
      db: {},
      doc: fake.doc,
      collection: fake.collection,
      getDocs: fake.getDocs,
      writeBatch: fake.writeBatch,
      query: fake.query,
      limit: fake.limit,
      tripId: '20261128',
      batchLimit: 2
    });

    assert.equal(result.deleted, true);
    assert.equal(result.deletedHistories, 3);
    assert.equal(fake.store.has('adminTrips/20261128'), false);
    assert.equal(fake.store.has('publishedTrips/20261128'), false);
    assert.equal(fake.store.has('tripHistories/20261128/versions/v1'), false);
    assert.equal(fake.store.has('adminTrips/20261107'), true);
    assert.equal(fake.store.has('publishedTrips/20261107'), true);
  });

  it('rejects deletion with distributions-exist when a distribution still references tripId', async () => {
    const fake = createFakeDb({
      adminTrips: ['20261128'],
      publishedTrips: ['20261128'],
      adminDistributions: [{ id: '20261128_tok1', tripId: '20261128', status: 'revoked' }]
    });

    await assert.rejects(
      () => deleteTripRecord({
        db: {},
        doc: fake.doc,
        collection: fake.collection,
        getDocs: fake.getDocs,
        writeBatch: fake.writeBatch,
        query: fake.query,
        limit: fake.limit,
        tripId: '20261128'
      }),
      err => err.code === 'distributions-exist'
    );

    assert.equal(fake.store.has('adminTrips/20261128'), true);
    assert.equal(fake.store.has('publishedTrips/20261128'), true);
  });

  it('rejects invalid tripId values', async () => {
    const fake = createFakeDb({ adminTrips: ['20261128'] });
    for (const badId of ['', 'a/b']) {
      await assert.rejects(
        () => deleteTripRecord({
          db: {},
          doc: fake.doc,
          collection: fake.collection,
          getDocs: fake.getDocs,
          writeBatch: fake.writeBatch,
          query: fake.query,
          limit: fake.limit,
          tripId: badId
        }),
        /無効なしおりID/
      );
    }
  });

  it('succeeds deleting main trip docs even if tripHistories cleanup fails', async () => {
    const fake = createFakeDb({
      adminTrips: ['20261128'],
      publishedTrips: ['20261128'],
      histories: { '20261128': ['v1'] },
      denyHistories: true
    });

    const result = await deleteTripRecord({
      db: {},
      doc: fake.doc,
      collection: fake.collection,
      getDocs: fake.getDocs,
      writeBatch: fake.writeBatch,
      query: fake.query,
      limit: fake.limit,
      tripId: '20261128'
    });

    assert.equal(result.deleted, true);
    assert.equal(result.deletedHistories, 0);
    assert.equal(fake.store.has('adminTrips/20261128'), false);
    assert.equal(fake.store.has('publishedTrips/20261128'), false);
  });

  it('shows permanent delete button only to owners (including broken drafts) and triggers deleteTrip', () => {
    const prevDoc = globalThis.document;
    const { doc, listEl } = createOverviewDom();
    globalThis.document = doc;
    try {
      const store = createAdminStore({
        currentRole: 'owner',
        publishedIds: new Set(['20261128']),
        trips: new Map([
          ['20261128', { trip: { tripId: '20261128', title: 'テスト旅', startDate: '2026-11-28', days: { day1: [] } }, loadError: 'broken' }]
        ]),
        distributions: []
      });
      const deletedIds = [];
      renderTripLibrary({
        store,
        onOpenEditor: () => {},
        onOpenDistribution: () => {},
        duplicateTrip: () => {},
        toggleTripArchive: () => {},
        deleteTrip: id => deletedIds.push(id),
        downloadDraftRecovery: () => {}
      });

      const ownerBtns = collectButtons(listEl);
      const delBtn = ownerBtns.find(b => b.textContent === '🗑 しおりを完全削除');
      assert.ok(delBtn, 'owner should see permanent delete button');
      assert.equal(delBtn.className, 'menu-action-item danger-text');
      assert.equal(delBtn.disabled, false, 'owner should still be able to delete broken draft');
      delBtn.click();
      assert.deepEqual(deletedIds, ['20261128']);

      store.setState({ currentRole: 'editor' });
      renderTripLibrary({
        store,
        onOpenEditor: () => {},
        onOpenDistribution: () => {},
        duplicateTrip: () => {},
        toggleTripArchive: () => {},
        deleteTrip: id => deletedIds.push(id),
        downloadDraftRecovery: () => {}
      });
      const editorBtns = collectButtons(listEl);
      assert.equal(editorBtns.some(b => b.textContent === '🗑 しおりを完全削除'), false, 'editor must not see delete button');
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
