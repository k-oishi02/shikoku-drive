import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShioriUI } from '../src/viewer-ui.js';

function createViewerMiniDom() {
  const elementsById = new Map();
  const allCreated = [];

  class FakeNode {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.innerHTML = '';
      this.hidden = false;
      this.attributes = new Map();
      this.children = [];
      allCreated.push(this);
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    before() {}
    replaceChildren(...nodes) { this.children = [...nodes]; }
  }

  const doc = {
    createElement: tag => new FakeNode(tag),
    getElementById: id => {
      if (!elementsById.has(id)) {
        const el = new FakeNode('div');
        el.id = id;
        elementsById.set(id, el);
      }
      return elementsById.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => []
  };

  return { doc, elementsById };
}

describe('SHIORI Scroll Storytelling & Magazine Drive Experience', () => {
  it('renders interactive journey drive strip and editorial spot watermarks', () => {
    const { doc, elementsById } = createViewerMiniDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc;

    try {
      const mockTrip = {
        title: '秩父・長瀞 晩秋ドライブ 2026',
        startDate: '2026-11-28',
        endDate: '2026-11-28',
        dayLabels: { day1: '11/28 (土) 秩父ドライブ' },
        days: {
          day1: [
            { cardId: 'c1', time: '07:30', title: '町屋出発', badge: '出発' },
            { cardId: 'c2', time: '09:20 - 11:15', title: '長瀞ラインくだり', badge: '舟下り', travelMinutesFromPrevious: 110 },
            { cardId: 'c3', time: '11:25 - 11:42', title: '長瀞駅（SL見学）', badge: 'SL', travelMinutesFromPrevious: 10 }
          ]
        }
      };

      buildShioriUI(mockTrip);

      const panelsContainer = elementsById.get('day-panels-container');
      const html = panelsContainer.innerHTML;

      // 1. Journey Strip with clickable chips
      assert.ok(html.includes('class="journey-strip"'), 'Must include interactive journey drive strip');
      assert.ok(html.includes('data-jump-card="c1"'), 'Must render chip for card 1');
      assert.ok(html.includes('data-jump-card="c2"'), 'Must render chip for card 2');
      assert.ok(html.includes('data-jump-card="c3"'), 'Must render chip for card 3');
      assert.ok(html.includes('class="journey-strip-badge">🚗 DRIVE ROUTE</span>'), 'Must display Drive Route badge');

      // 2. Spot Watermark and Spot Badges
      assert.ok(html.includes('class="j-spot-watermark" aria-hidden="true">01</span>'), 'Card 1 must have 01 watermark');
      assert.ok(html.includes('class="j-spot-watermark" aria-hidden="true">02</span>'), 'Card 2 must have 02 watermark');
      assert.ok(html.includes('class="j-spot-badge">SPOT 01</span>'), 'Card 1 must have SPOT 01 badge');
      assert.ok(html.includes('class="j-spot-badge">SPOT 02</span>'), 'Card 2 must have SPOT 02 badge');

            // 4. Tap-to-Expand Accordion Structure
      assert.ok(html.includes('class="j-card-summary"'), 'Card must have summary block for collapsed view');
      assert.ok(html.includes('class="j-card-details"'), 'Card must have details block for expanded view');
      assert.ok(html.includes('class="j-card-expand-icon" aria-hidden="true">▾</span>'), 'Card must render expand icon arrow');
      assert.ok(html.includes('class="j-card is-expanded"'), 'First card must be expanded by default for discoverability');
      assert.ok(html.includes('aria-expanded="true"'), 'First card must set aria-expanded=true');
      // 3. Travel hint with moving car icon
      assert.ok(html.includes('travel-car-icon'), 'Travel hint must include animated car icon');
      assert.ok(html.includes('🚗'), 'Must render car emoji in travel hint');
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
