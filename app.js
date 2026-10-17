const RESISTANCE = ['dumbbell', 'barbell', 'body weight', 'cable', 'machine', 'other'];
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

// Workout changes (save / delete) use the same queue, so they keep their order with logged sets.
// Items without "op" are logged sets (the original format).
function enqueueOp(op, payload) {
  const q = loadQueue();
  q.push({ op: op, payload: payload, opId: newId() });
  saveQueue(q);
  updateSyncStatus();
  flushQueue();
}

function pendingOps() { return loadQueue().some(i => i.op); }

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  syncProblem = '';
  updateSyncStatus();
  let sentAny = false;
  let opsChanged = false;
  try {
    while (loadQueue().length > 0) {
      const item = loadQueue()[0];
      try {
        await api(item.op || 'logSet', item.op ? item.payload : item);
      } catch (err) {
        if (err.message === 'Bad key') return; // the key screen is showing; sets stay queued
        if (err.server && item.op) {
          // the Sheet refused this workout change: drop it so it can't block your sets, and say so
          const q2 = loadQueue();
          q2.shift();
          saveQueue(q2);
          syncProblem = '';
          updateSyncStatus();
          alert('A workout change was not saved: ' + err.message);
          opsChanged = true;
          continue;
        }
        syncProblem = err.server ? 'Could not save: ' + err.message : 'Offline';
        updateSyncStatus();
        if (!err.server) retryTimer = setTimeout(flushQueue, 8000); // try again soon
        return;
      }
      const q = loadQueue();
      q.shift();
      saveQueue(q);
      sentAny = true;
      if (item.op) opsChanged = true;
      updateSyncStatus();
    }
    updateSyncStatus(sentAny);
    if (sentAny) {
      if (!document.getElementById('historyView').classList.contains('hidden')) loadHistory();
      else prefetchHistory(); // so the next visit to History already has your new workout
    }
    if (opsChanged && !pendingOps()) refreshListQuietly();
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
  const allSets = loadQueue().every(i => !i.op);
  const unit = allSets ? 'set' : 'change';
  const noun = n === 1 ? '1 ' + unit : n + ' ' + unit + 's';
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
const TAB_VIEWS = { home: 'homeView', list: 'listView', history: 'historyView', progress: 'progressView' };
const ALL_VIEWS = ['setupView', 'homeView', 'scheduleView', 'listView', 'historyView', 'progressView', 'builderView', 'runView'];

const PUSH_VIEWS = ['builderView', 'runView', 'scheduleView'];
function animateIn(id) {
  const v = document.getElementById(id);
  v.classList.remove('enter', 'enter-push');
  void v.offsetWidth; // restart the animation
  v.classList.add(PUSH_VIEWS.indexOf(id) !== -1 ? 'enter-push' : 'enter');
  clearTimeout(v._enterTimer);
  v._enterTimer = setTimeout(() => v.classList.remove('enter', 'enter-push'), 1400);
}

function showOnly(id) {
  const already = !document.getElementById(id).classList.contains('hidden');
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
  window.scrollTo(0, 0);
  if (!already) animateIn(id);
}

function showTab(tab) {
  showOnly(TAB_VIEWS[tab]);
  if (tab === 'home') loadHome();
  if (tab === 'list') loadList();
  if (tab === 'history') loadHistory();
  if (tab === 'progress') loadProgress();
}

let editorOrigin = 'list';   // where the editor was opened from, so Back/Save/Cancel return there
function leaveEditor() { showTab(editorOrigin === 'home' ? 'home' : 'list'); }

function showSetup(message) {
  showOnly('setupView');
  document.getElementById('keyInput').value = '';
  document.getElementById('setupMsg').textContent = message || '';
}

function saveKey() {
  const key = document.getElementById('keyInput').value.trim();
  if (!key) return;
  try { localStorage.setItem('wt_key', key); } catch (e) {}
  showTab('home');
  if (loadQueue().length > 0) flushQueue();
}

// Opens the editor. With a name it shows that saved workout; without one it starts a new workout.
function showEditor(name, from) {
  editingName = name || null;
  editorOrigin = from === 'home' ? 'home' : 'list';
  document.getElementById('builderBack').textContent = editorOrigin === 'home' ? '‹ Home' : '‹ Library';
  showOnly('builderView');
  document.getElementById('builderTitle').textContent = name ? 'Edit Workout' : 'New Workout';
  document.getElementById('builderSave').textContent = name ? 'Save changes' : 'Save workout';
  document.getElementById('workoutName').value = name || '';
  document.getElementById('exerciseRows').textContent = '';
  document.getElementById('builderMsg').textContent = '';
  document.getElementById('builderDelete').classList.toggle('hidden', !name);
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
      if (pendingOps()) return; // unsent edits on this phone are newer than what the Sheet has
      writeJSON('wt_workouts', fresh);
      if (homeVisible()) renderHome();
      if (!cached || JSON.stringify(fresh) !== JSON.stringify(cached)) renderList(fresh);
    })
    .catch(err => {
      if (err.message === 'Bad key') return;
      if (!cached) list.textContent = 'Error: ' + err.message;
    });
}

// After queued edits have reached the Sheet, re-read it so this phone matches exactly.
function homeVisible() { return !document.getElementById('homeView').classList.contains('hidden'); }

function refreshListQuietly() {
  api('getWorkouts').then(fresh => {
    if (pendingOps()) return;
    writeJSON('wt_workouts', fresh);
    if (homeVisible()) renderHome();
    if (!document.getElementById('listView').classList.contains('hidden') &&
        JSON.stringify(fresh) !== JSON.stringify(allWorkouts)) renderList(fresh);
  }).catch(() => {});
}

function renderList(workouts) {
  allWorkouts = workouts;
  const list_ = document.getElementById('list');
  list_.textContent = '';
  const names = Object.keys(workouts);
  if (names.length === 0) {
    list_.appendChild(el('div', 'empty', 'No workouts yet. Create one to get started.'));
    list_.style.marginBottom = '16px';
    return;
  }
  list_.style.marginBottom = '0';
  names.forEach(name => {
    const card = el('div', 'card wcard');
    card.onclick = () => showEditor(name); // tapping the card opens the editor

    const main = el('div', 'wmain');
    main.appendChild(el('b', '', name));
    const list = workouts[name];
    const shown = list.slice(0, 3).map(e => e.exercise).join(', ');
    main.appendChild(el('div', 'wsub', shown + (list.length > 3 ? ', +' + (list.length - 3) + ' more' : '')));

    const play = el('button', 'play');
    play.setAttribute('aria-label', 'Start ' + name);
    play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>';
    play.onclick = e => { e.stopPropagation(); beginWorkout(name); };

    const trash = el('button', 'trash');
    trash.setAttribute('aria-label', 'Delete ' + name);
    trash.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
    trash.onclick = e => {
      e.stopPropagation();
      if (deleteWorkoutByName(name)) renderList(readJSON('wt_workouts', {}));
    };

    card.appendChild(main);
    card.appendChild(trash);
    card.appendChild(play);
    list_.appendChild(card);
  });
}

// Deleting lives inside the editor, so it is hard to hit by accident.
// Asks first, then removes the workout here and queues the delete for the Sheet. Returns true if deleted.
function deleteWorkoutByName(name) {
  if (!name) return false;
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return false;
  const cur = readJSON('wt_workouts', {});
  delete cur[name];
  writeJSON('wt_workouts', cur);
  removeFromSchedule(name);
  enqueueOp('deleteWorkout', { name: name }); // the Sheet catches up in the background
  return true;
}

function deleteCurrentWorkout() {
  const name = editingName;
  if (!deleteWorkoutByName(name)) return;
  editingName = null;
  leaveEditor();
}

// ---------- history tab ----------
// Same idea as the Library: show the saved copy instantly, then refresh from the Sheet.
function loadHistory() {
  const box = document.getElementById('historyList');
  const cached = Array.isArray(readJSON('wt_history', null)) ? readJSON('wt_history', null) : null;
  if (cached) {
    renderHistory(cached);
  } else {
    box.textContent = '';
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      box.appendChild(sk);
    }
  }
  api('getHistory', { limit: 400 })
    .then(fresh => {
      if (loadQueue().some(i => !i.op)) return; // sets still waiting to be sent: the Sheet is behind
      if (!Array.isArray(fresh)) return;
      writeJSON('wt_history', fresh);
      if (homeVisible()) renderHome();
      if (!cached || JSON.stringify(fresh) !== JSON.stringify(cached)) renderHistory(fresh);
      if (!document.getElementById('progressView').classList.contains('hidden')) renderProgress();
    })
    .catch(err => {
      if (err.message === 'Bad key') return;
      if (!cached) box.textContent = 'Error: ' + err.message;
    });
}

// Quietly fetch history ahead of time so the History tab opens instantly.
function prefetchHistory() {
  if (!getKey() || loadQueue().some(i => !i.op)) return;
  api('getHistory', { limit: 400 }).then(fresh => {
    if (loadQueue().some(i => !i.op) || !Array.isArray(fresh)) return;
    writeJSON('wt_history', fresh);
    if (homeVisible()) renderHome();
    if (!document.getElementById('historyView').classList.contains('hidden')) renderHistory(fresh);
    if (!document.getElementById('progressView').classList.contains('hidden')) renderProgress();
  }).catch(() => {});
}

function prettyDate(iso) {
  const p = String(iso).split('-');
  if (p.length !== 3) return String(iso);
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Opens or closes a History row. Only transforms, opacity and a clip are animated (no per-frame layout),
// which keeps it smooth on phones even with a long list. The layout itself changes once, and the rows below
// slide into place from where they were.
const EXPAND_MS = 720, EXPAND_EASE = 'cubic-bezier(.33, 0, .15, 1)';
function toggleHistoryRow(row, wrap, head) {
  const group = row.parentElement;
  if (group._cleanup) group._cleanup();   // a tap mid-animation settles the previous one first
  const opening = !row.classList.contains('open');
  head.setAttribute('aria-expanded', opening ? 'true' : 'false');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !row.animate) { row.classList.toggle('open', opening); return; }

  const rows = Array.prototype.slice.call(group.children);
  const followers = rows.slice(rows.indexOf(row) + 1);
  const detail = wrap.firstElementChild;
  const radius = getComputedStyle(group).borderTopLeftRadius;
  const opts = { duration: EXPAND_MS, easing: EXPAND_EASE };
  const h0 = group.offsetHeight;
  if (opening) row.classList.add('open');
  const h1 = (function () { // size of the other state
    if (opening) return group.offsetHeight;
    row.classList.remove('open'); const h = group.offsetHeight; row.classList.add('open'); return h;
  })();
  const d = Math.abs(h1 - h0);
  const anims = [];
  const clip = n => 'inset(0 0 ' + n + 'px 0 round ' + radius + ')';
  document.body.classList.add('busy');

  if (opening) {
    followers.forEach(f => anims.push(f.animate([{ transform: 'translateY(' + -d + 'px)' }, { transform: 'translateY(0)' }], opts)));
    anims.push(detail.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: .42 }, { opacity: 1, offset: 1 }], opts));
    anims.push(group.animate([{ clipPath: clip(d) }, { clipPath: clip(0) }], opts));
  } else {
    followers.forEach(f => anims.push(f.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(' + -d + 'px)' }], opts)));
    anims.push(detail.animate([{ opacity: 1, offset: 0 }, { opacity: 0, offset: .3 }, { opacity: 0, offset: 1 }], opts));
    anims.push(group.animate([{ clipPath: clip(0) }, { clipPath: clip(d) }], opts));
  }
  let done = false;
  group._cleanup = () => {
    if (done) return;
    done = true; group._cleanup = null;
    anims.forEach(a => a.cancel());
    if (!opening) row.classList.remove('open');
    document.body.classList.remove('busy');
  };
  anims[0].onfinish = group._cleanup;
}

function renderHistory(sessions) {
  const box = document.getElementById('historyList');
  box.textContent = '';
  if (!sessions || sessions.length === 0) {
    box.appendChild(el('div', 'empty', 'No completed workouts yet. Log a set and it will show up here.'));
    return;
  }
  const group = el('div', 'group');
  sessions.forEach(sess => {
    const row = el('div', 'hrow');

    const head = el('div', 'hhead');
    const text = el('div');
    text.appendChild(el('b', '', sess.workout));
    text.appendChild(el('div', 'sub', prettyDate(sess.date)));
    const right = el('div', 'hright');
    right.appendChild(el('span', '', sess.sets + (sess.sets === 1 ? ' set' : ' sets')));
    const chev = el('div', 'chev', '›');
    right.appendChild(chev);
    head.appendChild(text);
    head.appendChild(right);

    const wrap = el('div', 'hwrap');
    const detail = el('div', 'hdetail');
    wrap.appendChild(detail);
    sess.exercises.forEach(e => {
      const t = el('div', 'hex', e.exercise);
      t.appendChild(el('span', '', e.resistance));
      detail.appendChild(t);
      e.sets.forEach(st => {
        const line = el('div', 'hset');
        line.appendChild(el('i', '', 'Set ' + st.set));
        line.appendChild(document.createTextNode(st.reps + ' reps × ' + (st.weight > 0 ? fmtNum(st.weight) : 'body weight')));
        detail.appendChild(line);
      });
    });
    detail.appendChild(el('div', 'hset hvol', 'Total volume ' + Math.round(sess.volume).toLocaleString()));

    head.onclick = () => toggleHistoryRow(row, wrap, head);
    row.appendChild(head);
    row.appendChild(wrap);
    group.appendChild(row);
  });
  box.appendChild(group);
}

// ---------- progress tab ----------
// Built from the same history copy the History tab uses (no extra server call needed).
const SVGNS = 'http://www.w3.org/2000/svg';
let progressSeries = [];

function loadProgress() {
  if (Array.isArray(readJSON('wt_history', null))) { renderProgress(); return; }
  document.getElementById('progBody').textContent = 'Loading…';
  api('getHistory', { limit: 400 })
    .then(fresh => { if (Array.isArray(fresh)) writeJSON('wt_history', fresh); renderProgress(); })
    .catch(err => { if (err.message !== 'Bad key') document.getElementById('progBody').textContent = 'Error: ' + err.message; });
}

// Per exercise, per day: every set that day (same exercise in two workouts on one day is combined).
function buildExerciseData(sessions) {
  const ex = {};
  (sessions || []).forEach(s => {
    s.exercises.forEach(e => {
      const rec = ex[e.exercise] = ex[e.exercise] || { name: e.exercise, days: {}, last: '' };
      const d = rec.days[s.date] = rec.days[s.date] || { date: s.date, sets: [] };
      e.sets.forEach(st => d.sets.push({ reps: st.reps, weight: st.weight }));
      if (s.date > rec.last) rec.last = s.date;
    });
  });
  return ex;
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

// Turn one day's sets into the numbers the charts use.
function summarizeDay(d) {
  const w = d.sets.map(s => s.weight), r = d.sets.map(s => s.reps);
  // estimated one-rep max (Epley) from the best set of the day
  const orm = Math.max.apply(null, d.sets.map(s => s.weight > 0 ? s.weight * (1 + s.reps / 30) : 0));
  const best = d.sets.reduce((b, s) => (s.weight * (1 + s.reps / 30) > b.weight * (1 + b.reps / 30) ? s : b), d.sets[0]);
  return {
    date: d.date, sets: d.sets,
    wAvg: mean(w), wMin: Math.min.apply(null, w), wMax: Math.max.apply(null, w),
    rAvg: mean(r), rMin: Math.min.apply(null, r), rMax: Math.max.apply(null, r),
    orm: orm, best: best
  };
}

function setsText(sets) {
  return sets.map((st, i) => 'Set ' + (i + 1) + ': ' + st.reps + ' × ' + (st.weight > 0 ? fmtNum(st.weight) : 'body weight')).join(',  ');
}

function renderProgress() {
  const body = document.getElementById('progBody');
  const pick = document.getElementById('progPick');
  const ex = buildExerciseData(savedHistory());
  const names = Object.keys(ex).sort((a, b) => ex[a].last < ex[b].last ? 1 : ex[a].last > ex[b].last ? -1 : 0);
  if (names.length === 0) {
    pick.classList.add('hidden');
    body.textContent = 'No data yet. Log a workout and your progress charts will appear here.';
    return;
  }
  let chosen = '';
  try { chosen = localStorage.getItem('wt_prog_ex') || ''; } catch (e) {}
  if (!ex[chosen]) chosen = names[0];
  pick.classList.remove('hidden');
  pick.textContent = '';
  names.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === chosen) o.selected = true;
    pick.appendChild(o);
  });
  pick.onchange = () => {
    try { localStorage.setItem('wt_prog_ex', pick.value); } catch (e) {}
    renderProgress();
  };

  const days = Object.keys(ex[chosen].days).sort().map(k => summarizeDay(ex[chosen].days[k]));
  const bodyweightOnly = days.every(d => d.wMax === 0);
  body.textContent = '';

  // headline numbers
  const first = days[0], last = days[days.length - 1];
  const key = bodyweightOnly ? 'rAvg' : 'wAvg';
  const change = last[key] - first[key];
  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  [[days.length, days.length === 1 ? 'session' : 'sessions'],
   [fmtNum(last[key]), bodyweightOnly ? 'avg reps' : 'avg weight'],
   [(change > 0 ? '+' : '') + fmtNum(change), days.length > 1 ? 'since first' : 'change']
  ].forEach(t => {
    const d = document.createElement('div');
    d.className = 'tile';
    const v = document.createElement('b'); v.textContent = t[0];
    const l = document.createElement('span'); l.textContent = t[1];
    d.appendChild(v); d.appendChild(l);
    tiles.appendChild(d);
  });
  body.appendChild(tiles);

  const shortSets = d => setsText(d.sets);
  if (!bodyweightOnly) {
    body.appendChild(chartCard('Weight over time',
      '',
      [{ val: 'wAvg', lo: 'wMin', hi: 'wMax', dots: 'weight', height: 200, ticks: 4 }], days,
      d => ['avg ' + fmtNum(d.wAvg), shortSets(d)]));
  }
  body.appendChild(chartCard('Reps over time',
    '',
    [{ val: 'rAvg', lo: 'rMin', hi: 'rMax', dots: 'reps', height: 200, ticks: 4 }], days,
    d => ['avg ' + fmtNum(d.rAvg) + ' reps', shortSets(d)]));
  if (!bodyweightOnly) {
    body.appendChild(chartCard('Average set per workout', '',
      [{ val: 'wAvg', height: 120, ticks: 3, noX: true, name: 'Avg weight', color: 'pink' },
       { val: 'rAvg', height: 140, ticks: 3, name: 'Avg reps', color: 'teal' }], days,
      d => ['avg set ' + fmtNum(d.rAvg) + ' reps × ' + fmtNum(d.wAvg), ''], true));
    body.appendChild(chartCard('Estimated one-rep max',
      '',
      [{ val: 'orm', height: 200, ticks: 4, color: 'teal' }], days,
      d => ['est. 1RM ' + fmtNum(d.orm), 'from your best set: ' + d.best.reps + ' × ' + fmtNum(d.best.weight)]));
  }
}

function fmtNum(n) {
  return (Math.round(n * 10) / 10).toLocaleString();
}

function dayNumber(iso) {
  const p = iso.split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function shortDate(iso) {
  const p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function niceTicks(lo, hi, want) {
  const span = hi - lo;
  const raw = span / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw);
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let t = start; t <= hi + step * 0.001; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return ticks;
}

function svgEl(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  Object.keys(attrs || {}).forEach(k => e.setAttribute(k, attrs[k]));
  return e;
}

// One line chart over the days. spec: { val, lo, hi, dots, height, ticks, noX, color }.
// Returns { svg, select(i) }; select() moves the crosshair to day i.
function makeLineChart(days, spec) {
  const W = 340, H = spec.height || 200, L = 40, R = 14, T = 14, B = spec.noX ? 8 : 26;
  const teal = spec.color === 'teal';
  const loKey = spec.lo || spec.val, hiKey = spec.hi || spec.val;
  let lo = Math.min.apply(null, days.map(d => d[loKey])), hi = Math.max.apply(null, days.map(d => d[hiKey]));
  const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.1);
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, spec.ticks || 3);
  lo = Math.min(ticks[0], lo - pad); hi = Math.max(ticks[ticks.length - 1], hi + pad);
  const d0 = dayNumber(days[0].date), d1 = dayNumber(days[days.length - 1].date);
  const X = d => days.length === 1 || d1 === d0 ? (L + (W - L - R) / 2) : L + (dayNumber(d.date) - d0) / (d1 - d0) * (W - L - R);
  const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img' });
  svg.setAttribute('aria-label', (spec.name || 'Chart') + ': ' + days.map(d => shortDate(d.date) + ' ' + fmtNum(d[spec.val])).join(', '));
  ticks.forEach(t => {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: Y(t), y2: Y(t), class: 'grid' }));
    const tx = svgEl('text', { x: L - 6, y: Y(t) + 4, class: 'axis', 'text-anchor': 'end' });
    tx.textContent = fmtNum(t);
    svg.appendChild(tx);
  });
  if (!spec.noX) {
    const xl = days.length === 1 ? [days[0]] : [days[0], days[days.length - 1]];
    xl.forEach((d, i) => {
      const tx = svgEl('text', { x: days.length === 1 ? X(d) : (i === 0 ? L : W - R), y: H - 6, class: 'axis',
        'text-anchor': days.length === 1 ? 'middle' : (i === 0 ? 'start' : 'end') });
      tx.textContent = shortDate(d.date);
      svg.appendChild(tx);
    });
  }
  if (spec.lo) days.forEach(d => {
    if (d[spec.hi] > d[spec.lo]) svg.appendChild(svgEl('line', { x1: X(d), x2: X(d), y1: Y(d[spec.hi]), y2: Y(d[spec.lo]), class: teal ? 'band teal' : 'band' }));
  });
  if (spec.dots) days.forEach(d => d.sets.forEach(st => svg.appendChild(svgEl('circle', { cx: X(d), cy: Y(st[spec.dots]), r: 2.2, class: 'setdot' }))));
  if (days.length > 1) svg.appendChild(svgEl('polyline', { points: days.map(d => X(d) + ',' + Y(d[spec.val])).join(' '), class: teal ? 'line teal' : 'line' }));
  days.forEach(d => svg.appendChild(svgEl('circle', { cx: X(d), cy: Y(d[spec.val]), r: 4.5, class: teal ? 'dot teal' : 'dot' })));
  const lp = days[days.length - 1];
  const lt = svgEl('text', { x: Math.min(X(lp), W - R - 2), y: Y(lp[spec.val]) - 10, class: 'valabel', 'text-anchor': days.length === 1 ? 'middle' : 'end' });
  lt.textContent = fmtNum(lp[spec.val]);
  svg.appendChild(lt);

  const cross = svgEl('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const ring = svgEl('circle', { r: 7, class: 'ring', visibility: 'hidden' });
  svg.appendChild(cross); svg.appendChild(ring);
  return {
    svg: svg,
    select: i => {
      const d = days[i];
      cross.setAttribute('x1', X(d)); cross.setAttribute('x2', X(d)); cross.setAttribute('visibility', 'visible');
      ring.setAttribute('cx', X(d)); ring.setAttribute('cy', Y(d[spec.val])); ring.setAttribute('visibility', 'visible');
    },
    nearest: clientX => {
      const r = svg.getBoundingClientRect();
      const x = (clientX - r.left) / r.width * W;
      let best = 0;
      days.forEach((d, i) => { if (Math.abs(X(d) - x) < Math.abs(X(days[best]) - x)) best = i; });
      return best;
    }
  };
}

// A card with a readout row on top and one or more charts that move together.
// Touch or hover a chart: the readout shows that day. By default it shows the latest day.
function chartCard(title, sub, specs, days, readoutFn, legend) {
  const card = document.createElement('div');
  card.className = 'card chartcard';
  const h = document.createElement('b');
  h.textContent = title;
  card.appendChild(h);
  if (legend) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    specs.forEach(sp => {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = sp.color === 'teal' ? 'teal' : '';
      item.appendChild(dot);
      item.appendChild(document.createTextNode(sp.name));
      lg.appendChild(item);
    });
    card.appendChild(lg);
  }
  const readout = document.createElement('div');
  readout.className = 'readout';
  card.appendChild(readout);
  const wrap = document.createElement('div');
  card.appendChild(wrap);

  const charts = specs.map(sp => makeLineChart(days, sp));
  function select(i) {
    const d = days[i], parts = readoutFn(d);
    readout.textContent = '';
    const b = document.createElement('b');
    b.textContent = shortDate(d.date);
    readout.appendChild(b);
    readout.appendChild(document.createTextNode(parts[0]));
    if (parts[1]) { readout.appendChild(document.createElement('br')); readout.appendChild(document.createTextNode(parts[1])); }
    charts.forEach(c => c.select(i));
  }
  charts.forEach(c => {
    wrap.appendChild(c.svg);
    c.svg.addEventListener('pointerdown', e => select(c.nearest(e.clientX)));
    c.svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) select(c.nearest(e.clientX)); });
    c.svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') select(days.length - 1); });
  });
  select(days.length - 1);
  return card;
}

// ---------- home tab ----------
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function localISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The weekly schedule: { Monday: 'Push Day', ... }. Days that are missing are rest days.
function getScheduleData() {
  const s = readJSON('wt_schedule', {});
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
}
function saveScheduleData(sched) {
  writeJSON('wt_schedule', sched);           // this phone first...
  enqueueOp('setSchedule', { schedule: sched }); // ...then the Sheet, in the background
}
function renameInSchedule(oldName, newName) {
  const s = getScheduleData();
  let changed = false;
  Object.keys(s).forEach(d => { if (s[d] === oldName) { s[d] = newName; changed = true; } });
  if (changed) saveScheduleData(s);
}
function removeFromSchedule(name) {
  const s = getScheduleData();
  let changed = false;
  Object.keys(s).forEach(d => { if (s[d] === name) { delete s[d]; changed = true; } });
  if (changed) saveScheduleData(s);
}

let lastHomeFetch = 0;
function loadHome() {
  renderHome(); // instantly, from what is saved on this phone
  const now = Date.now();
  if (now - lastHomeFetch < 30000) return; // refreshed very recently
  lastHomeFetch = now;
  refreshListQuietly();
  if (!pendingOps()) {
    api('getSchedule').then(fresh => {
      if (pendingOps() || !fresh || typeof fresh !== 'object' || Array.isArray(fresh)) return;
      writeJSON('wt_schedule', fresh);
      if (homeVisible()) renderHome();
    }).catch(() => {});
  }
  prefetchHistory();
}

// What to show under "Up Next": today's scheduled workout, else the next scheduled one,
// else the workout you haven't done for the longest time.
function computeUpNext(workouts, schedule, hist) {
  const names = Object.keys(workouts);
  if (names.length === 0) return { kind: 'none' };
  const now = new Date();
  const todayIdx = (now.getDay() + 6) % 7; // Monday = 0
  const today = localISO(now);
  const doneToday = new Set(hist.filter(x => x.date === today).map(x => x.workout));
  doneTodayNames().forEach(n => doneToday.add(n));
  loadQueue().forEach(i => { if (!i.op && i.workout) doneToday.add(i.workout); }); // sets still being sent
  const sched = idx => { const n = schedule[DAYS[idx % 7]]; return n && workouts[n] ? n : ''; };
  const t = sched(todayIdx);
  if (t && !doneToday.has(t)) return { kind: 'scheduled', name: t, when: 'Today' };
  for (let k = 1; k <= 7; k++) {
    const n = sched(todayIdx + k);
    if (n) {
      const dayName = DAYS[(todayIdx + k) % 7];
      return { kind: 'scheduled', name: n, when: k === 1 ? 'Tomorrow' : (k === 7 ? 'Next ' + dayName : dayName), afterDone: !!t };
    }
  }
  // nothing scheduled: suggest what you did longest ago (never done comes first)
  const lastDone = {};
  hist.forEach(x => { if (!lastDone[x.workout] || x.date > lastDone[x.workout]) lastDone[x.workout] = x.date; });
  let pick = names[0];
  names.forEach(n => {
    const a = lastDone[n] || '', b = lastDone[pick] || '';
    if (a < b) pick = n;
  });
  return { kind: 'suggested', name: pick, last: lastDone[pick] || '' };
}

function exerciseSummary(list) {
  const names = list.map(e => e.exercise);
  return names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ', +' + (names.length - 3) + ' more';
}

// Personal bests in the last 30 days: heaviest weight (or most reps in a set for body weight exercises).
function computePBs(hist) {
  const ex = buildExerciseData(hist);
  const cut = new Date(); cut.setDate(cut.getDate() - 30);
  const cutoff = localISO(cut);
  const events = [];
  Object.keys(ex).forEach(k => {
    const days = Object.keys(ex[k].days).sort().map(d => ex[k].days[d]);
    const bw = days.every(d => d.sets.every(st => st.weight === 0));
    let best = null, ev = null;
    days.forEach(d => {
      const v = bw ? Math.max.apply(null, d.sets.map(st => st.reps)) : Math.max.apply(null, d.sets.map(st => st.weight));
      if (best !== null && v > best) ev = { name: ex[k].name, date: d.date, value: v, prev: best, bw: bw };
      best = best === null ? v : Math.max(best, v);
    });
    if (ev && ev.date >= cutoff) events.push(ev);
  });
  events.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.value - a.value);
  return events.slice(0, 3);
}

function renderHome() {
  const workouts = readJSON('wt_workouts', {});
  allWorkouts = workouts;
  const hist = savedHistory();
  const schedule = getScheduleData();
  const now = new Date();

  const hour = now.getHours();
  document.getElementById('homeTitle').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('homeDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const body = document.getElementById('homeBody');
  body.textContent = '';

  // --- resume a half-finished workout ---
  const saved = readJSON(RUN_KEY, null);
  if (saved && saved.ids && saved.ids.length > 0 && workouts[saved.name] && Date.now() - (saved.startedAt || 0) < 18 * 3600 * 1000) {
    const card = el('div', 'card resume');
    card.appendChild(el('div', 'chip', 'In progress'));
    card.appendChild(el('b', '', saved.name));
    card.appendChild(el('span', 'sub', saved.ids.length + ' of ' + saved.planned + ' sets logged'));
    const acts = el('div', 'actions');
    const go = el('button', '', 'Resume');
    go.onclick = () => startRun(saved.name, saved);
    const drop = el('button', 'secondary', 'Discard');
    drop.onclick = () => {
      if (confirm('Discard this unfinished workout? Sets you already logged stay in your Sheet.')) { clearRunState(); renderHome(); }
    };
    acts.appendChild(go); acts.appendChild(drop);
    card.appendChild(acts);
    body.appendChild(card);
  }

  // --- up next ---
  const up = computeUpNext(workouts, schedule, hist);
  const hero = el('div', 'card hero');
  if (up.kind === 'none') {
    hero.appendChild(el('div', 'chip', 'Up next'));
    hero.appendChild(el('b', '', 'Create your first workout'));
    hero.appendChild(el('span', 'sub', 'Build a workout and it will show up here.'));
    const b = el('button', 'full', '+ Create New Workout');
    b.style.marginTop = '14px';
    b.onclick = () => showEditor(null, 'home');
    hero.appendChild(b);
  } else {
    if (up.afterDone) hero.appendChild(el('div', 'note', '✓ Today\'s workout is done'));
    hero.appendChild(el('div', 'chip', up.kind === 'scheduled' ? 'Scheduled for ' + up.when.toLowerCase() : 'Suggested for you'));
    hero.appendChild(el('b', '', up.name));
    let sub = exerciseSummary(workouts[up.name]);
    if (up.kind === 'suggested') sub += '\n' + (up.last ? 'Last done ' + prettyDate(up.last) : 'Not done yet');
    const subEl = el('span', 'sub', sub);
    subEl.style.whiteSpace = 'pre-line';
    hero.appendChild(subEl);
    const b = el('button', 'full', 'Start');
    b.style.marginTop = '14px';
    b.onclick = () => beginWorkout(up.name);
    hero.appendChild(b);
  }
  body.appendChild(hero);

  // --- this week ---
  const head = el('div', 'sechead');
  head.appendChild(el('h2', '', 'This week'));
  const edit = el('button', 'link', 'Schedule ›');
  edit.onclick = showSchedule;
  head.appendChild(edit);
  body.appendChild(head);

  const todayIdx = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
  const todayISO = localISO(now);
  const doneDates = new Set(hist.map(x => x.date));
  if (loadQueue().some(i => !i.op) || doneTodayNames().length > 0) doneDates.add(todayISO);
  const weekDates = [];
  for (let i = 0; i < 7; i++) weekDates.push(localISO(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
  const weekCard = el('div', 'card');
  const week = el('div', 'week');
  weekDates.forEach((iso, i) => {
    const done = doneDates.has(iso);
    const planned = !!(schedule[DAYS[i]] && workouts[schedule[DAYS[i]]]);
    let cls = 'wday';
    if (done) cls += ' done';
    else if (planned) cls += ' sched' + (iso < todayISO ? ' missed' : '');
    if (iso === todayISO) cls += ' today';
    const d = el('div', cls);
    d.appendChild(el('span', '', DAYS[i].slice(0, 3)));
    d.appendChild(el('div', 'dot', done ? '✓' : ''));
    week.appendChild(d);
  });
  weekCard.appendChild(week);
  const wk = hist.filter(x => x.date >= weekDates[0] && x.date <= weekDates[6]);
  const wsets = wk.reduce((n, x) => n + x.sets, 0);
  weekCard.appendChild(el('div', 'weeksum', wk.length === 0 ? 'No workouts yet this week.' :
    wk.length + (wk.length === 1 ? ' workout' : ' workouts') + ' · ' + wsets + (wsets === 1 ? ' set' : ' sets')));
  body.appendChild(weekCard);

  // --- recent personal bests ---
  if (hist.length > 0) {
    body.appendChild(el('div', 'sechead')).appendChild(el('h2', '', 'Recent personal bests'));
    const pbCard = el('div', 'card');
    const pbs = computePBs(hist);
    if (pbs.length === 0) {
      pbCard.appendChild(el('div', 'empty', 'No new personal bests in the last 30 days. Keep going!'));
    } else {
      pbs.forEach(p => {
        const row = el('div', 'pbrow');
        const left = el('div');
        left.appendChild(el('b', '', p.name));
        left.appendChild(el('span', '', prettyDate(p.date)));
        const right = el('div', 'pbval', p.bw ? p.value + ' reps' : fmtNum(p.value));
        right.appendChild(el('small', '', '↑ from ' + fmtNum(p.prev)));
        row.appendChild(left); row.appendChild(right);
        row.onclick = () => {
          try { localStorage.setItem('wt_prog_ex', p.name); } catch (e) {}
          showTab('progress');
        };
        pbCard.appendChild(row);
      });
    }
    body.appendChild(pbCard);
  }

  // --- quick actions ---
  body.appendChild(el('div', 'sechead')).appendChild(el('h2', '', 'Quick actions'));
  const list = el('div', 'group');
  const rowCreate = el('div', 'lrow', 'Create new workout');
  rowCreate.appendChild(el('span', 'chev2', '›'));
  rowCreate.onclick = () => showEditor(null, 'home');
  const rowSched = el('div', 'lrow', 'Schedule');
  rowSched.appendChild(el('span', 'chev2', '›'));
  rowSched.onclick = showSchedule;
  const rowRest = el('div', 'lrow', 'Rest timer');
  const sw = el('button', 'switch restToggle');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Rest timer');
  sw.onclick = e => { e.stopPropagation(); toggleRest(); };
  rowRest.appendChild(sw);
  rowRest.onclick = toggleRest;
  list.appendChild(rowCreate); list.appendChild(rowSched); list.appendChild(rowRest);
  body.appendChild(list);
  updateRestButton();
}

// ---------- schedule screen ----------
function showSchedule() {
  showOnly('scheduleView');
  const workouts = readJSON('wt_workouts', {});
  const schedule = getScheduleData();
  const box = document.getElementById('scheduleRows');
  box.textContent = '';
  const todayIdx = (new Date().getDay() + 6) % 7;
  DAYS.forEach((day, i) => {
    const row = el('div', 'schedrow' + (i === todayIdx ? ' today' : ''));
    row.appendChild(el('div', 'dname', day));
    const sel = document.createElement('select');
    const rest = el('option', '', 'Rest day');
    rest.value = '';
    sel.appendChild(rest);
    const current = schedule[day] || '';
    Object.keys(workouts).forEach(n => {
      const o = el('option', '', n);
      o.value = n;
      sel.appendChild(o);
    });
    if (current && !workouts[current]) { // scheduled workout no longer exists
      const o = el('option', '', current + ' (missing)');
      o.value = current;
      sel.appendChild(o);
    }
    sel.value = current;
    sel.className = current ? '' : 'rest';
    sel.onchange = () => {
      sel.className = sel.value ? '' : 'rest';
      const s = getScheduleData();
      if (sel.value) s[day] = sel.value; else delete s[day];
      saveScheduleData(s);
    };
    row.appendChild(sel);
    box.appendChild(row);
  });
}

// ---------- rest timer (via the Apple Shortcuts app) ----------
// Tapping Log opens a shortcut named "Rest" and passes it the rest time in seconds.
// The shortcut starts an iPhone timer, which rings and notifies you when it ends.
const REST_SHORTCUT = 'Rest';
function restOn() { try { return localStorage.getItem('wt_rest') === 'on'; } catch (e) { return false; } }

function openShortcut(url) { window.location.href = url; } // separate so tests can intercept it

function startRestTimer(seconds) {
  if (!restOn()) return;
  const sec = Math.round(Number(seconds));
  if (!sec || sec <= 0) return;
  // a moment's delay so the tap, the green check and the save queue finish first
  setTimeout(() => openShortcut('shortcuts://run-shortcut?name=' + encodeURIComponent(REST_SHORTCUT) +
    '&input=text&text=' + sec), 150);
}

function updateRestButton() {
  document.querySelectorAll('.restToggle').forEach(b => {
    b.classList.toggle('on', restOn());
    b.setAttribute('aria-checked', restOn() ? 'true' : 'false');
  });
}
function toggleRest() {
  try { localStorage.setItem('wt_rest', restOn() ? 'off' : 'on'); } catch (e) {}
  updateRestButton();
}

// ---------- run screen ----------
// The most recent earlier day this exercise was done (any workout), from the saved history copy.
// The saved history copy, or an empty list if it is missing or not a list.
function savedHistory() {
  const h = readJSON('wt_history', []);
  return Array.isArray(h) ? h : [];
}

function lastTimeFor(exName) {
  const t = new Date();
  const today = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  const hist = savedHistory(); // newest first
  let date = '', sets = [];
  hist.forEach(sess => {
    if (sess.date >= today) return;          // only earlier days count as "last time"
    sess.exercises.forEach(e => {
      if (e.exercise !== exName) return;
      if (sess.date > date) { date = sess.date; sets = e.sets.slice(); }
      else if (sess.date === date) sets = sets.concat(e.sets); // same exercise twice that day
    });
  });
  return date ? { date: date, sets: sets } : null;
}

// Starting from Library or Home. If a half-finished workout is saved, ask before replacing it.
function beginWorkout(name) {
  const saved = readJSON(RUN_KEY, null);
  if (saved && saved.ids && saved.ids.length > 0) {
    if (saved.name === name) { startRun(name, saved); return; } // same workout: just pick it back up
    if (!confirm('You have an unfinished "' + saved.name + '" workout. Start "' + name + '" instead? Sets already logged stay saved.')) return;
  }
  startRun(name);
}

function startRun(name, resume) {
  allWorkouts = readJSON('wt_workouts', allWorkouts) || allWorkouts;
  if (!allWorkouts[name]) return;
  showOnly('runView');
  document.getElementById('runTitle').textContent = name;
  const body = document.getElementById('runBody');
  body.textContent = '';

  let planned = 0;
  allWorkouts[name].forEach(ex => { planned += ex.sets; });
  currentRun = { name: name, planned: planned, ids: new Set(resume ? resume.ids : []), sets: resume ? (resume.sets || {}) : {}, startedAt: resume ? (resume.startedAt || Date.now()) : Date.now() };
  if (!resume) { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }

  allWorkouts[name].forEach((ex, exIndex) => {
    const card = el('div', 'card');

    const head = el('div', 'exhead2');
    const left = el('div');
    left.appendChild(el('b', '', ex.exercise));
    const meta = el('div', 'exmeta');
    meta.appendChild(el('span', 'pill', ex.resistance));
    meta.appendChild(el('span', '', ex.sets + (ex.sets === 1 ? ' set' : ' sets')));
    left.appendChild(meta);
    head.appendChild(left);
    const rest = el('div', 'restchip');
    rest.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 3h5"/></svg>';
    rest.appendChild(document.createTextNode(ex.rest + 's'));
    head.appendChild(rest);
    card.appendChild(head);

    const last = lastTimeFor(ex.exercise);
    if (last) card.appendChild(el('div', 'lasttitle', 'Last time ' + prettyDate(last.date)));

    const colhead = el('div', 'colhead');
    colhead.appendChild(el('span', '', 'Set'));
    colhead.appendChild(el('span', '', 'Reps'));
    colhead.appendChild(el('span', '', 'Weight'));
    colhead.appendChild(el('span', ''));
    card.appendChild(colhead);

    const rows = []; // keeps each set's inputs so we can pre-fill the next one
    for (let n = 1; n <= ex.sets; n++) {
      card.appendChild(makeSetRow(name, ex, n, rows, last && last.sets[n - 1], exIndex + '-' + n));
    }
    // after resuming, carry the numbers from the last logged set into the next empty one
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].done && !rows[i].done) {
        if (!rows[i].reps.value) rows[i].reps.value = rows[i - 1].reps.value;
        if (!rows[i].weight.value) rows[i].weight.value = rows[i - 1].weight.value;
      }
    }
    body.appendChild(card);
  });
}

// Workouts logged today, remembered on this phone so Home is right before History has reloaded.
function markDoneToday(name) {
  const today = localISO(new Date());
  const rec = readJSON('wt_today', null);
  const names = rec && rec.date === today && Array.isArray(rec.names) ? rec.names : [];
  if (names.indexOf(name) === -1) names.push(name);
  writeJSON('wt_today', { date: today, names: names });
}
function doneTodayNames() {
  const rec = readJSON('wt_today', null);
  return rec && rec.date === localISO(new Date()) && Array.isArray(rec.names) ? rec.names : [];
}

// What is saved so a half-finished workout can be resumed after closing the app.
const RUN_KEY = 'wt_run';
function saveRunState() {
  if (!currentRun) return;
  writeJSON(RUN_KEY, { name: currentRun.name, planned: currentRun.planned, ids: Array.from(currentRun.ids),
    sets: currentRun.sets, startedAt: currentRun.startedAt || Date.now() });
}
function clearRunState() { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }

function makeSetRow(workout, ex, n, rows, lastSet, key) {
  const row = document.createElement('div');
  row.className = 'setrow';

  const label = document.createElement('div');
  label.className = 'setlabel';
  label.textContent = n;
  if (lastSet) { // what you did in this set last time
    const hint = document.createElement('small');
    hint.textContent = lastSet.weight > 0 ? lastSet.reps + ' × ' + fmtNum(lastSet.weight) : lastSet.reps + ' reps';
    label.appendChild(hint);
  }

  const reps = document.createElement('input');
  reps.type = 'number';
  reps.inputMode = 'numeric';
  reps.placeholder = '–';

  const weight = document.createElement('input');
  weight.type = 'number';
  weight.inputMode = 'decimal';
  weight.placeholder = '–';
  if (ex.resistance === 'body weight') weight.value = 0;
  if (ex.weight) weight.value = ex.weight; // the weight you set in the editor

  const btn = document.createElement('button');
  btn.textContent = 'Log';

  const entry = { reps: reps, weight: weight, done: false };

  function markDone(animate) {
    btn.textContent = '✓';
    btn.classList.add('done');
    if (animate) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    btn.disabled = true;
    reps.disabled = true;
    weight.disabled = true;
    entry.done = true;
  }

  btn.onclick = () => {
    const r = Number(reps.value);
    if (!r || r <= 0) { reps.focus(); return; }

    // Mark it done right away; the save happens in the background.
    markDone(true);

    const next = rows[n]; // rows[n] is the next set (rows is 0-based)
    if (next) {
      if (!next.reps.value) next.reps.value = reps.value;
      if (!next.weight.value) next.weight.value = weight.value;
    }

    const id = newId();
    if (currentRun) {
      currentRun.ids.add(id); // so the finish screen can check these sets were saved
      if (key) currentRun.sets[key] = { reps: r, weight: Number(weight.value) || 0 };
      saveRunState();
      markDoneToday(currentRun.name);
    }
    startRestTimer(ex.rest);
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

  rows.push(entry);
  const savedSet = key && currentRun && currentRun.sets[key];
  if (savedSet) { // resuming: this set was already logged
    reps.value = savedSet.reps;
    weight.value = savedSet.weight;
    markDone();
  }
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
    clearRunState();
    showTab('home');
    return;
  }
  clearRunState(); // finished: nothing left to resume
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
  showTab('home');
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
function addRow(data, animate) {
  data = data || {};
  const card = document.createElement('div');
  card.className = animate ? 'card rowin' : 'card';

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
  remove.onclick = () => {
    card.style.height = card.offsetHeight + 'px';
    void card.offsetWidth;
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 260);
  };

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
  if (animate) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  payload.requestId = newId();
  replaceInCache(oldName, name, exercises); // update this phone first...
  if (oldName && oldName !== name) renameInSchedule(oldName, name);
  editingName = null;
  msg.textContent = '';
  enqueueOp('saveWorkout', payload);        // ...let the Sheet catch up in the background...
  leaveEditor();                            // ...and go straight back where you came from
}

// ---------- start ----------
if (!CONFIG.API_URL || CONFIG.API_URL.indexOf('PASTE') === 0) {
  showOnly('listView');
  document.getElementById('list').textContent = 'config.js still needs your Apps Script URL.';
} else if (!getKey()) {
  showSetup();
} else {
  showTab('home');
  if (loadQueue().length > 0) { updateSyncStatus(); flushQueue(); } // finish saving anything left from last time
}
