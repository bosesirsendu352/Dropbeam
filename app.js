/* DropBeam — peer-to-peer file transfer over WebRTC. No backend, no storage. */
(() => {
  'use strict';

  const CFG = window.DROPBEAM_CONFIG || {};
  const PREFIX = 'dropbeam-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I/O/0/1
  const CODE_LEN = 8;                                  // 40 bits of entropy
  const CHUNK = 64 * 1024;                             // per data-channel message
  const READ = 1024 * 1024;                            // per disk read
  const HIGH = 4 * 1024 * 1024;                        // pause sending above this buffered amount
  const LOW = 1024 * 1024;                             // resume below this
  const BIG = 100 * 1024 * 1024;                       // >= this: stream to disk when supported
  const MEM_WARN = 1024 * 1024 * 1024;
  const MAX_OFFERS = 500;

  const $ = (id) => document.getElementById(id);
  const J = JSON.stringify;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (label, cls, fn) => {
    const b = el('button', 'btn sm ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  /* ---------------- utilities ---------------- */

  function fmt(n) {
    if (!isFinite(n) || n < 0) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + ' ' + u[i];
  }

  function genCode() {
    const b = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return Array.from(b, (x) => ALPHABET[x & 31]).join(''); // 256 % 32 === 0 → no modulo bias
  }
  const normalize = (s) => String(s).toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, CODE_LEN);
  const pretty = (c) => (c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c);

  function cleanName(n) {
    n = String(n == null ? 'file' : n)
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .replace(/^\.+/, '_')
      .trim();
    if (n.length > 180) {
      const dot = n.lastIndexOf('.');
      const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
      n = n.slice(0, 180 - ext.length) + ext;
    }
    return n || 'file';
  }

  class Meter {
    constructor() { this.t = performance.now(); this.b = 0; this.speed = 0; }
    tick(bytes) {
      const now = performance.now();
      const dt = now - this.t;
      if (dt >= 400) {
        const inst = ((bytes - this.b) * 1000) / dt;
        this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
        this.t = now;
        this.b = bytes;
      }
      return this.speed;
    }
  }

  function peerOptions() {
    const o = Object.assign({ debug: 0 }, CFG.peer || {});
    if (Array.isArray(CFG.iceServers) && CFG.iceServers.length) o.config = { iceServers: CFG.iceServers };
    return o;
  }

  function errText(err) {
    switch (err && err.type) {
      case 'peer-unavailable': return 'No sender found with that code.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return "Can't reach the signaling server. Check your internet connection.";
      case 'webrtc': return 'Connection failed. Your network may block direct connections.';
      default: return (err && err.message) || 'Something went wrong.';
    }
  }

  /* ---------------- status, wake lock, unload guard ---------------- */

  function setStatus(state, text) {
    $('status').dataset.state = state;
    $('statusText').textContent = text;
  }

  let busyCount = 0;
  let wakeLock = null;
  async function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    try {
      if (busyCount > 0 && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (busyCount === 0 && wakeLock) {
        const w = wakeLock;
        wakeLock = null;
        await w.release();
      }
    } catch (_) { /* wake lock is best-effort */ }
  }
  window.addEventListener('beforeunload', (e) => {
    if (busyCount > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  function flash(b, text) {
    const old = b.textContent;
    b.textContent = text;
    setTimeout(() => { b.textContent = old; }, 1400);
  }
  async function copy(text, b) {
    try { await navigator.clipboard.writeText(text); flash(b, 'Copied'); }
    catch (_) { flash(b, 'Copy failed'); }
  }

  /* ---------------- file row widget ---------------- */

  function makeRow(name, size) {
    const li = el('li', 'file');
    const info = el('div', 'file-info');
    const n = el('span', 'file-name', name);
    n.title = name;
    const meta = el('span', 'file-meta', fmt(size));
    info.append(n, meta);
    const actions = el('div', 'file-actions');
    const bar = el('div', 'bar');
    const fill = el('i');
    bar.append(fill);
    li.append(info, actions, bar);
    return {
      li,
      set(text, state) { meta.textContent = text; li.dataset.state = state || ''; },
      progress(p) { fill.style.width = (Math.min(1, Math.max(0, p)) * 100).toFixed(1) + '%'; },
      buttons(...b) { actions.replaceChildren(...b); },
    };
  }

  /* ---------------- tabs ---------------- */

  function showTab(which) {
    const send = which === 'send';
    $('tabSend').setAttribute('aria-selected', String(send));
    $('tabRecv').setAttribute('aria-selected', String(!send));
    $('tabSend').tabIndex = send ? 0 : -1;
    $('tabRecv').tabIndex = send ? -1 : 0;
    $('panelSend').hidden = !send;
    $('panelRecv').hidden = send;
  }
  $('tabSend').addEventListener('click', () => showTab('send'));
  $('tabRecv').addEventListener('click', () => showTab('recv'));
  for (const t of [$('tabSend'), $('tabRecv')]) {
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const next = t === $('tabSend') ? 'recv' : 'send';
        showTab(next);
        $(next === 'send' ? 'tabSend' : 'tabRecv').focus();
      }
    });
  }

  /* =====================================================================
   * SENDER
   * Protocol (JSON strings on the data channel, raw binary for file data):
   *   R→S hello  S→R welcome | denied | busy
   *   S→R offer{id,name,size}   R→S accept{id} | reject{id}
   *   S→R <binary chunks…>      S→R done{id}   R→S ack{id}
   *   R→S cancel{id}            S→R abort{id}
   * ===================================================================== */

  const S = {
    peer: null, code: null, conn: null, pending: null,
    queue: [], nextId: 1, running: false, waiters: new Set(),
  };

  function startSender() {
    if (S.peer) return;
    setStatus('busy', 'connecting…');
    const open = (attempt) => {
      const code = genCode();
      let peer;
      try { peer = new window.Peer(PREFIX + code, peerOptions()); }
      catch (err) { sendError(errText(err)); return; }
      S.peer = peer;
      peer.on('open', () => {
        S.code = code;
        $('codeOut').textContent = pretty(code);
        $('shareBox').hidden = false;
        $('dropzone').classList.add('compact');
        $('dropTitle').textContent = 'Add more files';
        $('sendHint').textContent = 'Waiting for the receiver…';
        setStatus('online', 'ready');
      });
      peer.on('connection', onIncoming);
      peer.on('disconnected', () => {
        if (peer.destroyed) return;
        setStatus('busy', 'reconnecting…');
        try { peer.reconnect(); } catch (_) { /* ignore */ }
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && attempt < 5) {
          peer.destroy();
          S.peer = null;
          open(attempt + 1);
          return;
        }
        sendError(errText(err));
      });
    };
    open(0);
  }

  function sendError(msg) {
    setStatus('error', 'error');
    const h = $('sendHint');
    h.textContent = msg;
    h.classList.add('error');
    $('shareBox').hidden = false;
  }

  function showApprove(on) { $('approve').hidden = !on; }

  function onIncoming(conn) {
    if (S.conn || S.pending) {
      // Already serving one receiver: politely turn others away.
      conn.on('open', () => {
        try { conn.send(J({ t: 'busy' })); } catch (_) { /* ignore */ }
        setTimeout(() => { try { conn.close(); } catch (_) { /* ignore */ } }, 300);
      });
      return;
    }
    S.pending = conn;
    conn.on('data', (raw) => {
      if (typeof raw !== 'string' || raw.length > 4096) return;
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (conn === S.pending && m.t === 'hello') showApprove(true);
      else if (conn === S.conn) onSenderMsg(m);
    });
    conn.on('close', () => {
      if (S.pending === conn) { S.pending = null; showApprove(false); }
      if (S.conn === conn) onReceiverGone();
    });
    conn.on('error', () => { /* surfaced via close */ });
  }

  $('allowBtn').addEventListener('click', () => {
    const c = S.pending;
    if (!c || !c.open) { S.pending = null; showApprove(false); return; }
    S.pending = null;
    S.conn = c;
    showApprove(false);
    c.send(J({ t: 'welcome' }));
    setStatus('online', 'connected');
    $('sendHint').textContent = 'Receiver connected.';
    pump();
  });
  $('denyBtn').addEventListener('click', () => {
    const c = S.pending;
    S.pending = null;
    showApprove(false);
    if (c) {
      try { c.send(J({ t: 'denied' })); } catch (_) { /* ignore */ }
      setTimeout(() => { try { c.close(); } catch (_) { /* ignore */ } }, 300);
    }
  });

  function onReceiverGone() {
    S.conn = null;
    failWaiters(new Error('closed'));
    setStatus('online', 'ready');
    $('sendHint').textContent = 'Receiver disconnected. Share the code again to continue.';
  }

  function waitMsg(id, types) {
    return new Promise((resolve, reject) => S.waiters.add({ id, types, resolve, reject }));
  }
  function failWaiters(err) {
    for (const w of S.waiters) w.reject(err);
    S.waiters.clear();
  }
  function onSenderMsg(m) {
    if (m.t === 'cancel') {
      const item = S.queue.find((i) => i.id === m.id);
      if (item) item.cancelled = true;
    }
    for (const w of S.waiters) {
      if (w.id === m.id && w.types.includes(m.t)) { S.waiters.delete(w); w.resolve(m); return; }
    }
  }

  async function drain(dc) {
    while (dc.bufferedAmount > HIGH) {
      if (dc.readyState !== 'open') throw new Error('closed');
      await new Promise((res) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          res();
        };
        dc.bufferedAmountLowThreshold = LOW;
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
      });
    }
  }

  function addFiles(files) {
    if (!files.length) return;
    startSender();
    for (const f of files) {
      const item = { id: S.nextId++, file: f, state: 'queued', sent: 0, cancelled: false };
      item.ui = makeRow(f.name, f.size);
      item.ui.set(fmt(f.size) + ' · queued');
      item.ui.buttons(btn('✕', '', () => {
        if (item.state !== 'queued') return;
        S.queue = S.queue.filter((i) => i !== item);
        item.ui.li.remove();
      }));
      S.queue.push(item);
      $('sendList').append(item.ui.li);
    }
    if (S.conn) pump();
  }

  async function pump() {
    if (S.running || !S.conn) return;
    S.running = true;
    busy(true);
    const conn = S.conn;
    try {
      for (;;) {
        const item = S.queue.find((i) => i.state === 'queued');
        if (!item || S.conn !== conn || !conn.open) break;
        await sendItem(conn, item);
      }
    } catch (_) {
      const cur = S.queue.find((i) => i.state === 'offered' || i.state === 'sending');
      if (cur) { cur.state = 'error'; cur.ui.set('Interrupted — connection lost', 'error'); cur.ui.buttons(); }
    } finally {
      S.running = false;
      busy(false);
    }
    if (S.conn && S.queue.some((i) => i.state === 'queued')) pump();
  }

  async function sendItem(conn, item) {
    const f = item.file;
    const ui = item.ui;
    const dc = conn.dataChannel;
    item.state = 'offered';
    ui.set('Waiting for receiver to accept…', 'wait');
    ui.buttons();
    conn.send(J({ t: 'offer', id: item.id, name: f.name, size: f.size, mime: f.type || '' }));

    const reply = await waitMsg(item.id, ['accept', 'reject']);
    if (reply.t === 'reject') { item.state = 'rejected'; ui.set('Declined by receiver', 'error'); return; }

    item.state = 'sending';
    const meter = new Meter();
    let lastUI = 0;
    try {
      for (let off = 0; off < f.size && !item.cancelled;) {
        const end = Math.min(off + READ, f.size);
        const buf = await f.slice(off, end).arrayBuffer();
        for (let o = 0; o < buf.byteLength && !item.cancelled; o += CHUNK) {
          await drain(dc);
          if (!conn.open) throw new Error('closed');
          const len = Math.min(CHUNK, buf.byteLength - o);
          conn.send(new Uint8Array(buf, o, len));
          item.sent = off + o + len;
          const now = performance.now();
          if (now - lastUI > 120) {
            lastUI = now;
            const p = item.sent / f.size;
            ui.progress(p);
            ui.set(Math.floor(p * 100) + '% · ' + fmt(meter.tick(item.sent)) + '/s', '');
          }
        }
        off = end;
      }
    } catch (err) {
      if (!conn.open) throw err;
      try { conn.send(J({ t: 'abort', id: item.id })); } catch (_) { /* ignore */ }
      item.state = 'error';
      ui.set('Could not read this file', 'error');
      return;
    }

    if (item.cancelled) { item.state = 'cancelled'; ui.set('Cancelled by receiver', 'error'); return; }
    conn.send(J({ t: 'done', id: item.id }));
    const fin = await waitMsg(item.id, ['ack', 'cancel']);
    if (fin.t === 'cancel') { item.state = 'cancelled'; ui.set('Cancelled by receiver', 'error'); return; }
    item.state = 'done';
    ui.progress(1);
    ui.set('Sent · ' + fmt(f.size), 'done');
  }

  /* ---- send UI wiring ---- */

  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) =>
    dropzone.addEventListener(ev, () => dropzone.classList.remove('over')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const files = [];
    let skipped = 0;
    const items = e.dataTransfer && e.dataTransfer.items;
    if (items && items.length) {
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry && entry.isDirectory) { skipped++; continue; }
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    } else if (e.dataTransfer) {
      files.push(...e.dataTransfer.files);
    }
    addFiles(files);
    if (skipped) {
      startSender();
      const h = $('sendHint');
      h.classList.remove('error');
      h.textContent = 'Folders are not supported yet — zip them first.';
      $('shareBox').hidden = !S.code;
    }
  });
  // Don't let a missed drop navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('copyCode').addEventListener('click', (e) => { if (S.code) copy(pretty(S.code), e.currentTarget); });
  $('copyLink').addEventListener('click', (e) => {
    if (S.code) copy(location.origin + location.pathname + '#r=' + S.code, e.currentTarget);
  });

  /* =====================================================================
   * RECEIVER
   * ===================================================================== */

  const R = { peer: null, conn: null, cur: null, entries: new Map(), joined: false };
  const canStream = typeof window.showSaveFilePicker === 'function';

  function recvHint(msg, isError) {
    const h = $('recvHint');
    h.textContent = msg || '';
    h.classList.toggle('error', !!isError);
  }

  function leaveRecv() {
    R.joined = false;
    if (R.cur) { releaseBusy(R.cur); R.cur = null; }
    try { if (R.conn) R.conn.close(); } catch (_) { /* ignore */ }
    try { if (R.peer) R.peer.destroy(); } catch (_) { /* ignore */ }
    R.peer = R.conn = null;
  }

  function releaseBusy(e) { if (e.busy) { e.busy = false; busy(false); } }

  function recvFail(msg) {
    recvHint(msg, true);
    setStatus('error', 'error');
    $('joinBtn').disabled = false;
    leaveRecv();
  }

  function join(rawCode) {
    const code = normalize(rawCode);
    if (code.length !== CODE_LEN) { recvHint('Enter the full 8-character code.', true); return; }
    leaveRecv();
    recvHint('Connecting…');
    setStatus('busy', 'connecting…');
    $('joinBtn').disabled = true;

    let peer;
    try { peer = new window.Peer(peerOptions()); }
    catch (err) { recvFail(errText(err)); return; }
    R.peer = peer;

    peer.on('error', (err) => recvFail(errText(err)));
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
      R.conn = conn;
      const timer = setTimeout(() => {
        if (!conn.open) recvFail('Could not reach the sender. Check the code and try again.');
      }, 20000);
      conn.on('open', () => {
        clearTimeout(timer);
        conn.send(J({ t: 'hello', v: 1 }));
        recvHint('Waiting for the sender to approve…');
      });
      conn.on('data', onRecvData);
      conn.on('close', () => {
        clearTimeout(timer);
        if (R.conn !== conn) return;
        if (R.cur) failEntry(R.cur, 'Connection lost');
        if (R.joined) {
          R.joined = false;
          recvHint('Sender disconnected.', true);
          setStatus('idle', 'disconnected');
          $('joinBtn').disabled = false;
        }
      });
      conn.on('error', () => { /* surfaced via close */ });
    });
  }

  function onRecvData(d) {
    if (typeof d === 'string') { onRecvCtl(d); return; }
    const e = R.cur;
    if (!e) return;
    let buf = null;
    if (d instanceof ArrayBuffer) buf = d;
    else if (d && d.buffer instanceof ArrayBuffer) buf = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    if (!buf) return;
    if (e.received + buf.byteLength > e.size) { cancelEntry(e, 'Sender sent more data than declared'); return; }
    e.received += buf.byteLength;
    if (e.writable) e.chain = e.chain.then(() => e.writable.write(buf));
    else e.parts.push(buf);
    const now = performance.now();
    if (now - e.lastUI > 120) {
      e.lastUI = now;
      const p = e.size ? e.received / e.size : 1;
      e.ui.progress(p);
      e.ui.set(Math.floor(p * 100) + '% · ' + fmt(e.meter.tick(e.received)) + '/s', '');
    }
  }

  function onRecvCtl(raw) {
    if (raw.length > 4096) return;
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome':
        R.joined = true;
        recvHint('Connected. Waiting for files…');
        setStatus('online', 'connected');
        $('joinBtn').disabled = true;
        break;
      case 'denied': recvFail('The sender declined the connection.'); break;
      case 'busy': recvFail('That sender is already connected to another device.'); break;
      case 'offer': onOffer(m); break;
      case 'done': finishEntry(m.id); break;
      case 'abort': {
        const e = R.entries.get(m.id);
        if (e && R.cur === e) failEntry(e, 'Sender stopped the transfer');
        break;
      }
      default: break;
    }
  }

  function onOffer(m) {
    const ok = Number.isInteger(m.id) && Number.isFinite(m.size) && m.size >= 0;
    if (!ok || !R.joined || R.cur || R.entries.size >= MAX_OFFERS || R.entries.has(m.id)) {
      if (Number.isInteger(m.id) && R.conn && R.conn.open) R.conn.send(J({ t: 'reject', id: m.id }));
      return;
    }
    const e = {
      id: m.id, name: cleanName(m.name), size: m.size, state: 'pending',
      received: 0, parts: [], writable: null, chain: Promise.resolve(),
      blob: null, busy: false, lastUI: 0, meter: new Meter(),
    };
    e.ui = makeRow(e.name, e.size);
    R.entries.set(e.id, e);
    $('recvList').append(e.ui.li);

    if ($('autoAccept').checked && e.size < BIG) { accept(e); return; }
    let note = fmt(e.size) + ' · incoming';
    if (e.size >= BIG && !canStream) {
      note += e.size >= MEM_WARN ? ' · large: this browser buffers in memory (Chrome/Edge can stream to disk)' : ' · buffered in memory';
    }
    e.ui.set(note, 'wait');
    e.ui.buttons(
      btn('Accept', 'primary', () => accept(e)),
      btn('Decline', '', () => decline(e)),
    );
  }

  function decline(e) {
    if (R.conn && R.conn.open) R.conn.send(J({ t: 'reject', id: e.id }));
    e.state = 'declined';
    e.ui.set('Declined', 'error');
    e.ui.buttons(btn('Clear', '', () => clearEntry(e)));
  }

  async function accept(e) {
    if (R.cur || e.state !== 'pending') return;
    let writable = null;
    if (e.size >= BIG && canStream) {
      try { // must be the first await so the click's user activation is still valid
        const h = await window.showSaveFilePicker({ suggestedName: e.name });
        writable = await h.createWritable();
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled the save dialog; offer stays pending
        writable = null; // fall back to in-memory
      }
    }
    if (R.cur || e.state !== 'pending' || !R.conn || !R.conn.open) {
      if (writable) { try { await writable.abort(); } catch (_) { /* ignore */ } }
      return;
    }
    e.writable = writable;
    e.state = 'receiving';
    e.busy = true;
    busy(true);
    R.cur = e;
    e.ui.set('0% · starting…', '');
    e.ui.buttons(btn('Cancel', '', () => cancelEntry(e, 'Cancelled', true)));
    R.conn.send(J({ t: 'accept', id: e.id }));
  }

  async function cancelEntry(e, why, notifySender) {
    if (R.cur !== e) return;
    R.cur = null;
    releaseBusy(e);
    e.state = 'cancelled';
    e.parts = [];
    if (e.writable) { try { await e.writable.abort(); } catch (_) { /* ignore */ } e.writable = null; }
    if (notifySender !== false && R.conn && R.conn.open) R.conn.send(J({ t: 'cancel', id: e.id }));
    e.ui.set(why, 'error');
    e.ui.buttons(btn('Clear', '', () => clearEntry(e)));
  }

  async function failEntry(e, why) {
    if (R.cur === e) R.cur = null;
    releaseBusy(e);
    e.state = 'error';
    e.parts = [];
    if (e.writable) { try { await e.writable.abort(); } catch (_) { /* ignore */ } e.writable = null; }
    e.ui.set(why, 'error');
    e.ui.buttons(btn('Clear', '', () => clearEntry(e)));
  }

  async function finishEntry(id) {
    const e = R.cur;
    if (!e || e.id !== id) return;
    if (e.received !== e.size) { failEntry(e, 'Incomplete transfer'); return; }
    try {
      await e.chain;
      if (e.writable) await e.writable.close();
    } catch (_) { failEntry(e, 'Could not write the file'); return; }
    R.cur = null;
    releaseBusy(e);
    e.state = 'done';
    e.ui.progress(1);
    if (e.writable) {
      e.writable = null;
      e.ui.set('Saved · ' + fmt(e.size), 'done');
      e.ui.buttons(btn('Clear', '', () => clearEntry(e)));
    } else {
      e.blob = new Blob(e.parts, { type: 'application/octet-stream' });
      e.parts = [];
      e.ui.set('Received · ' + fmt(e.size), 'done');
      e.ui.buttons(btn('Save', 'primary', () => saveBlob(e)), btn('Clear', '', () => clearEntry(e)));
    }
    if (R.conn && R.conn.open) R.conn.send(J({ t: 'ack', id: e.id }));
  }

  function saveBlob(e) {
    if (!e.blob) return;
    const url = URL.createObjectURL(e.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = e.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function clearEntry(e) {
    e.blob = null;
    e.parts = [];
    R.entries.delete(e.id);
    e.ui.li.remove();
  }

  /* ---- receive UI wiring ---- */

  const codeIn = $('codeIn');
  codeIn.addEventListener('input', () => {
    const pos = codeIn.selectionStart;
    const before = codeIn.value.length;
    codeIn.value = pretty(normalize(codeIn.value));
    if (pos != null && pos < before) codeIn.setSelectionRange(pos, pos);
  });
  $('joinForm').addEventListener('submit', (e) => { e.preventDefault(); join(codeIn.value); });

  /* ---------------- boot ---------------- */

  if (!window.RTCPeerConnection || !window.Peer || !window.crypto || !crypto.getRandomValues) {
    $('app').hidden = true;
    $('unsupported').hidden = false;
    setStatus('error', 'unsupported');
    return;
  }

  // Link to the source repo when hosted on GitHub Pages (user.github.io/repo/).
  if (/\.github\.io$/i.test(location.hostname)) {
    const user = location.hostname.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
    const a = $('srcLink');
    a.href = 'https://github.com/' + encodeURIComponent(user) + '/' + encodeURIComponent(repo);
    a.hidden = false;
  }

  // Share links look like  https://host/path/#r=ABCD2345  (the hash is never sent to any server).
  const m = /[#&]r=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    const code = normalize(m[1]);
    if (code.length === CODE_LEN) {
      showTab('recv');
      codeIn.value = pretty(code);
      join(code);
    }
  }
})();
