const RESISTANCE = ['dumbbell', 'body weight', 'cable', 'machine', 'other'];
let allWorkouts = {};

// ---------- talking to the Apps Script backend ----------
function getKey() {
  try { return localStorage.getItem('wt_key') || ''; } catch (e) { return ''; }
}

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

// Tries again after a short pause if the connection hiccups.
async function apiRetry(action, payload, retries) {
  for (let i = 0; ; i++) {
    try {
      return await api(action, payload);
    } catch (err) {
      if (err.server || i >= retries) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

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
function loadList() {
  const list = document.getElementById('list');
  list.textContent = 'Loading...';
  api('getWorkouts')
    .then(renderList)
    .catch(err => {
      if (err.message === 'Bad key') return;
      list.textContent = 'Error: ' + err.message;
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
        api('deleteWorkout', { name: name }).then(loadList).catch(err => alert('Not deleted: ' + err.message));
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
    btn.disabled = true;
    btn.textContent = '...';
    // requestId lets the backend ignore a repeat of the same tap, so a retry never doubles a row
    apiRetry('logSet', {
      requestId: newId(),
      workout: workout,
      exercise: ex.exercise,
      resistance: ex.resistance,
      setNumber: n,
      reps: r,
      weight: Number(weight.value) || 0
    }, 2)
      .then(() => {
        btn.textContent = '✓';
        btn.classList.add('done');
        reps.disabled = true;
        weight.disabled = true;
        const next = rows[n]; // rows[n] is the next set (rows is 0-based)
        if (next) {
          if (!next.reps.value) next.reps.value = reps.value;
          if (!next.weight.value) next.weight.value = weight.value;
        }
      })
      .catch(err => {
        btn.disabled = false;
        btn.textContent = 'Log';
        alert('Not saved: ' + err.message);
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
    .then(showList)
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
}
