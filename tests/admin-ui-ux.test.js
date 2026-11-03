import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  switchEditorTab,
  buildEditorCardRow,
  syncCardDialogSections
} from '../src/admin-ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminHtmlPath = path.resolve(__dirname, '..', 'admin.html');

function createMiniDom() {
  const byId = new Map();
  const allElements = [];

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.className = '';
      this.textContent = '';
      this.id = '';
      this.hidden = false;
      this.open = false;
      this.disabled = false;
      this.draggable = false;
      this.type = '';
      this.value = '';
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.classList = {
        toggle: (cls, force) => {
          const parts = new Set(this.className.split(/\s+/).filter(Boolean));
          const add = force === undefined ? !parts.has(cls) : Boolean(force);
          if (add) parts.add(cls); else parts.delete(cls);
          this.className = [...parts].join(' ');
        },
        contains: cls => this.className.split(/\s+/).filter(Boolean).includes(cls)
      };
      allElements.push(this);
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      for (const fn of (this.listeners.get('click') || [])) fn({ preventDefault() {} });
    }
  }

  const doc = {
    createElement: tag => new FakeElement(tag),
    getElementById: id => byId.get(id) || null,
    querySelectorAll: selector => {
      if (selector === '[data-editor-tab]') return allElements.filter(el => 'editorTab' in el.dataset);
      if (selector === '[data-editor-section]') return allElements.filter(el => 'editorSection' in el.dataset);
      const m = selector.match(/\[data-card-section="([^"]+)"\]$/);
      if (m) return allElements.filter(el => el.tagName === 'DETAILS' && el.dataset.cardSection === m[1]);
      return [];
    },
    querySelector: selector => doc.querySelectorAll(selector)[0] || null
  };

  return { doc, byId, FakeElement };
}

describe('Admin Console Japanese UX & Progressive Disclosure Architecture', () => {
  it('admin.html uses clear Japanese 4-step navigation, progressive accordions, and removes cryptic English labels', () => {
    const html = fs.readFileSync(adminHtmlPath, 'utf8');

    for (const expected of [
      '①', '旅行一覧',
      '②', 'しおり編集・公開',
      '③', 'メンバーへ共有',
      '④', '管理者設定',
      '📂 JSONファイルを読み込む',
      '🚀 参加者へ公開',
      '📅 日程・タイムライン',
      '📍 候補スポット・相談',
      '⚙️ 基本情報・テーマ設定',
      'data-card-section="links"',
      'data-card-section="time"',
      'data-card-section="reservation"',
      'data-dist-unpublished-hint'
    ]) {
      assert.ok(html.includes(expected), `Expected admin.html to include "${expected}"`);
    }

    for (const legacyEnglish of [
      '>OVERVIEW<',
      '>DISTRIBUTE<',
      '>ISSUE ID<',
      '>DEVICE LIMIT<',
      '>COPY LINK<',
      '>COPY APP URL<',
      '>SAVE DRAFT<',
      '>JSON IMPORT<'
    ]) {
      assert.equal(html.includes(legacyEnglish), false, `Legacy cryptic English label ${legacyEnglish} should be replaced`);
    }
  });

  it('switchEditorTab toggles active tab state and shows only matching editor sections', () => {
    const { doc, byId } = createMiniDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    try {
      const viewEditor = doc.createElement('section');
      viewEditor.id = 'view-editor';
      byId.set('view-editor', viewEditor);

      const tabItin = doc.createElement('button'); tabItin.setAttribute('data-editor-tab', 'itinerary');
      const tabCand = doc.createElement('button'); tabCand.setAttribute('data-editor-tab', 'candidates');
      const tabBase = doc.createElement('button'); tabBase.setAttribute('data-editor-tab', 'basics');

      const secItin = doc.createElement('section'); secItin.setAttribute('data-editor-section', 'itinerary');
      const secCand1 = doc.createElement('section'); secCand1.setAttribute('data-editor-section', 'candidates');
      const secCand2 = doc.createElement('section'); secCand2.setAttribute('data-editor-section', 'candidates');
      const secBase = doc.createElement('section'); secBase.setAttribute('data-editor-section', 'basics');

      switchEditorTab('candidates');
      assert.equal(secItin.hidden, true);
      assert.equal(secCand1.hidden, false);
      assert.equal(secCand2.hidden, false);
      assert.equal(secBase.hidden, true);
      assert.equal(tabCand.getAttribute('aria-selected'), 'true');
      assert.equal(tabItin.getAttribute('aria-selected'), 'false');

      switchEditorTab('itinerary');
      assert.equal(secItin.hidden, false);
      assert.equal(secCand1.hidden, true);
      assert.equal(secBase.hidden, true);
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it('buildEditorCardRow renders rich metadata badges, description preview, and quick reorder buttons', () => {
    const { doc } = createMiniDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    try {
      let movedPair = null;
      let edited = false;
      const row = buildEditorCardRow({
        card: {
          time: '09:30 - 11:00',
          badge: 'SPOT',
          title: '長瀞ラインくだり',
          desc: '渓谷と紅葉を和舟から楽しむ定番アクティビティ',
          travelMinutes: 25,
          timeLocked: true,
          mapQuery: '長瀞ラインくだり 本部',
          reservation: { number: 'R-1029' }
        },
        index: 0,
        total: 3,
        onEdit: () => { edited = true; },
        onReorder: (from, to) => { movedPair = [from, to]; }
      });

      const actions = row.children[2];
      assert.equal(actions.children.length, 2, 'First card omits up button and shows down + edit');
      const [downBtn, editBtn] = actions.children;
      downBtn.click();
      assert.deepEqual(movedPair, [0, 1]);
      editBtn.click();
      assert.equal(edited, true);
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it('syncCardDialogSections collapses empty accordions and auto-opens populated sections', () => {
    const { doc } = createMiniDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    try {
      const secLinks = doc.createElement('details'); secLinks.setAttribute('data-card-section', 'links');
      const secTime = doc.createElement('details'); secTime.setAttribute('data-card-section', 'time');
      const secRes = doc.createElement('details'); secRes.setAttribute('data-card-section', 'reservation');

      syncCardDialogSections(null);
      assert.equal(secLinks.open, false);
      assert.equal(secTime.open, false);
      assert.equal(secRes.open, false);

      syncCardDialogSections({
        tabelog: 'https://tabelog.com/saitama/...',
        travelMinutes: 0,
        reservation: { number: 'ABC-999' }
      });
      assert.equal(secLinks.open, true, 'Links section auto-opens when tabelog URL is set');
      assert.equal(secTime.open, false, 'Time section stays closed when all time fields are empty/0');
      assert.equal(secRes.open, true, 'Reservation section auto-opens when reservation number is set');
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
