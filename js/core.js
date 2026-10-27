// ============================================================
// core.js — 蔵置所 出庫記録アプリの中核ロジック（画面に依存しない）
//   ・マスター取得とキャッシュ
//   ・入力の検査／キュー保存
//   ・送信方式v2（Ponkichi入力アプリ要件定義書 §6-2 を流用）
//       「fetchの成否は配達の証拠にならない。着地は読み戻して判定する」
//       pending → sent → verified（履歴へ）／ held（要確認・自動再送しない）
//   ブラウザでもNodeでも動く（テストのため環境を差し込める）。
// ============================================================
(function (root) {
  'use strict';

  var CASE_SIZE = 24;                       // 1ケース＝24本
  var POST_ABORT_MS = 3000;                 // no-cors POSTは応答が読めないので短く打ち切る（送信自体は届く）
  var MAX_VERIFY_ATTEMPTS = 3;              // 起動3回分照合しても不明ならheld
  var KEYS = {
    URL: 'zoshi_gas_url',
    MASTERS: 'zoshi_masters_cache',
    QUEUE: 'zoshi_queue',
    HISTORY: 'zoshi_history',
    LAST_RECORDER: 'zoshi_last_recorder',
    PARTNERS: 'zoshi_partner_candidates'
  };

  function create(env) {
    var storage = env.storage;
    var doFetch = env.fetch;
    var sleep = env.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var newUuid = env.uuid;
    var nowIso = env.now || function () { return new Date().toISOString(); };
    var verifyDelays = env.verifyDelays || [5000, 15000, 60000];
    var flushing = false;

    function getJSON(key, fb) {
      var raw = storage.getItem(key);
      if (raw === null || raw === undefined) return fb;
      try { return JSON.parse(raw); } catch (e) { return fb; }
    }
    function setJSON(key, obj) { storage.setItem(key, JSON.stringify(obj)); }

    // ── 設定 ──
    function getUrl() { return (storage.getItem(KEYS.URL) || '').trim(); }
    function setUrl(u) { storage.setItem(KEYS.URL, String(u || '').trim()); }
    function endpoint(params) {
      var base = getUrl().replace(/\/$/, '');
      var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
      return base + '?' + qs;
    }

    // ── マスター ──
    function getCachedMasters() { return getJSON(KEYS.MASTERS, null); }
    // 戻り値：{ masters, source:'live'|'cache'|'none', error }
    async function loadMasters() {
      if (!getUrl()) return { masters: getCachedMasters(), source: 'none', error: '送信先URL未設定' };
      try {
        var res = await doFetch(endpoint({ action: 'masters' }), { method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var j = await res.json();
        if (!j || j.success !== true || !Array.isArray(j.products) || !Array.isArray(j.containers) || !Array.isArray(j.channels)
            || !j.products.length || !j.containers.length) {
          throw new Error((j && j.error) || 'マスターの応答が不正です');
        }
        var m = { fetchedAt: nowIso(), products: j.products, containers: j.containers, channels: j.channels, stale: !!j.stale };
        setJSON(KEYS.MASTERS, m);
        return { masters: m, source: 'live', error: null };
      } catch (err) {
        var c = getCachedMasters();
        return { masters: c, source: c ? 'cache' : 'none', error: String(err && err.message || err) };
      }
    }

    // ── 入力の検査 ──
    function toQty(item) {
      var n = Number(item.amount);
      if (!isFinite(n) || n !== Math.floor(n) || n < 1) return null;
      return item.unit === 'case' ? n * CASE_SIZE : n;
    }
    // rec: { date, partner, channel, recorder, items:[{product, container, amount, unit:'piece'|'case'}] }
    function validate(rec, masters) {
      var errs = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '')) errs.push('日付を入れてください');
      if (!String(rec.partner || '').trim()) errs.push('相手先を入れてください');
      if (!rec.channel) errs.push('販路区分を選んでください');
      else if (masters && masters.channels.indexOf(rec.channel) === -1) errs.push('販路区分が不正です');
      if (!String(rec.recorder || '').trim()) errs.push('記録者を入れてください');
      if (!rec.items || rec.items.length < 1) errs.push('品目を1件以上入れてください');
      (rec.items || []).forEach(function (it, i) {
        var n = (i + 1) + '品目目：';
        if (!it.product) errs.push(n + '銘柄を選んでください');
        else if (masters && masters.products.indexOf(it.product) === -1) errs.push(n + '銘柄が不正です');
        if (!it.container) errs.push(n + '容器を選んでください');
        else if (masters && masters.containers.indexOf(it.container) === -1) errs.push(n + '容器が不正です');
        var q = toQty(it);
        if (q === null) errs.push(n + '本数は1以上の整数で入れてください');
        else if (q > 9999) errs.push(n + '本数が多すぎます');
      });
      return errs;
    }

    function buildPayload(rec, uuid) {
      return {
        record_id: uuid,
        date: rec.date,
        partner: String(rec.partner).trim(),
        channel: rec.channel,
        recorder: String(rec.recorder).trim(),
        items: rec.items.map(function (it) { return { product: it.product, container: it.container, qty: toQty(it) }; })
      };
    }
    function summaryOf(p) {
      var total = p.items.reduce(function (s, it) { return s + it.qty; }, 0);
      return p.date + ' ' + p.partner + '（' + p.channel + '）' + p.items.length + '品目 計' + total + '本';
    }
    function tokenOf(item) { return String(item.uuid).slice(0, 8).toLowerCase(); }

    // ── キュー ──
    function getQueue() { return getJSON(KEYS.QUEUE, []); }
    function setQueue(q) { setJSON(KEYS.QUEUE, q); }
    function getHistory() { return getJSON(KEYS.HISTORY, []); }
    function pushHistory(h) {
      var list = getHistory();
      list.unshift(h);
      setJSON(KEYS.HISTORY, list.slice(0, 20));
    }

    function enqueue(rec) {
      var uuid = newUuid();
      var payload = buildPayload(rec, uuid);
      var item = {
        uuid: uuid, payload: payload, summary: summaryOf(payload), createdAt: nowIso(),
        status: 'pending', verifyAttempts: 0, attempts: 0, held: false, lastError: null
      };
      var q = getQueue();
      q.push(item);
      setQueue(q);
      storage.setItem(KEYS.LAST_RECORDER, payload.recorder);
      rememberPartner(payload.partner);
      return item;
    }

    function getLastRecorder() { return storage.getItem(KEYS.LAST_RECORDER) || ''; }
    function getPartners() { return getJSON(KEYS.PARTNERS, []); }
    function rememberPartner(name) {
      var list = getPartners().filter(function (x) { return x !== name; });
      list.unshift(name);
      setJSON(KEYS.PARTNERS, list.slice(0, 40));
    }

    // ── 送信 ──
    // 伝票番号の着地確認。戻り値：着地している伝票番号の配列／読めなければ null（＝判定不能）
    async function fetchLanded(token) {
      try {
        var res = await doFetch(endpoint({ action: 'check', token: token }), { method: 'GET' });
        if (!res.ok) return null;
        var j = await res.json();
        if (!j || j.success !== true || !Array.isArray(j.found)) return null;
        return j.found;
      } catch (e) { return null; }
    }
    function allLanded(item, found) {
      var t = tokenOf(item);
      for (var i = 1; i <= item.payload.items.length; i++) {
        if (found.indexOf(t + '-' + i) === -1) return false;
      }
      return true;
    }

    // 1件をno-corsでPOST。応答は読めない前提で、結果は一切判定に使わない。
    async function firePost(item) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, POST_ABORT_MS) : null;
      try {
        await doFetch(getUrl(), {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(item.payload),
          signal: ctrl ? ctrl.signal : undefined
        });
      } catch (e) {
        // ⚠ 失敗しても「届いていない」証拠にはならない。何もしない（再送判断は読み戻しのみ）。
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function markVerified(item) {
      pushHistory({ uuid: item.uuid, token: tokenOf(item), summary: item.summary, status: 'verified', sentAt: nowIso() });
    }

    // キューを古い順に処理。戻り値：{ verified, sent, held, remaining, offline, busy, lastError }
    // opts.onStatus(item, statusText) で進行を通知する。
    async function flush(opts) {
      opts = opts || {};
      var notify = opts.onStatus || function () {};
      if (flushing) return { verified: 0, sent: 0, held: 0, remaining: getQueue().length, offline: false, busy: true, lastError: null };
      flushing = true;
      try {
        var queue = getQueue();
        if (!getUrl() || queue.length === 0) {
          return { verified: 0, sent: 0, held: 0, remaining: queue.length, offline: false, busy: false,
                   lastError: getUrl() ? null : '送信先URL未設定' };
        }
        var verified = 0, sentCount = 0, heldCount = 0;
        var stillQueued = [];
        var offline = false;

        for (var i = 0; i < queue.length; i++) {
          var item = queue[i];
          if (offline) { stillQueued.push(item); continue; }
          if (item.held) { heldCount += 1; stillQueued.push(item); continue; }
          var token = tokenOf(item);

          // 手順1：送信前に読み戻す（冪等ガード）。読めなければ送らない。
          var found = await fetchLanded(token);
          if (found === null) { offline = true; stillQueued.push(item); continue; }
          if (allLanded(item, found)) {
            markVerified(item); verified += 1; notify(item, 'verified'); continue;
          }

          // 台帳に無いと確認できた場合のみPOSTしてよい
          item.attempts = (item.attempts || 0) + 1;
          item.lastAttemptAt = nowIso();
          notify(item, 'sending');
          await firePost(item);
          item.status = 'sent';
          setQueue(stillQueued.concat(queue.slice(i)));    // 送信済みの印を保存（途中で閉じられても二重送信しない）

          // 手順3：3段階で読み戻し照合
          var landed = false;
          for (var d = 0; d < verifyDelays.length; d++) {
            await sleep(verifyDelays[d]);
            var f2 = await fetchLanded(token);
            if (f2 === null) break;            // 判定不能：sentのまま保持
            if (allLanded(item, f2)) { landed = true; break; }
          }
          if (landed) { markVerified(item); verified += 1; notify(item, 'verified'); continue; }

          item.verifyAttempts = (item.verifyAttempts || 0) + 1;
          if (item.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
            item.held = true; item.status = 'held';
            item.lastError = '送信したが表への着地を確認できませんでした（自動再送はしていません）';
            heldCount += 1; notify(item, 'held');
          } else {
            sentCount += 1; notify(item, 'sent');
          }
          stillQueued.push(item);
        }
        setQueue(stillQueued);
        return { verified: verified, sent: sentCount, held: heldCount, remaining: stillQueued.length,
                 offline: offline, busy: false, lastError: offline ? '表に接続できませんでした（オフラインの可能性）' : null };
      } finally {
        flushing = false;
      }
    }

    function queueStats() {
      var q = getQueue(), pending = 0, sent = 0, held = 0;
      q.forEach(function (it) {
        if (it.held || it.status === 'held') held += 1;
        else if (it.status === 'sent') sent += 1;
        else pending += 1;
      });
      return { pending: pending, sent: sent, held: held, total: q.length };
    }

    function removeFromQueue(uuid) {
      setQueue(getQueue().filter(function (it) { return it.uuid !== uuid; }));
    }

    return {
      CASE_SIZE: CASE_SIZE, KEYS: KEYS,
      getUrl: getUrl, setUrl: setUrl, loadMasters: loadMasters, getCachedMasters: getCachedMasters,
      validate: validate, toQty: toQty, buildPayload: buildPayload, summaryOf: summaryOf, tokenOf: tokenOf,
      enqueue: enqueue, flush: flush, getQueue: getQueue, getHistory: getHistory, queueStats: queueStats,
      removeFromQueue: removeFromQueue, getLastRecorder: getLastRecorder, getPartners: getPartners
    };
  }

  var api = { create: create, CASE_SIZE: CASE_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoshiCore = api;
})(typeof window !== 'undefined' ? window : this);
