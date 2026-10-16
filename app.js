const RESISTANCE = ['dumbbell', 'body weight', 'cable', 'machine', 'other'];
let allWorkouts = {};

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

// ---------- switching screens ----------
function showOnly(id) {
  ['setupView', 'listView', 'builderView', 'runView'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
  window.scrollTo(0, 0);
}

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

function showList() {
  showOnly('listView');
  loadList();
}

function showBuilder() {
  showOnly('builderView');
  document.getElementById('workoutName').value = '';
  document.getElementById('exerciseRows').textContent = '';
  document.getElementById('builderMsg').textContent = '';
  addRow();
}

// ---------- list screen ----------
// Shows the last known list instantly, then refreshes it from the Sheet in the background.
function loadList() {
  const list = document.getElementById('list');
  const info = document.getElementById('listInfo'); // temporary diagnostic line
  const cached = readJSON('wt_workouts', null);
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  if (cached) {
    renderList(cached);
    info.textContent = 'Showing saved copy · checking the Sheet…';
  } else {
    list.textContent = 'Loading...';
    info.textContent = 'No saved copy on this phone yet · asking the Sheet…';
  }
  api('getWorkouts')
    .then(fresh => {
      const saved = writeJSON('wt_workouts', fresh) && readJSON('wt_workouts', null) !== null;
      info.textContent = 'Sheet answered in ' + secs() + ' · ' +
        (saved ? 'copy saved on this phone' : 'could NOT save a copy on this phone');
      if (!cached || JSON.stringify(fresh) !== JSON.stringify(cached)) renderList(fresh);
    })
    .catch(err => {
      if (err.message === 'Bad key') return;
      info.textContent = 'Sheet failed after ' + secs() + ': ' + err.message;
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

    const title = document.createElement('b');
    title.textContent = name;

    const detail = document.createElement('span');
    detail.className = 'sub';
    detail.textContent = workouts[name].length + ' exercises';

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

    card.appendChild(title);
    card.appendChild(detail);
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

    enqueueSet({
      requestId: newId(),
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

// ---------- builder screen ----------
function makeField(labelText, input) {
  const wrap = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

function addRow() {
  const card = document.createElement('div');
  card.className = 'card';

  const nameInput = document.createElement('input');
  nameInput.className = 'ex-name';
  nameInput.placeholder = 'Exercise name';

  const select = document.createElement('select');
  select.className = 'ex-resistance';
  RESISTANCE.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    select.appendChild(opt);
  });

  const sets = document.createElement('input');
  sets.className = 'ex-sets';
  sets.type = 'number';
  sets.inputMode = 'numeric';
  sets.value = 3;

  const rest = document.createElement('input');
  rest.className = 'ex-rest';
  rest.type = 'number';
  rest.inputMode = 'numeric';
  rest.value = 90;

  const remove = document.createElement('button');
  remove.className = 'secondary';
  remove.textContent = 'Remove';
  remove.style.marginTop = '10px';
  remove.onclick = () => card.remove();

  const row1 = document.createElement('div');
  row1.className = 'row';
  row1.appendChild(makeField('Resistance', select));

  const row2 = document.createElement('div');
  row2.className = 'row';
  row2.appendChild(makeField('Sets', sets));
  row2.appendChild(makeField('Rest (seconds)', rest));

  card.appendChild(nameInput);
  card.appendChild(row1);
  card.appendChild(row2);
  card.appendChild(remove);
  document.getElementById('exerciseRows').appendChild(card);
}

function saveCurrent() {
  const msg = document.getElementById('builderMsg');
  const name = document.getElementById('workoutName').value.trim();
  if (!name) { msg.textContent = 'Give the workout a name.'; return; }

  const exercises = [];
  document.querySelectorAll('#exerciseRows .card').forEach(card => {
    const exName = card.querySelector('.ex-name').value.trim();
    if (!exName) return; // skip blank rows
    exercises.push({
      exercise: exName,
      resistance: card.querySelector('.ex-resistance').value,
      sets: Number(card.querySelector('.ex-sets').value) || 3,
      rest: Number(card.querySelector('.ex-rest').value) || 90
    });
  });
  if (exercises.length === 0) { msg.textContent = 'Add at least one exercise.'; return; }

  msg.textContent = 'Saving...';
  api('saveWorkout', { name: name, exercises: exercises })
    .then(() => {
      // update the saved list on this phone so the new workout shows up instantly
      const cur = readJSON('wt_workouts', {});
      delete cur[name];          // a replaced workout moves to the end, like in the Sheet
      cur[name] = exercises;
      writeJSON('wt_workouts', cur);
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
