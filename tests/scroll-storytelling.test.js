import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildShioriUI, detectTripAtmosphere } from '../src/viewer-ui.js';

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
    documentElement: { dataset: {} },
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

describe('SHIORI Atmosphere & Typography Cards Experience', () => {
  it('detects trip atmosphere correctly based on keywords and explicit theme', () => {
    assert.equal(detectTripAtmosphere({ title: '秩父・長瀞 晩秋ドライブ 2026' }), 'autumn');
    assert.equal(detectTripAtmosphere({ title: '大洗 海岸・アクアワールド茨城' }), 'ocean');
    assert.equal(detectTripAtmosphere({ title: '小豆島・しまなみ海道 アイランドトリップ' }), 'islands');
    assert.equal(detectTripAtmosphere({ title: '夜景ナイトドライブ' }), 'night');
    assert.equal(detectTripAtmosphere({ title: '鎌倉散策 歴史巡り' }), 'classic');
    assert.equal(detectTripAtmosphere({ title: '秋の旅', theme: { atmosphere: 'ocean' } }), 'ocean');
  });

  it('renders interactive journey route and clean typography cards without image clutter', () => {
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
            { cardId: 'c1', time: '07:30', title: '町屋出発', badge: '出発', desc: '早朝に出発して混雑回避', links: [{ label: '地図', url: 'https://maps.google.com' }] },
            { cardId: 'c2', time: '09:20 - 11:15', title: '長瀞ラインくだり', badge: '舟下り', desc: '紅葉の岩畳を満喫', travelMinutesFromPrevious: 110, links: [{ label: '公式', url: 'https://example.com' }] },
            { cardId: 'c3', time: '11:25 - 11:42', title: '長瀞駅（SL見学）', badge: 'SL', desc: 'SLパレオエクスプレス見学', travelMinutesFromPrevious: 10 }
          ]
        }
      };

      buildShioriUI(mockTrip);

      // 1. Atmosphere dataset applied
      assert.equal(doc.documentElement.dataset.shioriAtmosphere, 'autumn', 'Document must set autumn atmosphere');

      const panelsContainer = elementsById.get('day-panels-container');
      const html = panelsContainer.innerHTML;

      // 2. Journey Strip with clickable chips
      assert.ok(html.includes('class="journey-strip"'), 'Must include interactive journey drive strip');
      assert.ok(html.includes('data-jump-card="c1"'), 'Must render chip for card 1');
      assert.ok(html.includes('data-jump-card="c2"'), 'Must render chip for card 2');
      assert.ok(html.includes('data-jump-card="c3"'), 'Must render chip for card 3');
      assert.ok(html.includes('class="journey-strip-badge">JOURNEY ROUTE</span>'), 'Must display Journey Route badge');
      assert.ok(html.includes('全3スポットの旅路'), 'Header shows full spot count on non-trip days');

      // 3. Clean Cards Without Image Clutter
      assert.ok(!html.includes('class="j-card-media"'), 'Card must NOT render individual image banners');
      assert.ok(!html.includes('class="j-card-photo"'), 'Card must NOT render spot photo elements');
      assert.ok(html.includes('NO. 01</span>'), 'Card 1 must render chapter marker NO. 01');
      assert.ok(html.includes('NO. 02</span>'), 'Card 2 must render chapter marker NO. 02');

      // 4. Travel hint with indicator
      assert.ok(html.includes('travel-car-icon'), 'Travel hint must include route indicator');

      // 5. Tap-to-Expand Accordion: Buttons in summary, description in details
      assert.ok(html.includes('class="j-card-summary"'), 'Card must have summary block');
      assert.ok(html.includes('class="j-card-details"'), 'Card must have details block');
      assert.ok(html.includes('class="j-card-expand-icon" aria-hidden="true">▾</span>'), 'Card must render expand icon arrow');
      assert.match(html, /<div class="j-card-summary">[\s\S]*?<div class="j-btn-row">[\s\S]*?<\/div>[\s\S]*?<\/div>\s*<div class="j-card-details">/, 'Buttons must be in summary while details are expandable');
      assert.match(html, /<div class="j-card-details">[\s\S]*?<div class="j-card-desc">/, 'Description must be inside expandable details block');

      // 6. Default expanded active card
      assert.ok(html.includes('is-expanded'), 'Active card must be expanded by default for discoverability');
      assert.ok(html.includes('aria-expanded="true"'), 'Active card must set aria-expanded=true');
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it('defaults active drive position to current spot on trip day', () => {
    const { doc, elementsById } = createViewerMiniDom();
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    try {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const mockTripToday = {
        title: '本日ドライブ',
        startDate: todayStr,
        endDate: todayStr,
        dayLabels: { day1: '本日' },
        days: {
          day1: [
            { cardId: 'c1', time: '00:00 - 00:05', title: '過去のスポット', badge: '出発' },
            { cardId: 'c2', time: '00:06 - 23:59', title: '現在のスポット', badge: '滞在中' },
            { cardId: 'c3', time: '23:59 - 23:59', title: '未来のスポット', badge: '到着' }
          ]
        }
      };
      buildShioriUI(mockTripToday);
      const html = elementsById.get('day-panels-container').innerHTML;
      assert.ok(html.includes('NOW ·'), 'Must indicate NOW spot in drive route on trip day');
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it('verifies seamless road-trip timeline, crafted buttons, and second-tab whitespace in css', () => {
    const css = fs.readFileSync(new URL('../src/expressive-v32.css', import.meta.url), 'utf8');
    assert.match(css, /#now-mode[\s\S]*?display:\s*none\s*!important/, 'CSS must hide redundant now-mode card');
    assert.match(css, /html\[data-shiori-atmosphere="autumn"\]/, 'CSS must support autumn atmosphere');
    assert.match(css, /html\[data-shiori-atmosphere="ocean"\]/, 'CSS must support ocean atmosphere');
    assert.match(css, /html\[data-shiori-atmosphere="islands"\]/, 'CSS must support islands atmosphere');
    assert.match(css, /html\[data-shiori-atmosphere="night"\]/, 'CSS must support night atmosphere');
    assert.match(css, /html\[data-shiori-atmosphere="classic"\]/, 'CSS must support classic atmosphere');

    // 1. Seamless road-trip timeline connection
    assert.match(css, /\.v2-travel-hint::before[\s\S]*?left:\s*-25px\s*!important/, 'Travel hint must align on -25px track');
    assert.match(css, /\.j-card:not\(\.checklist-card\):not\(\.expense-card\)::after[\s\S]*?left:\s*-25px\s*!important/, 'Card timeline must align on -25px track');

    // 2. Pure typography (no pill frames on numbers or badges)
    assert.match(css, /\.j-card-num-inline[\s\S]*?background:\s*transparent\s*!important/, 'Spot number must not have background box');
    assert.match(css, /\.j-card-cat[\s\S]*?background:\s*transparent\s*!important/, 'Category badge must not have pill frame');

    // 3. Architectural button styles (clean 8px/9px radii)
    assert.match(css, /\.j-btn\.primary[\s\S]*?border-radius:\s*9px\s*!important/, 'Primary button must use crisp architectural radius');
    assert.match(css, /\.j-btn:not\(\.primary\)[\s\S]*?border-radius:\s*8px\s*!important/, 'Secondary button must use crisp architectural radius');

    // 4. Second-tab and expense breathing room
    assert.match(css, /\.expense-card[\s\S]*?padding:\s*24px 22px\s*!important/, 'Expense card must have generous padding');
    assert.match(css, /\.share-room-panel[\s\S]*?padding:\s*20px 22px\s*!important/, 'Share room panel must have generous padding');
    assert.match(css, /\.talk-header[\s\S]*?padding:\s*(20px 0 18px|24px 0 20px)\s*!important/, 'Discussion header must have generous breathing room');

    // 5. Full-bleed sticky navigation bar with generous vertical whitespace
    assert.match(css, /\.j-nav-sticky[\s\S]*?margin-left:\s*-20px\s*!important/, 'Sticky nav bar must extend full bleed to edges');
    assert.match(css, /\.j-nav-sticky[\s\S]*?padding:\s*12px 20px\s*!important/, 'Sticky nav bar must provide generous vertical breathing room');
  });
});
