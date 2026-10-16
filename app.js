const RESISTANCE = ['dumbbell', 'body weight', 'cable', 'machine', 'other'];
let allWorkouts = {};
let currentRun = null; // { name, planned, ids: Set of requestIds logged in this run }
let editingName = null; // name of the workout open in the editor, or null for a new one

// ---------- small helpers for saved data on this phone ----------
function getKey() {
  try { return localStorage.getItem('wt_key') || ''; } catch (e) { return ''; }
}

function readJSON(name, fallback) {
  try { return JSON.parse(localStorage.getItem(name)) || fallback; } catch (e) { return fallback; }
}

function writeJSON(name, value) {
  try { localStorage.setItem(name, JSON.stringify(value)); return true; } catch (e) { return false; }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- talking to the Apps Script backend ----------
async function api(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // give up after 30 seconds
  let text;
  try {
    // text/plain keeps this a "simple" request, so the browser skips the CORS preflight
    // that Apps Script can't answer.
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: getKey(), action: action }, payload || {})),
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('The server sent an unexpected reply.'); }
  if (!json.ok) {
    if (json.error === 'Bad key') { showSetup('That key was not accepted. Check it and try again.'); }
    const err = new Error(json.error);
    err.server = true; // the server answered properly, so retrying would not help
    throw err;
  }
  return json.data;
}

// ---------- background save queue for logged sets ----------
// Tapping Log marks the set done instantly and puts it in this queue.
// The queue is kept on the phone, so nothing is lost if the connection drops
// or the app is closed. Each set has a requestId, so the backend ignores repeats.
const QUEUE_KEY = 'wt_queue';
let flushing = false;
let syncProblem = '';      // empty = fine, otherwise the text to show
let retryTimer = null;
let hideTimer = null;

function loadQueue() { return readJSON(QUEUE_KEY, []); }
function saveQueue(q) { writeJSON(QUEUE_KEY, q); }

function enqueueSet(item) {
  const q = loadQueue();
  q.push(item);
  saveQueue(q);
  updateSyncStatus();
  flushQueue();
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  syncProblem = '';
  updateSyncStatus();
  let sentAny = false;
  try {
    while (loadQueue().length > 0) {
      const item = loadQueue()[0];
      try {
        await api('logSet', item);
      } catch (err) {
        if (err.message === 'Bad key') return; // the key screen is showing; sets stay queued
        syncProblem = err.server ? 'Could not save: ' + err.message : 'Offline';
        updateSyncStatus();
        if (!err.server) retryTimer = setTimeout(flushQueue, 8000); // try again soon
        return;
      }
      const q = loadQueue();
      q.shift();
      saveQueue(q);
      sentAny = true;
      updateSyncStatus();
    }
    updateSyncStatus(sentAny);
  } finally {
    flushing = false;
  }
}

function updateSyncStatus(justFinished) {
  if (!document.getElementById('finishView').classList.contains('hidden')) renderFinish();
  const el = document.getElementById('syncStatus');
  const n = loadQueue().length;
  clearTimeout(hideTimer);
  if (n === 0) {
    if (justFinished) {
      el.className = 'sync ok';
      el.textContent = 'All saved ✓';
      hideTimer = setTimeout(() => { el.className = 'sync hidden'; }, 2000);
    } else {
      el.className = 'sync hidden';
    }
    return;
  }
  const noun = n === 1 ? '1 set' : n + ' sets';
  if (syncProblem) {
    el.className = 'sync err';
    el.textContent = syncProblem + ' · ' + noun + ' waiting · tap to retry';
  } else {
    el.className = 'sync pending';
    el.textContent = 'Saving ' + noun + '…';
  }
}

window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && loadQueue().length > 0) flushQueue();
});

// ---------- iPhone Home Screen app: fix the screen height after typing ----------
// iOS bug: after the keyboard has been used in a Home Screen app, the page keeps thinking the screen
// is shorter (59px on your phone), so the tab bar floats above the bottom. We try several ways to
// make iOS measure the screen again, stop at the first one that works, and remember it.
let maxInnerH = 0, lastInnerW = 0, healCount = 0, healFails = 0, healTimer = null, healing = false;
const healLog = {}; // which methods were tried and whether they worked

function viewportShrunk() {
  if (!navigator.standalone) return false;                    // only Home Screen apps have this bug
  if (window.innerWidth !== lastInnerW) { lastInnerW = window.innerWidth; maxInnerH = 0; } // rotated
  maxInnerH = Math.max(maxInnerH, window.innerHeight);
  let full = maxInnerH;
  if (window.innerHeight > window.innerWidth) full = Math.max(full, screen.height); // portrait
  return full - window.innerHeight > 4;
}

const HEALERS = [
  { id: 'A', run: done => {                                   // redo the page layout
      document.getElementById('healer').style.display = 'none';
      document.body.style.display = 'none';
      void document.body.offsetHeight;
      document.body.style.display = '';
      document.getElementById('healer').style.display = '';
      done();
  } },
  { id: 'B', run: done => {                                   // re-apply the screen settings
      const m = document.querySelector('meta[name="viewport"]');
      if (!m) { done(); return; }
      const orig = m.getAttribute('content');
      m.setAttribute('content', 'width=device-width, initial-scale=1');
      setTimeout(() => { m.setAttribute('content', orig); done(); }, 80);
  } },
  { id: 'C', run: done => {                                   // nudge the page height
      const de = document.documentElement;
      de.style.height = 'calc(100% + 1px)';
      void de.offsetHeight;
      de.style.height = '';
      done();
  } },
  { id: 'D', run: done => {                                   // nudge the scroll position
      window.scrollTo(0, 1);
      setTimeout(() => { window.scrollTo(0, 0); done(); }, 60);
  } }
];

function healViewport() {
  if (healing) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return; // keyboard is up
  if (!viewportShrunk()) { healFails = 0; return; }
  if (healFails >= 2) return;                                 // nothing worked twice; stop trying
  healing = true;
  healCount++;
  const y = window.pageYOffset;
  let pref = '';
  try { pref = localStorage.getItem('wt_heal') || ''; } catch (e) {}
  const order = HEALERS.slice().sort((p, q) => (q.id === pref) - (p.id === pref)); // best-known first
  let i = 0;
  const next = () => {
    if (i >= order.length) { healing = false; healFails++; return; }
    const h = order[i++];
    h.run(() => setTimeout(() => {
      if (!viewportShrunk()) {
        healLog[h.id] = 'worked';
        try { localStorage.setItem('wt_heal', h.id); } catch (e) {}
        healing = false; healFails = 0;
        window.scrollTo(0, y);
      } else {
        healLog[h.id] = 'no';
        next();
      }
    }, 120));
  };
  next();
}

function scheduleHeal(delay) {
  clearTimeout(healTimer);
  healTimer = setTimeout(healViewport, delay || 200);
}

document.addEventListener('focusout', () => scheduleHeal(250));
window.addEventListener('resize', () => scheduleHeal(250));
window.addEventListener('pageshow', () => scheduleHeal(100));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleHeal(100);
});

// ---------- Home Screen app: keep the page slightly taller than the screen ----------
// On iPhones, a Home Screen app whose page is no taller than the screen can end up with the tab bar
// floating above the bottom (iOS measures the screen 59px too short). Found with the bar test: the bar
// sat correctly at the bottom exactly while the page was taller than the screen. So in the Home Screen
// app we keep the page just taller than the screen. It only exists to make iOS place things correctly.
function applyStandaloneHeight() {
  if (!navigator.standalone) return;
  const portrait = window.innerHeight > window.innerWidth;
  const longSide = Math.max(screen.width, screen.height);
  document.body.style.minHeight = portrait ? (longSide + 2) + 'px' : '';
}
applyStandaloneHeight();
window.addEventListener('resize', applyStandaloneHeight);
window.addEventListener('orientationchange', applyStandaloneHeight);
window.addEventListener('pageshow', applyStandaloneHeight);

// ---------- switching screens ----------
const TAB_VIEWS = { list: 'listView', history: 'historyView', progress: 'progressView' };
const ALL_VIEWS = ['setupView', 'listView', 'historyView', 'progressView', 'builderView', 'runView'];

function showOnly(id) {
  ALL_VIEWS.forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
  // the tab bar is only shown on the three main tabs
  const isTab = Object.keys(TAB_VIEWS).some(t => TAB_VIEWS[t] === id);
  document.getElementById('tabBar').classList.toggle('hidden', !isTab);
  document.body.classList.toggle('has-tabs', isTab);
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', TAB_VIEWS[t.dataset.tab] === id);
  });
  if (isTab) scheduleHeal(60);
  if (id === 'historyView') showLayoutInfo();
  window.scrollTo(0, 0);
}

// TEMPORARY: measures the screen so we can find out why the tab bar floats above the bottom.
function showLayoutInfo() {
  const out = document.getElementById('layoutInfo');
  if (!out) return;
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;' +
      'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const safeTop = cs.paddingTop, safeBottom = cs.paddingBottom;
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;height:100lvh';
    const lvh = probe.offsetHeight;
    probe.style.height = '100dvh';
    const dvh = probe.offsetHeight;
    document.body.removeChild(probe);
    const bar = document.getElementById('tabBar').getBoundingClientRect();
    const tried = Object.keys(healLog).map(k => k + ' ' + healLog[k]).join(' · ') || 'none yet';
    out.textContent = 'Layout readout: screen ' + screen.width + 'x' + screen.height +
      ' · window ' + window.innerWidth + 'x' + window.innerHeight +
      ' · bar bottom ' + Math.round(bar.bottom) +
      ' · safe top/bottom ' + safeTop + '/' + safeBottom +
      ' · app mode ' + (navigator.standalone ? 'yes' : 'no') +
      ' · tallest seen ' + maxInnerH + ' · fix rounds ' + healCount +
      ' · lvh ' + lvh + ' · dvh ' + dvh +
      ' · page height ' + document.documentElement.scrollHeight +
      ' · fixes tried: ' + tried;
  } catch (e) {
    out.textContent = 'Layout readout unavailable';
  }
}

function showTab(tab) {
  showOnly(TAB_VIEWS[tab]);
  if (tab === 'list') loadList();
}

function showList() { showTab('list'); }

function showSetup(message) {
  showOnly('setupView');
  document.getElementById('keyInput').value = '';
  document.getElementById('setupMsg').textContent = message || '';
}

function saveKey() {
  const key = document.getElementById('keyInput').value.trim();
  if (!key) return;
  try { localStorage.setItem('wt_key', key); } catch (e) {}
  showList();
  if (loadQueue().length > 0) flushQueue();
}

// Opens the editor. With a name it shows that saved workout; without one it starts a new workout.
function showEditor(name) {
  editingName = name || null;
  showOnly('builderView');
  document.getElementById('builderTitle').textContent = name ? 'Edit Workout' : 'New Workout';
  document.getElementById('builderSave').textContent = name ? 'Save changes' : 'Save workout';
  document.getElementById('workoutName').value = name || '';
  document.getElementById('exerciseRows').textContent = '';
  document.getElementById('builderMsg').textContent = '';
  if (name && allWorkouts[name]) {
    allWorkouts[name].forEach(ex => addRow(ex));
  } else {
    addRow();
  }
}

// ---------- library (workout list) ----------
// Shows the last known list instantly, then refreshes it from the Sheet in the background.
function loadList() {
  const list = document.getElementById('list');
  const cached = readJSON('wt_workouts', null);
  if (cached) {
    renderList(cached);
  } else {
    // placeholder cards instead of a plain "Loading..."
    list.textContent = '';
    for (let i = 0; i < 2; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      list.appendChild(sk);
    }
  }
  api('getWorkouts')
    .then(fresh => {
      writeJSON('wt_workouts', fresh);
      if (!cached || JSON.stringify(fresh) !== JSON.stringify(cached)) renderList(fresh);
    })
    .catch(err => {
      if (err.message === 'Bad key') return;
      if (!cached) list.textContent = 'Error: ' + err.message;
    });
}

function renderList(workouts) {
  allWorkouts = workouts;
  const list = document.getElementById('list');
  list.textContent = '';
  const names = Object.keys(workouts);
  if (names.length === 0) {
    list.textContent = 'No workouts yet.';
    list.style.marginBottom = '12px';
    return;
  }
  list.style.marginBottom = '0';
  names.forEach(name => {
    const card = document.createElement('div');
    card.className = 'card';

    // tapping the name area opens the editor
    const head = document.createElement('div');
    head.className = 'cardhead';
    head.onclick = () => showEditor(name);

    const headText = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'sub';
    detail.textContent = workouts[name].length + (workouts[name].length === 1 ? ' exercise' : ' exercises');
    headText.appendChild(title);
    headText.appendChild(detail);

    const chev = document.createElement('div');
    chev.className = 'chev';
    chev.textContent = '›';
    head.appendChild(headText);
    head.appendChild(chev);

    const start = document.createElement('button');
    start.textContent = 'Start';
    start.onclick = () => startRun(name);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (confirm('Delete "' + name + '"?')) {
        api('deleteWorkout', { name: name })
          .then(() => {
            const cur = readJSON('wt_workouts', {});
            delete cur[name];
            writeJSON('wt_workouts', cur);
            showList();
          })
          .catch(err => alert('Not deleted: ' + err.message));
      }
    };

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(start);
    actions.appendChild(del);

    card.appendChild(head);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

// ---------- run screen ----------
function startRun(name) {
  showOnly('runView');
  document.getElementById('runTitle').textContent = name;
  const body = document.getElementById('runBody');
  body.textContent = '';

  let planned = 0;
  allWorkouts[name].forEach(ex => { planned += ex.sets; });
  currentRun = { name: name, planned: planned, ids: new Set() };

  allWorkouts[name].forEach(ex => {
    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('b');
    title.textContent = ex.exercise;

    const detail = document.createElement('span');
    detail.className = 'sub';
    detail.textContent = ex.resistance + ' · ' + ex.sets + ' sets · rest ' + ex.rest + 's';

    card.appendChild(title);
    card.appendChild(detail);

    const rows = []; // keeps each set's inputs so we can pre-fill the next one
    for (let n = 1; n <= ex.sets; n++) {
      card.appendChild(makeSetRow(name, ex, n, rows));
    }
    body.appendChild(card);
  });
}

function makeSetRow(workout, ex, n, rows) {
  const row = document.createElement('div');
  row.className = 'setrow';

  const label = document.createElement('div');
  label.className = 'setlabel';
  label.textContent = 'Set ' + n;

  const reps = document.createElement('input');
  reps.type = 'number';
  reps.inputMode = 'numeric';
  reps.placeholder = 'Reps';

  const weight = document.createElement('input');
  weight.type = 'number';
  weight.inputMode = 'decimal';
  weight.placeholder = 'Weight';
  if (ex.resistance === 'body weight') weight.value = 0;
  if (ex.weight) weight.value = ex.weight; // the weight you set in the editor

  const btn = document.createElement('button');
  btn.textContent = 'Log';

  btn.onclick = () => {
    const r = Number(reps.value);
    if (!r || r <= 0) { reps.focus(); return; }

    // Mark it done right away; the save happens in the background.
    btn.textContent = '✓';
    btn.classList.add('done');
    btn.disabled = true;
    reps.disabled = true;
    weight.disabled = true;

    const next = rows[n]; // rows[n] is the next set (rows is 0-based)
    if (next) {
      if (!next.reps.value) next.reps.value = reps.value;
      if (!next.weight.value) next.weight.value = weight.value;
    }

    const id = newId();
    if (currentRun) currentRun.ids.add(id); // so the finish screen can check these sets were saved
    enqueueSet({
      requestId: id,
      workout: workout,
      exercise: ex.exercise,
      resistance: ex.resistance,
      setNumber: n,
      reps: r,
      weight: Number(weight.value) || 0
    });
  };

  rows.push({ reps: reps, weight: weight });
  row.appendChild(label);
  row.appendChild(reps);
  row.appendChild(weight);
  row.appendChild(btn);
  return row;
}

// ---------- finish screen ----------
function finishWorkout() {
  if (!currentRun || currentRun.ids.size === 0) { // nothing was logged
    currentRun = null;
    showList();
    return;
  }
  document.getElementById('finishView').classList.remove('hidden');
  renderFinish();
}

function renderFinish() {
  const run = currentRun;
  if (!run) return;
  const logged = run.ids.size;
  const pending = loadQueue().filter(i => run.ids.has(i.requestId)).length;
  const saved = logged - pending;

  const icon = document.getElementById('finishIcon');
  const title = document.getElementById('finishTitle');
  const sub = document.getElementById('finishSub');
  const retry = document.getElementById('finishRetry');
  const done = document.getElementById('finishDone');

  if (pending === 0) {
    icon.className = 'bigcheck';
    icon.textContent = '✓';
    title.textContent = 'Workout saved';
    sub.textContent = saved + ' of ' + run.planned + ' sets logged to your Sheet.';
    retry.classList.add('hidden');
    done.classList.remove('hidden');
  } else if (syncProblem) {
    icon.className = 'bigcheck warn';
    icon.textContent = '!';
    title.textContent = 'Not saved yet';
    sub.textContent = pending + (pending === 1 ? ' set is' : ' sets are') +
      ' still waiting to reach your Sheet. They are stored on this phone and will keep retrying.';
    retry.classList.remove('hidden');
    done.classList.remove('hidden');
  } else {
    icon.className = 'bigcheck wait';
    icon.textContent = '…';
    title.textContent = 'Saving…';
    sub.textContent = saved + ' of ' + logged + ' sets saved.';
    retry.classList.add('hidden');
    done.classList.add('hidden');
  }
}

function closeFinish() {
  document.getElementById('finishView').classList.add('hidden');
  currentRun = null;
  showList();
}

// ---------- builder / editor screen ----------
function makeField(labelText, input) {
  const wrap = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

// Press the three-line handle and drag the card up or down to reorder it.
// The dragged card stays where it is in the page while you drag (it only follows your finger
// visually) and the other cards slide out of the way. The order is changed once, when you let go.
function enableDrag(handle, card) {
  let active = false, pointerY = 0, grab = 0, raf = 0;
  let cards = [], tops = [], d = 0, target = 0, h = 0, step = 0;

  function docTop(el) { return el.getBoundingClientRect().top + window.pageYOffset; }

  function layout() {
    const top = pointerY + window.pageYOffset - grab;          // where the dragged card's top is now
    card.style.transform = 'translateY(' + (top - tops[d]) + 'px)';
    const center = top + h / 2;
    let t = 0;                                                 // how many other cards are above it
    cards.forEach((c, i) => { if (i !== d && tops[i] + c.offsetHeight / 2 < center) t++; });
    target = t;
    cards.forEach((c, i) => {
      if (i === d) return;
      let shift = 0;
      if (t > d && i > d && i <= t) shift = -step;             // cards it moved past slide up
      if (t < d && i >= t && i < d) shift = step;              // cards it moved past slide down
      c.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }

  function tick() {
    if (!active) return;
    // scroll the page when the finger nears the top or bottom edge
    if (pointerY < 90) window.scrollBy(0, -12);
    else if (pointerY > window.innerHeight - 90) window.scrollBy(0, 12);
    layout();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    const container = card.parentElement;
    cards.forEach(c => { c.style.transform = ''; c.classList.remove('shifting'); });
    card.classList.remove('dragging');
    if (target !== d) {                                        // apply the new order
      const rest = cards.filter(c => c !== card);
      container.insertBefore(card, rest[target] || null);
    }
  }

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    const container = card.parentElement;
    cards = Array.prototype.slice.call(container.children);
    d = cards.indexOf(card);
    target = d;
    tops = cards.map(docTop);
    h = card.offsetHeight;
    step = h + (parseFloat(getComputedStyle(card).marginBottom) || 0);
    pointerY = e.clientY;
    grab = pointerY + window.pageYOffset - tops[d];
    cards.forEach(c => { if (c !== card) c.classList.add('shifting'); });
    card.classList.add('dragging');
    active = true;
    tick();
  });
  handle.addEventListener('pointermove', e => { if (active) pointerY = e.clientY; });
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

// Adds one exercise card. Pass the saved exercise to pre-fill it.
function addRow(data) {
  data = data || {};
  const card = document.createElement('div');
  card.className = 'card';

  const nameInput = document.createElement('input');
  nameInput.className = 'ex-name';
  nameInput.placeholder = 'Exercise name';
  nameInput.value = data.exercise || '';

  const select = document.createElement('select');
  select.className = 'ex-resistance';
  // keep an unusual type from the Sheet instead of silently changing it
  const types = (!data.resistance || RESISTANCE.indexOf(data.resistance) !== -1)
    ? RESISTANCE : RESISTANCE.concat(data.resistance);
  types.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    select.appendChild(opt);
  });
  if (data.resistance) select.value = data.resistance;

  const sets = document.createElement('input');
  sets.className = 'ex-sets';
  sets.type = 'number';
  sets.inputMode = 'numeric';
  sets.value = data.sets || 3;

  const rest = document.createElement('input');
  rest.className = 'ex-rest';
  rest.type = 'number';
  rest.inputMode = 'numeric';
  rest.value = (data.rest === 0 || data.rest) ? data.rest : 90;

  const weight = document.createElement('input');
  weight.className = 'ex-weight';
  weight.type = 'number';
  weight.inputMode = 'decimal';
  weight.placeholder = '—';
  weight.value = data.weight || '';

  // three-line handle: press it and drag to reorder
  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.innerHTML = '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
  enableDrag(handle, card);

  const exhead = document.createElement('div');
  exhead.className = 'exhead';
  exhead.appendChild(handle);
  exhead.appendChild(nameInput);

  const remove = document.createElement('button');
  remove.className = 'secondary grow';
  remove.textContent = 'Remove';
  remove.onclick = () => card.remove();

  const row1 = document.createElement('div');
  row1.className = 'row';
  row1.appendChild(makeField('Resistance Type', select));

  const row2 = document.createElement('div');
  row2.className = 'row';
  row2.appendChild(makeField('Sets', sets));
  row2.appendChild(makeField('Rest (s)', rest));
  row2.appendChild(makeField('Weight', weight));

  const exactions = document.createElement('div');
  exactions.className = 'exactions';
  exactions.appendChild(remove);

  card.appendChild(exhead);
  card.appendChild(row1);
  card.appendChild(row2);
  card.appendChild(exactions);
  document.getElementById('exerciseRows').appendChild(card);
}

function numOr(value, fallback, min, max) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// After an edit, update the saved copy on this phone, keeping the workout's place in the list.
function replaceInCache(oldName, newName, exercises) {
  const cur = readJSON('wt_workouts', {});
  const out = {};
  let placed = false;
  Object.keys(cur).forEach(k => {
    if (k === oldName) { out[newName] = exercises; placed = true; }
    else if (k !== newName) out[k] = cur[k];
  });
  if (!placed) out[newName] = exercises;
  writeJSON('wt_workouts', out);
}

function saveCurrent() {
  const msg = document.getElementById('builderMsg');
  const name = document.getElementById('workoutName').value.trim();
  if (!name) { msg.textContent = 'Give the workout a name.'; return; }

  const oldName = editingName;
  if (name !== oldName && allWorkouts[name]) {
    msg.textContent = '"' + name + '" already exists. Pick a different name, or open it from the Library to edit it.';
    return;
  }

  const exercises = [];
  document.querySelectorAll('#exerciseRows .card').forEach(card => {
    const exName = card.querySelector('.ex-name').value.trim();
    if (!exName) return; // skip blank rows
    const w = Number(card.querySelector('.ex-weight').value);
    exercises.push({
      exercise: exName,
      resistance: card.querySelector('.ex-resistance').value,
      sets: numOr(card.querySelector('.ex-sets').value, 3, 1, 20),
      rest: numOr(card.querySelector('.ex-rest').value, 90, 0, 3600),
      weight: w > 0 ? w : ''
    });
  });
  if (exercises.length === 0) { msg.textContent = 'Add at least one exercise.'; return; }

  const payload = { name: name, exercises: exercises };
  if (oldName && oldName !== name) payload.oldName = oldName; // renaming

  msg.textContent = 'Saving...';
  api('saveWorkout', payload)
    .then(() => {
      replaceInCache(oldName, name, exercises);
      editingName = null;
      showList();
    })
    .catch(err => { msg.textContent = 'Error: ' + err.message; });
}

// ---------- start ----------
if (!CONFIG.API_URL || CONFIG.API_URL.indexOf('PASTE') === 0) {
  showOnly('listView');
  document.getElementById('list').textContent = 'config.js still needs your Apps Script URL.';
} else if (!getKey()) {
  showSetup();
} else {
  showList();
  if (loadQueue().length > 0) { updateSyncStatus(); flushQueue(); } // finish saving anything left from last time
}
