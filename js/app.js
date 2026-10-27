// ============================================================
// app.js — 蔵置所 出庫記録アプリの画面。ロジックは core.js。
// 流れ：日付 → 相手先 → 販路区分 → 品目（1件以上）→ 記録者 → 確認 → 送信 → 結果
// ============================================================
(function () {
  'use strict';

  var core = window.ZoshiCore.create({
    storage: window.localStorage,
    fetch: window.fetch.bind(window),
    uuid: function () {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
  });

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var masters = null;
  var form = null;

  function todayLocal() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function newItem() {
    var def = (masters && masters.containers.indexOf('缶') !== -1) ? '缶' : '';
    return { product: '', container: def, amount: '', unit: 'piece' };
  }
  function resetForm(keepRecorder) {
    form = { date: todayLocal(), partner: '', channel: '', recorder: keepRecorder ? form.recorder : core.getLastRecorder(), items: [newItem()] };
  }

  // ── 画面切り替え ──
  var SCREENS = ['form', 'confirm', 'result', 'history', 'settings'];
  var current = 'form';
  function show(name) {
    current = name;
    SCREENS.forEach(function (s) { $('screen-' + s).hidden = (s !== name); });
    $('btn-back').hidden = (name === 'form');
    $('header-title').textContent = { form: '蔵置所 出庫記録', confirm: '確認', result: '結果', history: '履歴', settings: '設定' }[name];
    window.scrollTo(0, 0);
  }

  function updateBadge() {
    var s = core.queueStats();
    var b = $('queue-badge');
    b.hidden = s.total === 0;
    b.textContent = String(s.total);
  }

  // ── 確認モーダル ──
  function ask(message) {
    return new Promise(function (resolve) {
      $('modal-message').textContent = message;
      $('modal-confirm').hidden = false;
      function done(v) { $('modal-confirm').hidden = true; $('modal-btn-yes').onclick = null; $('modal-btn-no').onclick = null; resolve(v); }
      $('modal-btn-yes').onclick = function () { done(true); };
      $('modal-btn-no').onclick = function () { done(false); };
    });
  }

  // ── フォーム描画 ──
  function renderChannels() {
    var g = $('channel-grid');
    g.textContent = '';
    g.className = 'choice-grid choice-grid--channels';
    var list = masters ? masters.channels : [];
    list.forEach(function (c) {
      var b = el('button', 'choice-btn' + (form.channel === c ? ' choice-btn--on' : ''), c);
      b.type = 'button';
      b.onclick = function () { form.channel = c; renderChannels(); };
      g.appendChild(b);
    });
  }

  function fillSelect(sel, list, value) {
    sel.textContent = '';
    var ph = el('option', null, '選んでください'); ph.value = ''; sel.appendChild(ph);
    list.forEach(function (v) { var o = el('option', null, v); o.value = v; sel.appendChild(o); });
    sel.value = value || '';
  }

  function renderItems() {
    var box = $('items');
    box.textContent = '';
    form.items.forEach(function (it, idx) {
      var card = el('div', 'item-card');
      var head = el('div', 'item-card__head');
      head.appendChild(el('span', null, (idx + 1) + '品目目'));
      if (form.items.length > 1) {
        var rm = el('button', 'item-remove', 'この品目を消す'); rm.type = 'button';
        rm.onclick = function () { form.items.splice(idx, 1); renderItems(); };
        head.appendChild(rm);
      }
      card.appendChild(head);

      var sp = el('select', 'text-input select-input');
      fillSelect(sp, masters ? masters.products : [], it.product);
      sp.onchange = function () { it.product = sp.value; };
      card.appendChild(sp);

      var sc = el('select', 'text-input select-input');
      fillSelect(sc, masters ? masters.containers : [], it.container);
      sc.onchange = function () { it.container = sc.value; };
      card.appendChild(sc);

      var row = el('div', 'qty-row');
      var num = el('input', 'text-input text-input--number');
      num.type = 'text'; num.setAttribute('inputmode', 'numeric'); num.setAttribute('pattern', '[0-9]*');
      num.placeholder = '数'; num.value = it.amount;
      var note = el('div', 'qty-note');
      function refreshNote() {
        if (it.unit === 'case') {
          var q = core.toQty(it);
          note.textContent = q === null ? '1ケース＝' + core.CASE_SIZE + '本' : '＝ ' + q + '本（' + core.CASE_SIZE + '本×' + it.amount + 'ケース）';
        } else note.textContent = '';
      }
      num.oninput = function () { it.amount = num.value.replace(/[^0-9]/g, ''); if (num.value !== it.amount) num.value = it.amount; refreshNote(); };
      row.appendChild(num);
      var tg = el('div', 'unit-toggle');
      var bp = el('button', it.unit === 'piece' ? 'on' : '', '本'); bp.type = 'button';
      var bc = el('button', it.unit === 'case' ? 'on' : '', 'ケース'); bc.type = 'button';
      bp.onclick = function () { it.unit = 'piece'; bp.className = 'on'; bc.className = ''; refreshNote(); };
      bc.onclick = function () { it.unit = 'case'; bc.className = 'on'; bp.className = ''; refreshNote(); };
      tg.appendChild(bp); tg.appendChild(bc);
      row.appendChild(tg);
      card.appendChild(row);
      card.appendChild(note);
      refreshNote();
      box.appendChild(card);
    });
  }

  function renderForm() {
    $('in-date').value = form.date;
    $('in-partner').value = form.partner;
    $('in-recorder').value = form.recorder;
    var dl = $('partner-list'); dl.textContent = '';
    core.getPartners().forEach(function (p) { var o = el('option'); o.value = p; dl.appendChild(o); });
    renderChannels();
    renderItems();
    $('form-error').hidden = true;
  }

  function collectTop() {
    form.date = $('in-date').value;
    form.partner = $('in-partner').value;
    form.recorder = $('in-recorder').value;
  }

  function showNotice(msg) {
    var n = $('notice');
    n.hidden = !msg;
    n.textContent = msg || '';
  }

  // ── 確認 ──
  function toConfirm() {
    collectTop();
    if (!masters) { showFormError('銘柄・容器の一覧がまだ読み込めていません。電波のある所で設定画面から再取得してください'); return; }
    var errs = core.validate(form, masters);
    if (errs.length) { showFormError(errs[0]); return; }
    var ul = $('confirm-list'); ul.textContent = '';
    function row(label, value) {
      var li = el('li'); li.appendChild(el('span', 'confirm-label', label)); li.appendChild(el('span', 'confirm-value', value)); ul.appendChild(li);
    }
    row('日付', form.date);
    row('相手先', form.partner.trim());
    row('販路区分', form.channel);
    var total = 0;
    form.items.forEach(function (it, i) {
      var q = core.toQty(it); total += q;
      row('品目' + (i + 1), it.product + '　' + it.container + '　' + q + '本' + (it.unit === 'case' ? '（' + it.amount + 'ケース）' : ''));
    });
    row('合計', total + '本');
    row('記録者', form.recorder.trim());
    show('confirm');
  }
  function showFormError(msg) { var e = $('form-error'); e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'center' }); }

  // ── 送信 ──
  var sending = false;
  async function send() {
    if (sending) return;
    sending = true;
    try {
      if (form.date > todayLocal()) {
        if (!(await ask('日付が未来（' + form.date + '）です。このまま送りますか？'))) return;
      }
      var item = core.enqueue(form);
      updateBadge();
      var recorder = form.recorder.trim();
      resetForm(false); form.recorder = recorder;
      showResult('wait', '保存しました。表に入ったか確認しています…', '画面を閉じても大丈夫です。つながり次第、自動で送ります。');
      var res = await core.flush({
        onStatus: function (it, st) {
          if (it.uuid === item.uuid && st === 'sending') showResult('wait', '送信しています…', '表に入ったか確認します（最大1分ほど）');
        }
      });
      updateBadge();
      var inHistory = core.getHistory().some(function (h) { return h.uuid === item.uuid; });
      var q = core.getQueue().filter(function (x) { return x.uuid === item.uuid; })[0];
      if (inHistory) showResult('ok', '記録しました', '表に入ったことを確認しました。');
      else if (q && q.held) showResult('bad', '確認できませんでした', '再送はしていません。システム責任者（新居）に伝えてください。');
      else if (res.offline) showResult('wait', 'このスマホに保存しました', '電波がつながったら自動で送ります。履歴画面で状態を見られます。');
      else showResult('wait', '送信しました（確認待ち）', '表への反映は次に開いたとき確認します。');
    } finally {
      sending = false;
    }
  }
  function showResult(kind, title, msg) {
    $('result-icon').textContent = { ok: '✅', wait: '📨', bad: '⚠️' }[kind];
    $('result-title').textContent = title;
    $('result-message').textContent = msg;
    show('result');
  }

  // ── 履歴 ──
  function renderHistory() {
    var q = core.getQueue();
    var ql = $('queue-list'); ql.textContent = '';
    $('queue-empty-msg').hidden = q.length > 0;
    q.forEach(function (it) {
      var li = el('li', 'list-item');
      li.appendChild(el('span', null, it.summary));
      var st = it.held ? '⚠ 要確認（再送していません）' : it.status === 'sent' ? '📨 送信済み・着地の確認待ち' : '⏳ 未送信';
      li.appendChild(el('small', it.held ? 'state-bad' : 'state-warn', st));
      if (it.held) {
        var b = el('button', 'link-btn', '一覧から外す（表を確認した後に）'); b.type = 'button';
        b.onclick = async function () { if (await ask('表の「出庫」タブを確認しましたか？ 一覧から外します。')) { core.removeFromQueue(it.uuid); updateBadge(); renderHistory(); } };
        li.appendChild(b);
      }
      ql.appendChild(li);
    });
    var hl = $('history-list'); hl.textContent = '';
    core.getHistory().forEach(function (h) {
      var li = el('li', 'list-item');
      li.appendChild(el('span', null, h.summary));
      li.appendChild(el('small', 'state-ok', '✅ 表に入りました　' + String(h.sentAt || '').replace('T', ' ').slice(0, 16)));
      hl.appendChild(li);
    });
  }

  async function flushAndRefresh() {
    var res = await core.flush({});
    updateBadge();
    return res;
  }

  // ── 設定 ──
  function renderMastersStatus(src, err) {
    var t;
    if (!masters) t = '銘柄・容器：未取得' + (err ? '（' + err + '）' : '');
    else t = '銘柄 ' + masters.products.length + '件／容器 ' + masters.containers.length + '件（' + (src === 'live' ? '最新を取得' : '前回の保存分を使用中') + '）';
    $('masters-status').textContent = t;
  }
  async function refreshMasters() {
    var r = await core.loadMasters();
    if (r.masters) masters = r.masters;
    renderMastersStatus(r.source, r.error);
    showNotice(r.source === 'cache' ? '電波がないため、前回取得した銘柄・容器の一覧を使っています' :
               r.source === 'none' ? '銘柄・容器の一覧を取得できません。電波のある所で設定画面から再取得してください' : '');
    return r;
  }

  // ── 初期化 ──
  function bind() {
    $('btn-back').onclick = function () { if (current === 'confirm') show('form'); else { renderForm(); show('form'); } };
    $('btn-add-item').onclick = function () { form.items.push(newItem()); renderItems(); };
    $('btn-to-confirm').onclick = toConfirm;
    $('btn-confirm-back').onclick = function () { show('form'); };
    $('btn-confirm-send').onclick = function () { send(); };
    $('btn-result-again').onclick = function () { renderForm(); show('form'); };
    $('btn-goto-history').onclick = function () { renderHistory(); show('history'); };
    $('btn-goto-settings').onclick = function () { $('input-url').value = core.getUrl(); $('settings-msg').textContent = ''; renderMastersStatus('cache'); show('settings'); };
    $('btn-flush-now').onclick = async function () {
      $('flush-msg').textContent = '送信・確認しています…';
      var r = await flushAndRefresh();
      renderHistory();
      $('flush-msg').textContent = r.busy ? '別の送信が進行中です' : r.offline ? '電波がつながっていません' : '完了：確認済み ' + r.verified + '件／確認待ち ' + r.sent + '件／要確認 ' + r.held + '件';
    };
    $('btn-save-url').onclick = async function () {
      var u = $('input-url').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(u)) { $('settings-msg').textContent = 'URLの形が違います（https://script.google.com/macros/s/…/exec）'; return; }
      core.setUrl(u);
      $('settings-msg').textContent = '保存しました。銘柄・容器を取得しています…';
      var r = await refreshMasters();
      $('settings-msg').textContent = r.source === 'live' ? '保存しました。使えます。' : '保存しましたが、一覧を取得できませんでした：' + (r.error || '');
      if (r.source === 'live') { resetForm(true); renderForm(); setTimeout(function () { show('form'); }, 1200); }
    };
    $('btn-refresh-masters').onclick = async function () { await refreshMasters(); resetForm(true); renderForm(); };
    window.addEventListener('online', function () { flushAndRefresh(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { updateBadge(); flushAndRefresh(); } });
  }

  async function init() {
    bind();
    masters = core.getCachedMasters();
    resetForm(false);
    renderForm();
    updateBadge();
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 登録失敗でも動作継続 */ });
    }
    if (!core.getUrl()) { $('input-url').value = ''; show('settings'); $('settings-msg').textContent = '最初に送信先URLを入れてください'; return; }
    await refreshMasters();
    collectTop();                      // 入力途中の内容は消さずに、選択肢だけ差し替える
    form.items.forEach(function (it) { if (!it.container) it.container = newItem().container; });
    renderChannels();
    renderItems();
    flushAndRefresh();
  }

  window.__zoshi = { core: core };   // 動作確認用（URLやデータは含まない）
  init();
})();
