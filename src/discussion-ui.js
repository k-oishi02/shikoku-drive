import { mapHref } from './map-links.js';

const STATUS = { open: '相談中', adopted: '候補に追加済み', declined: '見送り', withdrawn: '取下げ済み' };
const CONNECTION = { connecting: '接続を確認しています…', live: 'みんなと共有中', offline: 'オフライン（最終取得時点の内容）', revoked: 'この相談へのアクセスは停止されました', stopped: '配布先へ接続すると相談できます' };
const OFFLINE_NOTICE = '※ オフライン表示中：候補への追加状況などは最新でない場合があります。';
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{3,79}$/i.test(value);
const freshId = prefix => prefix + '-' + crypto.randomUUID();
const sameScope = (a, b) => !!a && !!b && ['tripId', 'roomId', 'authUid', 'generation'].every(k => a[k] === b[k]);

// Only unsent text belongs here. Shared snapshots and private planning never do.
export function createDiscussionDraftStore(storage) {
  const key = scope => 'shiori-talk-draft:' + JSON.stringify([scope.tripId, scope.roomId, scope.authUid]);
  return {
    read(scope) {
      try {
        const raw = storage.getItem(key(scope));
        if (!raw || raw.length > 30000) return {};
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    },
    write(scope, value) {
      try { storage.setItem(key(scope), JSON.stringify(value)); return true; } catch { return false; }
    }
  };
}

export function createDiscussionPanel(root, options = {}) {
  const document = root.ownerDocument;
  const prefix = root.id.replace(/[^a-z0-9_-]/gi, '');
  const admin = options.role === 'admin';
  let local;
  try { local = options.storage || window.localStorage; } catch { local = null; }
  const storage = createDiscussionDraftStore(local);
  let service = null, context = null, generation = 0, visible = false, busy = false, connection = 'stopped';
  let unsubscribe = null, unsubscribeComments = null, threadToken = 0;
  let items = [], cursor = null, hasMore = false, headVersion = 0;
  let comments = [], commentCursor = null, commentsMore = false, commentVersion = 0;
  let selected = null, editing = null, drafts = {}, filter = 'all';
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  root.classList.add('talk');
  root.innerHTML = [
    '<header class="talk-header"><div><p class="talk-kicker">PLAN TOGETHER</p><h2>旅の、作戦会議。</h2><p class="talk-intro">気になる場所を持ち寄って、旅をつくろう。</p></div><button class="talk-button talk-primary" type="button" data-ui="new">＋ 提案する</button></header>',
    '<div class="talk-toolbar"><p class="talk-connection" role="status" data-ui="connection"></p><button class="talk-button talk-quiet" type="button" data-ui="retry">再接続</button></div>',
    '<p class="talk-notice" role="status" aria-live="polite" data-ui="notice"></p>',
    '<div class="talk-filters" role="group" aria-label="提案の絞り込み"><button type="button" class="talk-filter" data-filter="all" aria-pressed="true">すべて</button><button type="button" class="talk-filter" data-filter="open" aria-pressed="false">相談中</button><button type="button" class="talk-filter" data-filter="adopted" aria-pressed="false">候補に追加</button></div>',
    '<p class="talk-count" data-ui="count"></p><div class="talk-list" data-ui="list"></div><button class="talk-button talk-more" type="button" data-ui="more" hidden>続きを見る</button>',
    '<p class="talk-footnote">この配布先のメンバーに共有されます。候補への追加だけでは旅程は公開されません。</p>',
    '<dialog class="talk-dialog talk" data-ui="composer" aria-labelledby="' + prefix + '-compose-title"><form data-ui="form">',
    '<header class="talk-dialog-head"><div><p class="talk-kicker">SUGGEST A PLACE</p><h3 id="' + prefix + '-compose-title" data-ui="compose-title">気になる場所を提案</h3></div><button type="button" class="talk-close" data-ui="close-form" aria-label="提案を閉じる">×</button></header>',
    '<label>スポット名<input name="title" required maxlength="120" autocomplete="off" placeholder="例：海が見えるカフェ"></label>',
    '<label>Google Maps の共有リンク <span>任意</span><input name="mapUrl" type="url" maxlength="2048" placeholder="https://maps.app.goo.gl/…"></label>',
    '<label>住所・地図の検索語 <span>任意</span><input name="mapQuery" maxlength="300" placeholder="空欄ならスポット名で検索"></label>',
    '<label>ひとこと <span>任意・200文字まで</span><textarea name="comment" rows="3" maxlength="200" placeholder="ここでゆっくり写真を撮りたい！"></textarea></label>',
    '<p class="talk-help" data-ui="draft-note">未送信の入力は、この端末にだけ保存します。</p><p class="talk-error" role="alert" data-ui="form-error"></p><button class="talk-button talk-primary" type="submit" data-ui="submit">みんなに提案する</button></form></dialog>',
    '<dialog class="talk-dialog talk" data-ui="thread" aria-labelledby="' + prefix + '-thread-title"><header class="talk-dialog-head"><div><p class="talk-kicker">CONVERSATION</p><h3 id="' + prefix + '-thread-title" data-ui="thread-title"></h3></div><button type="button" class="talk-close" data-ui="close-thread" aria-label="コメントを閉じる">×</button></header>',
    '<p class="talk-help">コメントは新しい順に表示します。</p><div class="talk-comments" data-ui="comments"></div><button class="talk-button talk-more" type="button" data-ui="comments-more" hidden>以前のコメント</button>',
    '<form class="talk-comment-form" data-ui="comment-form"><label>コメント<textarea name="text" rows="2" maxlength="200" required placeholder="気になることを話そう"></textarea></label><p class="talk-error" role="alert" data-ui="comment-error"></p><button class="talk-button talk-primary" type="submit" data-ui="comment-submit">送信</button></form></dialog>'
  ].join('');
  const ui = Object.fromEntries([...root.querySelectorAll('[data-ui]')].map(node => [node.dataset.ui, node]));
  const input = name => ui.form.elements.namedItem(name);
  const active = token => token === generation && sameScope(context, service?.getCurrentContext());
  const ready = () => !!context && connection === 'live' && active(generation);
  const notice = (message = '') => { ui.notice.textContent = message; };
  const name = () => String(options.getName?.() || '参加者').trim().slice(0, 40) || '参加者';
  function persist() {
    if (context && !storage.write(context, drafts)) ui['draft-note'].textContent = '端末への保存ができません。閉じる前に入力を控えてください。';
  }
  function renderControls() {
    ui.connection.textContent = CONNECTION[connection] || CONNECTION.stopped;
    ui.connection.dataset.state = connection;

    if (connection === 'offline') {
      if (!ui.notice.textContent || ui.notice.textContent === OFFLINE_NOTICE) {
        ui.notice.textContent = OFFLINE_NOTICE;
        ui.notice.dataset.offlineNotice = 'true';
      }
    } else if (ui.notice.dataset.offlineNotice === 'true' || ui.notice.textContent === OFFLINE_NOTICE) {
      ui.notice.textContent = '';
      delete ui.notice.dataset.offlineNotice;
    }

    const isLive = ready();
    const offlineTitle = reason => isLive ? '' : (connection === 'offline' ? reason : '');

    ui.new.disabled = !isLive || busy;
    ui.new.title = offlineTitle('オフライン中は提案できません');

    ui.submit.disabled = !isLive || busy;
    ui.submit.title = offlineTitle(editing ? 'オフライン中は編集できません' : 'オフライン中は提案できません');

    for (const button of [ui.more, ui['comments-more']]) button.disabled = !isLive || busy;
    ui.more.hidden = !hasMore;
    ui['comments-more'].hidden = !commentsMore;
    ui.retry.hidden = connection === 'live' || connection === 'connecting';
    ui.retry.disabled = busy;

    ui['comment-submit'].disabled = !isLive || busy || selected?.status === 'withdrawn';
    ui['comment-submit'].title = isLive
      ? (selected?.status === 'withdrawn' ? '取下げ済みの提案にはコメントできません' : '')
      : (selected?.status === 'withdrawn' ? '取下げ済みの提案にはコメントできません' : (connection === 'offline' ? 'オフライン中はコメントを送信できません' : ''));

    root.querySelectorAll('[data-talk-action="write"]').forEach(node => {
      node.disabled = !isLive || busy;
    });
    root.querySelectorAll('[data-talk-action="read"]').forEach(node => {
      node.disabled = !context || busy || !active(generation);
    });
  }
  function setBusy(value) {
    busy = value;
    for (const form of [ui.form, ui['comment-form']]) form.querySelectorAll('input,textarea,button').forEach(node => node.disabled = value);
    renderControls();
  }
  function action(label, fn, className = '', isWrite = true) {
    const button = el('button', 'talk-button ' + className, label);
    button.type = 'button';
    button.dataset.talkAction = isWrite ? 'write' : 'read';
    button.addEventListener('click', fn);
    return button;
  }
  function replaceItem(item) {
    if (!item?.id) return;
    const index = items.findIndex(x => x.id === item.id);
    if (index >= 0) items[index] = item; else items.unshift(item);
    if (selected?.id === item.id) { selected = item; renderComments(); }
    renderList();
  }
  async function perform(work, onSuccess = () => {}, errorNode = ui.notice) {
    if (!ready() || busy) return;
    const token = generation; errorNode.textContent = ''; setBusy(true);
    try {
      const result = await work();
      if (active(token)) onSuccess(result);
    } catch (error) {
      if (token === generation) {
        errorNode.textContent = error.code === 'stale-session' ? '接続が切り替わりました。再接続して確認してください。' : error.message;
        onConnection(service?.getState() || 'stopped');
      }
    } finally { if (token === generation) setBusy(false); }
  }
  function adminAction(actionName, item, candidate) {
    const bound = { roomId: context.roomId, suggestionId: item.id, candidateId: candidate?.id, nextStatus: actionName };
    return perform(() => options.onAdminAction(actionName, bound), result => {
      if (!result?.ok) { if (!result?.cancelled) notice(result?.error || '操作を完了できませんでした。'); return; }
      if (result.sessionSwitched) return;
      notice(result.localEditsPreserved ? '処理は完了しました。未保存入力を退避し、最新の下書きを読み直してください。' :
        actionName === 'adopt' ? '候補棚に追加しました。日程に配置してから公開できます。' : '提案を更新しました。');
      renderList();
    });
  }
  function renderList() {
    const shown = items.filter(item => (admin || item.status !== 'withdrawn' || item.creatorUid === context?.authUid) && (filter === 'all' || item.status === filter));
    ui.count.textContent = items.length ? '読込済み ' + items.length + '件' + (hasMore ? ' · 続きがあります' : '') : '';
    ui.list.replaceChildren();
    if (!shown.length) {
      const empty = el('div', 'talk-empty');
      empty.append(el('span', 'talk-empty-mark', '＋'), el('h3', '', (ready() || connection === 'offline') ? '最初の「行きたい」を。' : '相談を準備しています'),
        el('p', '', (ready() || connection === 'offline') ? (items.length ? 'この条件の提案はありません。' : '食べたいもの、見たい景色。ひとつから始めましょう。') : CONNECTION[connection]));
      ui.list.append(empty);
    }
    for (const item of shown) {
      const card = el('article', 'talk-card'); card.dataset.suggestionId = item.id;
      const head = el('div', 'talk-card-head'), badge = el('span', 'talk-badge', STATUS[item.status] || '相談中');
      badge.dataset.status = item.status; head.append(badge, el('span', 'talk-author', item.creatorName));
      card.append(head, el('h3', 'talk-card-title', item.title));
      if (item.comment) card.append(el('p', 'talk-card-note', item.comment));
      const actions = el('div', 'talk-actions'), maps = mapHref(item);
      if (maps) {
        const link = el('a', 'talk-button talk-map', 'MAP ↗');
        link.href = maps; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', item.title + 'の地図'); actions.append(link);
      }
      const liked = Object.hasOwn(item.likes || {}, context?.authUid || '');
      if (item.status !== 'withdrawn' || liked) {
        const heart = action((liked ? '♥ ' : '♡ ') + '行きたい ' + Object.keys(item.likes || {}).length,
          () => perform(() => service.setSuggestionReaction(context, item.id, { desired: !liked, name: name() }), replaceItem),
          'talk-reaction',
          true
        );
        heart.setAttribute('aria-pressed', String(liked));
        heart.title = ready() ? '' : (connection === 'offline' ? 'オフライン中はリアクションできません' : '');
        actions.append(heart);
      }
      actions.append(action('コメント', () => openThread(item), '', false));
      card.append(actions);
      const details = el('details', 'talk-details'); details.append(el('summary', '', 'メンバー・操作'));
      const likedNames = Object.values(item.likes || {}).map(like => like.name).filter(Boolean);
      details.append(el('p', 'talk-help', likedNames.length ? '行きたい：' + likedNames.join('・') : 'まだリアクションはありません。'));
      const extras = el('div', 'talk-actions');
      if (item.creatorUid === context?.authUid) {
        if (item.status === 'open') {
          const editBtn = action('編集', () => openComposer(item), '', true);
          editBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は編集できません' : '');
          extras.append(editBtn);
        }
        if (item.status !== 'withdrawn') {
          const withdrawBtn = action('提案を取り下げる', () => {
            if (window.confirm('この提案を取り下げますか？採用済みの候補や旅程は自動では削除されません。'))
              perform(() => service.withdrawSuggestion(context, item.id), replaceItem);
          }, 'talk-danger', true);
          withdrawBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は取下げできません' : '');
          extras.append(withdrawBtn);
        }
      }
      if (admin) {
        const moderation = el('div', 'talk-actions talk-moderation');
        const candidate = options.getCandidate?.(item.id, context?.roomId);
        if (item.status === 'open') {
          const adoptBtn = action('候補棚に追加', () => adminAction('adopt', item), 'talk-primary', true);
          adoptBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は操作できません' : '');
          const declineBtn = action('見送り', () => adminAction('declined', item), '', true);
          declineBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は操作できません' : '');
          moderation.append(adoptBtn, declineBtn);
        }
        if (item.status === 'declined') {
          const reopenBtn = action('再検討する', () => adminAction('open', item), '', true);
          reopenBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は操作できません' : '');
          moderation.append(reopenBtn);
        }
        if (candidate && ['adopted', 'withdrawn'].includes(item.status)) {
          const unadoptBtn = action('採用を取り消す', () => adminAction('unadopt', item, candidate), 'talk-danger', true);
          unadoptBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は操作できません' : '');
          moderation.append(unadoptBtn);
        }
        if (moderation.childNodes.length) card.append(moderation);
      }
      if (extras.childNodes.length) details.append(extras);
      card.append(details); ui.list.append(card);
    }
    renderControls();
  }
  function saveProposalInput() {
    if (editing || !context) return;
    drafts.proposal = { id: validId(drafts.proposal?.id) ? drafts.proposal.id : freshId('sug'),
      title: input('title').value, mapUrl: input('mapUrl').value, mapQuery: input('mapQuery').value, comment: input('comment').value };
    persist();
  }
  function openComposer(item = null) {
    if (!ready() || busy) return;
    editing = item;
    const data = item || drafts.proposal || {};
    for (const field of ['title', 'mapUrl', 'mapQuery', 'comment']) input(field).value = typeof data[field] === 'string' ? data[field] : '';
    ui['compose-title'].textContent = item ? '提案を編集' : '気になる場所を提案';
    ui.submit.textContent = item ? '変更を保存' : 'みんなに提案する'; ui['form-error'].textContent = '';
    ui['draft-note'].textContent = item ? 'この変更はメンバー全員に反映されます。' : '未送信の入力は、この端末にだけ保存します。';
    if (!item) saveProposalInput();
    ui.composer.showModal();
  }
  ui.form.addEventListener('input', saveProposalInput);
  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    const fields = Object.fromEntries(['title', 'mapUrl', 'mapQuery', 'comment'].map(field => [field, input(field).value.trim()]));
    if (!editing) saveProposalInput();
    const edit = editing, payload = { ...fields, id: drafts.proposal?.id, creatorName: name() };
    perform(() => edit ? service.updateSuggestionContent(context, edit.id, fields) : service.createSuggestion(context, payload), result => {
      if (!edit) { delete drafts.proposal; persist(); }
      replaceItem(result); ui.composer.close(); notice(edit ? '提案を更新しました。' : '提案を共有しました。');
    }, ui['form-error']);
  });
  function saveCommentInput() {
    if (!context || !selected) return;
    if (!drafts.comments || typeof drafts.comments !== 'object' || Array.isArray(drafts.comments)) drafts.comments = {};
    const existing = drafts.comments[selected.id];
    drafts.comments[selected.id] = { id: validId(existing?.id) ? existing.id : freshId('com'), text: ui['comment-form'].elements.namedItem('text').value };
    drafts.comments = Object.fromEntries(Object.entries(drafts.comments).slice(-30)); persist();
  }
  function stopThread() {
    threadToken++; commentVersion++;
    const stop = unsubscribeComments; unsubscribeComments = null; stop?.();
    selected = null; comments = []; commentCursor = null; commentsMore = false;
    ui.comments.replaceChildren(); ui['thread-title'].textContent = '';
  }
  function renderComments() {
    ui.comments.replaceChildren();
    if (!comments.length) ui.comments.append(el('p', 'talk-empty', (ready() || connection === 'offline') ? 'まだコメントはありません。' : '接続を確認しています…'));
    for (const comment of comments) {
      const row = el('article', 'talk-comment'); row.dataset.commentId = comment.id;
      row.append(el('strong', '', comment.creatorName), el('p', '', comment.text));
      if (comment.creatorUid === context?.authUid) {
        const deleteBtn = action('削除', () => {
          if (window.confirm('このコメントを削除しますか？')) perform(() => service.deleteSuggestionComment(context, selected.id, comment.id), () => {
            comments = comments.filter(x => x.id !== comment.id); renderComments();
          }, ui['comment-error']);
        }, 'talk-quiet talk-danger', true);
        deleteBtn.title = ready() ? '' : (connection === 'offline' ? 'オフライン中は削除できません' : '');
        row.append(deleteBtn);
      }
      ui.comments.append(row);
    }
    renderControls();
  }
  function openThread(item) {
    if (!context || !service || !active(generation) || busy) return;
    stopThread(); selected = item; ui['thread-title'].textContent = item.title; ui['comment-error'].textContent = '';
    const text = drafts.comments?.[item.id]?.text;
    ui['comment-form'].elements.namedItem('text').value = typeof text === 'string' ? text : '';
    const token = generation, thread = threadToken;
    unsubscribeComments = service.startCommentsSubscription(context, item.id, (rows, page) => {
      if (!active(token) || thread !== threadToken) return;
      commentVersion++; comments = rows; commentCursor = page.cursor; commentsMore = page.hasMore; renderComments();
    }, error => { if (token === generation) ui['comment-error'].textContent = error.message; }, { limitCount: 50, newestFirst: true });
    renderComments(); ui.thread.showModal();
  }
  ui['comment-form'].addEventListener('input', saveCommentInput);
  ui['comment-form'].addEventListener('submit', event => {
    event.preventDefault(); if (!selected) return;
    saveCommentInput();
    const parent = selected.id, draft = drafts.comments[parent];
    perform(() => service.createSuggestionComment(context, parent, { id: draft.id, text: draft.text.trim(), creatorName: name() }), result => {
      delete drafts.comments[parent]; persist(); ui['comment-form'].reset();
      comments = [result, ...comments.filter(x => x.id !== result.id)]; renderComments();
    }, ui['comment-error']);
  });
  function loadMore(isComment) {
    const version = isComment ? commentVersion : headVersion, after = isComment ? commentCursor : cursor;
    if (!after) return;
    return perform(() => isComment ? service.fetchMoreComments(context, selected.id, { pageSize: 50, cursor: after, newestFirst: true }) :
      service.fetchMoreSuggestions(context, { pageSize: 50, cursor: after }), page => {
      if (version !== (isComment ? commentVersion : headVersion)) return;
      const combined = [...(isComment ? comments : items), ...page.items], unique = [...new Map(combined.map(item => [item.id, item])).values()];
      if (isComment) { comments = unique; commentCursor = page.cursor; commentsMore = page.hasMore; renderComments(); }
      else { items = unique; cursor = page.cursor; hasMore = page.hasMore; renderList(); }
    }, isComment ? ui['comment-error'] : ui.notice);
  }
  ui.more.addEventListener('click', () => loadMore(false)); ui['comments-more'].addEventListener('click', () => loadMore(true));
  ui.new.addEventListener('click', () => openComposer());
  ui['close-form'].addEventListener('click', () => { if (!busy) ui.composer.close(); });
  ui['close-thread'].addEventListener('click', () => { if (!busy) ui.thread.close(); });
  ui.composer.addEventListener('close', () => { if (!ui.composer.open) editing = null; });
  ui.thread.addEventListener('close', () => { if (!ui.thread.open) stopThread(); });
  for (const dialog of [ui.composer, ui.thread]) dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  root.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter; root.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderList();
  }));
  function subscribe() {
    if (!visible || unsubscribe || !context || !service) return;
    const token = generation;
    unsubscribe = service.startSuggestionsSubscription(context, (rows, page) => {
      if (!active(token)) return;
      headVersion++; items = rows; cursor = page.cursor; hasMore = page.hasMore;
      if (selected) { const latest = rows.find(x => x.id === selected.id); if (latest) selected = latest; }
      connection = service.getState(); renderList();
    }, error => { if (token === generation) { notice(error.message); onConnection(service.getState()); } }, { limitCount: 50 });
  }
  function disconnect(message = '') {
    generation++;
    const stop = unsubscribe; unsubscribe = null; stop?.(); stopThread();
    ui.composer.close(); ui.thread.close();
    service = null; context = null; drafts = {}; items = []; cursor = null; hasMore = false; busy = false;
    ui.form.reset(); ui['comment-form'].reset(); ui['form-error'].textContent = ''; ui['comment-error'].textContent = '';
    connection = 'stopped'; setBusy(false); notice(message); renderList();
  }
  function connect(binding) {
    if (binding?.service === service && sameScope(binding.context, context)) { subscribe(); return; }
    disconnect();
    if (!binding?.context || !binding?.service) return;
    service = binding.service; context = { ...binding.context }; drafts = storage.read(context);
    connection = service.getState(); renderList(); subscribe();
  }
  function setVisible(value) {
    visible = !!value;
    if (visible) subscribe();
    else {
      generation++;
      const stop = unsubscribe; unsubscribe = null; stop?.(); stopThread();
      ui.composer.close(); ui.thread.close(); items = []; cursor = null; hasMore = false; setBusy(false); renderList();
    }
  }
  function onConnection(value) {
    connection = value;
    if (['revoked', 'stopped'].includes(value)) {
      headVersion++; commentVersion++; items = []; comments = []; cursor = null; commentCursor = null; hasMore = false; commentsMore = false;
      renderList(); renderComments();
    } else if (value === 'offline' || value === 'live') {
      renderList(); renderComments();
    }
    renderControls();
  }
  ui.retry.addEventListener('click', () => {
    if (options.onReconnect) options.onReconnect();
    else if (context && service?.getCurrentContext()) {
      const binding = { service, context: service.getCurrentContext() }; disconnect(); connect(binding);
    }
  });
  renderList();
  return { connect, disconnect, setVisible, onConnection, refresh: renderList, destroy: () => { disconnect(); root.replaceChildren(); } };
}
