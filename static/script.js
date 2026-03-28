// ══ STATE ════════════════════════════════════════════════════════
let token = localStorage.getItem('dg_token');
let currentUser = null;
let socket = null;
let running = false;
let earBuf = [];
let currentThreshold = 0.17;
let selectedRole = 'driver';
let selectedManager = null;   // { username, name } or null
let sessionChartInst = null;
let driverCards = {};
let alertCount = 0;
let allSessions = [];
let allDrivers = [];

// ══ AUTH ═════════════════════════════════════════════════════════
function switchAuthTab(tab) {
  document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-signup').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab !== 'login');
  if (tab === 'signup') loadManagersForSignup();
}

function selectRole(r) {
  selectedRole = r;
  document.getElementById('role-driver').classList.toggle('active', r === 'driver');
  document.getElementById('role-admin').classList.toggle('active', r === 'admin');
  document.getElementById('manager-group').classList.toggle('hidden', r !== 'driver');
  if (r === 'driver') loadManagersForSignup();
}

// ── Manager selection for signup ─────────────────────────────────
async function loadManagersForSignup() {
  const wrap = document.getElementById('manager-select-wrap');
  const list = document.getElementById('manager-list');
  const empty = document.getElementById('manager-empty');
  const loading = document.getElementById('manager-loading');
  const display = document.getElementById('manager-selected-display');

  if (selectedManager) return;

  loading.classList.remove('hidden');
  list.classList.add('hidden');
  empty.classList.add('hidden');
  display.classList.add('hidden');

  try {
    const res = await fetch('/api/admins');
    const admins = await res.json();

    loading.classList.add('hidden');

    if (!admins.length) {
      empty.classList.remove('hidden');
      return;
    }

    list.innerHTML = admins.map(a => `
      <div class="manager-option" onclick="selectManager('${a.username}', '${escapeAttr(a.name)}')">
        <div class="manager-option-avatar">${a.name[0].toUpperCase()}</div>
        <div>
          <div class="manager-option-name">${a.name}</div>
          <div class="manager-option-username">@${a.username}</div>
        </div>
        <div class="manager-option-check">✓</div>
      </div>
    `).join('');
    list.classList.remove('hidden');
  } catch (e) {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
  }
}

function selectManager(username, name) {
  selectedManager = { username, name };
  document.getElementById('manager-list').classList.add('hidden');
  document.getElementById('manager-empty').classList.add('hidden');
  document.getElementById('manager-loading').classList.add('hidden');
  document.getElementById('mgr-avatar').textContent = name[0].toUpperCase();
  document.getElementById('mgr-name').textContent = name;
  document.getElementById('mgr-username').textContent = '@' + username;
  document.getElementById('manager-selected-display').classList.remove('hidden');
}

function clearManagerSelection() {
  selectedManager = null;
  document.getElementById('manager-selected-display').classList.add('hidden');
  document.getElementById('manager-list').classList.remove('hidden');
}

function escapeAttr(s) {
  return s.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');

  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');
    initSession(data);
  } catch(e) {
    errEl.textContent = 'Cannot connect to server. Is server.py running?';
    errEl.classList.remove('hidden');
  }
}

async function doSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-user').value.trim();
  const password = document.getElementById('signup-pass').value;
  const errEl = document.getElementById('signup-error');

  if (selectedRole === 'driver' && !selectedManager) {
    const empty = document.getElementById('manager-empty');
    if (empty.classList.contains('hidden')) {
      errEl.textContent = 'Please select a fleet manager.';
      errEl.classList.remove('hidden');
      return;
    }
  }

  errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/signup', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name, username, password,
        role: selectedRole,
        manager: selectedRole === 'driver' && selectedManager ? selectedManager.username : null,
      })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
    initSession(data);
  } catch(e) {
    errEl.textContent = 'Cannot connect to server. Is server.py running?';
    errEl.classList.remove('hidden');
  }
}

function initSession(data) {
  token = data.token;
  currentUser = data;
  localStorage.setItem('dg_token', token);
  localStorage.setItem('dg_user', JSON.stringify(data));
  showApp();
}

function doLogout() {
  localStorage.removeItem('dg_token');
  localStorage.removeItem('dg_user');
  if (socket) socket.disconnect();
  location.reload();
}

// ══ APP INIT ═════════════════════════════════════════════════════
function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').classList.add('show');

  const u = currentUser;
  document.getElementById('user-name-hdr').textContent = u.name || u.username;
  document.getElementById('user-avatar-hdr').textContent = (u.name || u.username)[0].toUpperCase();
  document.getElementById('role-badge').textContent = u.role.toUpperCase();

  const roleTag = document.getElementById('user-role-tag');
  roleTag.textContent = u.role.toUpperCase();
  roleTag.className = `role-tag ${u.role}`;

  buildNav(u.role);

  if (u.role === 'admin') {
    document.getElementById('admin-pages').classList.remove('hidden');
    initAdminSocket();
    loadAdminFleet();
  } else {
    document.getElementById('driver-pages').classList.remove('hidden');
    currentThreshold = u.threshold || 0.17;
    if (!u.calibrated) {
      document.getElementById('calib-notice').classList.remove('hidden');
    }
    updateCalibStatus(u.calibrated, u.threshold);

    if (u.manager) {
      showManagerChip(u.manager);
    }

    initDriverSocket();
    setTimeout(initChart, 100);
  }
}

function showManagerChip(managerUsername) {
  fetch('/api/admins')
    .then(r => r.json())
    .then(admins => {
      const mgr = admins.find(a => a.username === managerUsername);
      if (!mgr) return;
      const chip = document.getElementById('manager-chip');
      document.getElementById('manager-chip-name').textContent = mgr.name;
      chip.classList.remove('hidden');
    })
    .catch(() => {});
}

function buildNav(role) {
  const nav = document.getElementById('main-nav');
  if (role === 'admin') {
    nav.innerHTML = `
      <button class="nav-btn active" onclick="showPage('fleet')">Fleet</button>
      <button class="nav-btn" onclick="showPage('admin-sessions');loadAdminSessions()">Sessions</button>
    `;
  } else {
    nav.innerHTML = `
      <button class="nav-btn active" onclick="showPage('detect')">Detect</button>
      <button class="nav-btn" onclick="showPage('calibrate')">Calibrate</button>
      <button class="nav-btn" onclick="showPage('sessions');loadDriverSessions()">Sessions</button>
    `;
  }
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + id);
  if (page) page.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.textContent.toLowerCase().includes(id.slice(0,4).toLowerCase())) b.classList.add('active');
  });
  if (id === 'detect') setTimeout(initChart, 50);
  if (id !== 'detect') document.getElementById('detect-feed').style.display = 'none';
  if (id !== 'calibrate') document.getElementById('calib-feed').style.display = 'none';
}

// ══ DRIVER SOCKET ════════════════════════════════════════════════
function initDriverSocket() {
  socket = io();

  socket.on('connect', () => {
    setBanner('ok', '✓ Connected');
    setTimeout(() => setBanner('hidden', ''), 2000);
    document.getElementById('main-btn').disabled = false;
    document.getElementById('calib-btn').disabled = false;
    socket.emit('auth', { token });
  });

  socket.on('auth_ok', (d) => {
    currentThreshold = d.threshold || 0.17;
    document.getElementById('thr-label').textContent = 'threshold ' + currentThreshold.toFixed(3);
    updateCalibStatus(d.calibrated, d.threshold);
  });

  socket.on('auth_error', (d) => toast(d.msg, 'warn'));

  socket.on('disconnect', () => {
    setBanner('warn', '⚡ Disconnected — is server.py running?');
    document.getElementById('main-btn').disabled = true;
    document.getElementById('calib-btn').disabled = true;
  });

  socket.on('error', (d) => toast('Error: ' + d.msg, 'warn'));

  socket.on('started', () => {
    running = true;
    earBuf = [];
    document.getElementById('main-btn').textContent = '⏹ Stop Detection';
    document.getElementById('main-btn').className = 'btn stop';
    document.getElementById('detect-feed').style.display = 'block';
    document.getElementById('cam-placeholder').style.display = 'none';
    document.getElementById('cam-status').classList.remove('hidden');
  });

  socket.on('frame', (d) => {
    currentThreshold = d.threshold;
    earBuf.push(d.ear);
    if (earBuf.length > 300) earBuf.shift();

    const n = document.getElementById('ear-num');
    n.textContent = d.ear.toFixed(3);
    n.className = 'ear-num ' + (d.ear < d.threshold ? 'bad' : d.ear < d.threshold + 0.03 ? 'warn' : 'ok');

    document.getElementById('state-pill-wrap').innerHTML = d.status === 'drowsy'
      ? '<span class="state-pill drowsy"><span class="dot"></span>DROWSY</span>'
      : '<span class="state-pill alert"><span class="dot"></span>ALERT</span>';

    document.getElementById('thr-label').textContent = 'threshold ' + d.threshold.toFixed(3);
    document.getElementById('frame-fill').style.width = (d.drowsy_frames / 45 * 100) + '%';
    document.getElementById('frame-ct').textContent = d.drowsy_frames + ' / 45';
    document.getElementById('alarm-ct').textContent = d.alarms;
    document.getElementById('fps-stat').textContent = d.fps;

    const secs = d.runtime;
    document.getElementById('runtime').textContent =
      String(Math.floor(secs/60)).padStart(2,'0') + ':' + String(secs%60).padStart(2,'0');

    const mean = earBuf.reduce((a,b)=>a+b,0)/earBuf.length;
    document.getElementById('mean-ear').textContent = 'mean ' + mean.toFixed(3);

    updateChart(d);
    // ── FIX: always call updateTrend after every frame ────────────
    updateTrend();
  });

  socket.on('stopped', (d) => {
    running = false;
    document.getElementById('main-btn').textContent = '▶ Start Detection';
    document.getElementById('main-btn').className = 'btn start';
    document.getElementById('detect-feed').style.display = 'none';
    document.getElementById('cam-placeholder').style.display = 'flex';
    document.getElementById('cam-status').classList.add('hidden');
    setIdle();

    const alertFrames = earBuf.filter(e => e >= currentThreshold).length;
    const alertPct = earBuf.length ? Math.round(alertFrames / earBuf.length * 100) : 100;
    const meanEar = earBuf.length ? +(earBuf.reduce((a,b)=>a+b,0)/earBuf.length).toFixed(3) : 0;

    socket.emit('save_session', {
      token, runtime: d.runtime, alarms: d.alarms,
      mean_ear: meanEar, threshold: currentThreshold,
      alert_pct: alertPct, ear_series: earBuf,
      clips: d.clips || [],
    });

    toast('Session saved — ' + d.alarms + ' alarm' + (d.alarms !== 1 ? 's' : ''));
  });

  socket.on('calib_progress', (d) => {
    const total = 408;
    document.getElementById('ring').style.strokeDashoffset = total - (total * d.progress / 100);
    document.getElementById('calib-pct').textContent = d.progress + '%';
    document.getElementById('calib-sub').textContent = 'collecting';
  });

  socket.on('calibrated', (d) => {
    currentThreshold = d.threshold;
    document.getElementById('ring').style.strokeDashoffset = 0;
    document.getElementById('calib-pct').textContent = '✓';
    document.getElementById('calib-sub').textContent = 'done';
    document.getElementById('calib-result').classList.remove('hidden');
    document.getElementById('calib-val').textContent = d.threshold.toFixed(3);
    document.getElementById('calib-feed').style.display = 'none';
    document.getElementById('calib-cam-placeholder').style.display = 'flex';
    document.getElementById('calib-notice').classList.add('hidden');
    updateCalibStatus(true, d.threshold);
    const saved = JSON.parse(localStorage.getItem('dg_user') || '{}');
    saved.calibrated = true;
    saved.threshold = d.threshold;
    localStorage.setItem('dg_user', JSON.stringify(saved));
    toast('Calibration complete — threshold: ' + d.threshold.toFixed(3));
    socket.emit('stop');
  });

  socket.on('sessions', renderDriverSessions);
  socket.on('session_saved', (s) => { /* saved confirmation */ });
}

function toggleDetect() {
  if (!running) socket.emit('start', { token });
  else socket.emit('stop');
}

// ── FIX: startCalib now sends force_calibrate=true so the server
//         always runs calibration even if user was already calibrated
function startCalib() {
  document.getElementById('recalib-confirm').classList.add('hidden');
  socket.emit('stop');
  document.getElementById('calib-pct').textContent = '0%';
  document.getElementById('calib-sub').textContent = 'collecting';
  document.getElementById('ring').style.strokeDashoffset = '408';
  document.getElementById('calib-result').classList.add('hidden');
  setTimeout(() => {
    socket.emit('start', { token, force_calibrate: true });
    document.getElementById('calib-feed').style.display = 'block';
    document.getElementById('calib-cam-placeholder').style.display = 'none';
  }, 500);
}

function confirmRecalib() {
  document.getElementById('recalib-confirm').classList.remove('hidden');
}

function cancelRecalib() {
  document.getElementById('recalib-confirm').classList.add('hidden');
}

function updateCalibStatus(calibrated, threshold) {
  const thr = threshold || 0.17;
  document.getElementById('current-thr-val').textContent = thr.toFixed(3);
  document.getElementById('current-calib-badge').classList.toggle('hidden', !calibrated);
  document.getElementById('default-calib-badge').classList.toggle('hidden', calibrated);
  document.getElementById('recalib-btn').classList.toggle('hidden', !calibrated);
  const calibBtn = document.getElementById('calib-btn');
  calibBtn.style.display = calibrated ? 'none' : 'block';
}

function loadDriverSessions() {
  socket.emit('get_sessions', { token });
}

// ══ ADMIN SOCKET ═════════════════════════════════════════════════
function initAdminSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('auth', { token });
    socket.emit('admin_join', { token });
  });

  socket.on('auth_ok', () => {});

  socket.on('driver_alert', (d) => {
    alertCount++;
    document.getElementById('stat-alerts').textContent = alertCount;
    addAlertFeedItem(d);
    toast('🚨 DROWSY: ' + d.driver + ' at ' + d.timestamp, 'warn');
    const card = driverCards[d.driver];
    if (card) {
      card.classList.add('drowsy');
      card.classList.remove('active');
      setTimeout(() => {
        card.classList.remove('drowsy');
        card.classList.add('active');
      }, 10000);
    }
  });

  socket.on('driver_status', (d) => {
    updateDriverCard(d.driver, d);
  });

  socket.on('active_drivers', (list) => {
    list.forEach(d => updateDriverCard(d.driver, d));
  });

  socket.on('sessions', renderAdminSessions);
}

async function loadAdminFleet() {
  try {
    const res = await fetch('/api/drivers', { headers: {'Authorization': 'Bearer ' + token} });
    if (!res.ok) return;
    allDrivers = await res.json();
    document.getElementById('stat-total').textContent = allDrivers.length;
    document.getElementById('stat-active').textContent = '0';
    renderFleetGrid(allDrivers);
  } catch(e) {}

  try {
    const res2 = await fetch('/api/sessions', { headers: {'Authorization': 'Bearer ' + token} });
    if (res2.ok) {
      allSessions = await res2.json();
      const today = new Date().toISOString().slice(0,10);
      const todayCount = allSessions.filter(s => s.date && s.date.startsWith(today)).length;
      document.getElementById('stat-sessions').textContent = todayCount;
    }
  } catch(e) {}
}

function loadAdminSessions() {
  socket.emit('get_sessions', { token });
}

function renderFleetGrid(drivers) {
  const grid = document.getElementById('fleet-grid');
  if (!drivers.length) {
    grid.innerHTML = '<div class="empty">No drivers assigned to you yet.</div>';
    return;
  }
  grid.innerHTML = '';
  drivers.forEach(d => {
    const card = document.createElement('div');
    card.className = 'driver-card';
    card.id = 'dcard-' + d.username;
    card.innerHTML = `
      <div class="dc-header">
        <div class="dc-avatar">${(d.name||d.username)[0].toUpperCase()}</div>
        <div>
          <div class="dc-name">${d.name||d.username}</div>
          <div class="dc-username">@${d.username}</div>
        </div>
        <div class="dc-status offline" id="dcstatus-${d.username}">
          <div class="dot"></div>
          <span>Offline</span>
        </div>
      </div>
      <div class="dc-stat-row">
        <div class="dc-stat">
          <div class="dc-stat-label">EAR</div>
          <div class="dc-stat-val mono" id="dcear-${d.username}" style="color:var(--muted)">—</div>
        </div>
        <div class="dc-stat">
          <div class="dc-stat-label">Status</div>
          <div class="dc-stat-val" id="dcstate-${d.username}" style="color:var(--muted);font-size:13px">Offline</div>
        </div>
        <div class="dc-stat">
          <div class="dc-stat-label">Alarms</div>
          <div class="dc-stat-val" id="dcalarm-${d.username}" style="color:var(--muted)">—</div>
        </div>
      </div>
      <div class="dc-threshold">
        <span>Threshold</span>
        <span class="mono">${d.calibrated ? d.threshold.toFixed(3) : 'not calibrated'}</span>
      </div>`;
    driverCards[d.username] = card;
    grid.appendChild(card);
  });
}

function updateDriverCard(username, data) {
  const card = driverCards[username];
  if (!card) return;

  const statusEl = document.getElementById('dcstatus-' + username);
  const earEl = document.getElementById('dcear-' + username);
  const stateEl = document.getElementById('dcstate-' + username);
  const alarmEl = document.getElementById('dcalarm-' + username);

  const isDrowsy = data.status === 'drowsy';

  if (statusEl) {
    statusEl.className = 'dc-status ' + (isDrowsy ? 'drowsy' : 'online');
    statusEl.innerHTML = `<div class="dot"></div><span>${isDrowsy ? 'DROWSY' : 'Active'}</span>`;
  }
  if (earEl) {
    earEl.textContent = typeof data.ear === 'number' ? data.ear.toFixed(3) : '—';
    earEl.style.color = isDrowsy ? 'var(--red)' : 'var(--green)';
  }
  if (stateEl) {
    stateEl.textContent = (data.status || 'Offline').toUpperCase();
    stateEl.style.color = isDrowsy ? 'var(--red)' : 'var(--green)';
  }
  if (alarmEl) {
    alarmEl.textContent = data.alarms ?? '—';
    alarmEl.style.color = data.alarms > 0 ? 'var(--red)' : 'var(--muted)';
  }

  card.classList.toggle('active', !isDrowsy);
  card.classList.toggle('drowsy', isDrowsy);

  const activeCards = document.querySelectorAll('.driver-card.active, .driver-card.drowsy');
  document.getElementById('stat-active').textContent = activeCards.length;
}

function addAlertFeedItem(d) {
  const feed = document.getElementById('alert-feed');
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <div class="alert-icon">🚨</div>
    <div style="flex:1">
      <div class="alert-driver">${d.driver}</div>
      <div style="font-size:12px;color:var(--sub)">EAR: ${d.ear}</div>
    </div>
    ${d.clip ? `<img src="/clips/${d.clip}" style="height:48px;border-radius:4px;border:1px solid var(--border);cursor:pointer" title="Click to enlarge" onclick="window.open('/clips/${d.clip}','_blank')" onerror="this.remove()" />` : ''}
    <div class="alert-time">${d.timestamp}</div>`;
  feed.insertBefore(item, feed.firstChild);

  const items = feed.querySelectorAll('.alert-item');
  if (items.length > 20) items[items.length - 1].remove();
}

// ══ SESSIONS ═════════════════════════════════════════════════════
function renderDriverSessions(data) {
  const list = document.getElementById('session-list');
  const count = document.getElementById('sessions-count');
  allSessions = data;

  if (!data || !data.length) {
    list.innerHTML = '<div class="empty">No sessions yet — start detecting to record one.</div>';
    count.textContent = '0 sessions';
    return;
  }

  count.textContent = data.length + ' session' + (data.length !== 1 ? 's' : '');
  list.innerHTML = data.map(s => sessionHTML(s, false)).join('');
}

function renderAdminSessions(data) {
  const list = document.getElementById('admin-session-list');
  const count = document.getElementById('admin-sessions-count');
  allSessions = data;

  if (!data || !data.length) {
    list.innerHTML = '<div class="empty">No sessions recorded yet.</div>';
    count.textContent = '0 sessions';
    return;
  }

  count.textContent = data.length + ' session' + (data.length !== 1 ? 's' : '');
  list.innerHTML = data.map(s => sessionHTML(s, true)).join('');
}

function sessionHTML(s, showDriver) {
  const sec = s.duration || 0;
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const sc = sec % 60;
  const dur = (h > 0 ? h+'h ' : '') + m+'m ' + sc+'s';
  const ok = (s.alert_pct || 0) >= 90;
  const col = s.alarms > 10 ? 'var(--red)' : s.alarms > 3 ? 'var(--amber)' : 'var(--green)';
  const driverLine = showDriver ? `<div class="session-driver">@${s.driver || '—'}</div>` : '';

  return `<div class="session-item" onclick='openSession(${JSON.stringify(s)})'>
    <div class="session-dot" style="background:${ok?'var(--green)':'var(--red)'}"></div>
    <div class="session-main">
      ${driverLine}
      <div class="session-time">${s.date}</div>
      <div class="session-dur">${dur}</div>
    </div>
    <div class="session-right">
      <div class="session-alarms" style="color:${col}">${s.alarms} alarm${s.alarms!==1?'s':''}</div>
      <div class="session-pct">${s.alert_pct||0}% alert</div>
    </div>
  </div>`;
}

function openSession(s) {
  const m = document.getElementById('session-modal');
  m.classList.remove('hidden');

  document.getElementById('modal-title').textContent = s.driver
    ? `Session — @${s.driver} on ${s.date}`
    : `Session — ${s.date}`;

  const sec = s.duration || 0;
  document.getElementById('modal-dur').textContent =
    Math.floor(sec/60) + 'm ' + (sec%60) + 's';
  document.getElementById('modal-alarms').textContent = s.alarms ?? '—';
  document.getElementById('modal-pct').textContent = (s.alert_pct ?? 100) + '%';

  const clipsWrap = document.getElementById('modal-clips');
  const clips = s.clips || (s.clip ? [s.clip] : []);
  if (clips.length) {
    clipsWrap.innerHTML = `
      <div style="font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
        Drowsiness Captures (${clips.length})
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${clips.map((c, i) => `
          <div style="position:relative;">
            <img src="/clips/${c}" title="Event ${i+1}"
              style="height:90px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:#000"
              onerror="this.style.display='none'"
              onclick="window.open('/clips/${c}','_blank')" />
            <div style="position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.65);border-radius:3px;padding:1px 5px;font-size:10px;font-family:var(--mono);color:#fff">
              #${i+1}
            </div>
          </div>`).join('')}
      </div>`;
    clipsWrap.style.display = 'block';
  } else {
    clipsWrap.innerHTML = '';
    clipsWrap.style.display = 'none';
  }

  if (sessionChartInst) { sessionChartInst.destroy(); sessionChartInst = null; }

  const ctx = document.getElementById('session-chart');
  if (s.ear_series && s.ear_series.length) {
    sessionChartInst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: s.ear_series.map((_,i) => i),
        datasets: [
          { label: 'EAR', data: s.ear_series, borderColor: '#2979ff', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: { target: 'origin', above: 'rgba(41,121,255,0.05)' } },
          { label: 'Threshold', data: Array(s.ear_series.length).fill(s.threshold||0.17), borderColor: '#ffab00', borderDash: [5,5], borderWidth: 1.5, pointRadius: 0, fill: false },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 0.08, max: 0.4, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a5068', font: { family: 'JetBrains Mono', size: 9 } } },
          x: { display: false }
        }
      }
    });
  } else {
    ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
  }
}

function closeSessionModal() {
  document.getElementById('session-modal').classList.add('hidden');
}

function closeModal(e) {
  if (e.target === document.getElementById('session-modal')) closeSessionModal();
}

// ══ CSV EXPORT ═══════════════════════════════════════════════════
function exportCSV() {
  if (!allSessions.length) { toast('No sessions to export'); return; }
  const rows = ['Date,Driver,Duration (s),Alarms,Alert %,Mean EAR,Threshold']
    .concat(allSessions.map(s => `${s.date},${s.driver||'—'},${s.duration},${s.alarms},${s.alert_pct},${s.mean_ear},${s.threshold}`))
    .join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([rows], {type:'text/csv'})),
    download: 'drowseguard-sessions.csv',
  });
  a.click();
  toast('Exported sessions.csv');
}

// ══ CHART ════════════════════════════════════════════════════════
function initChart() {
  const ctx = document.getElementById('earChart');
  if (!ctx || window.earChart) return;
  window.earChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { data: [], borderColor: '#2979ff', borderWidth: 1.5, pointRadius: 0, fill: { target: 'origin', above: 'rgba(41,121,255,0.06)' }, tension: 0.3 },
        { data: [], borderColor: 'rgba(255,171,0,0.5)', borderWidth: 1, pointRadius: 0, borderDash: [5,5], fill: false },
      ]
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0.08, max: 0.38, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a5068', font: { family: 'JetBrains Mono', size: 9 } } },
        x: { display: false }
      }
    }
  });
}

function updateChart(d) {
  if (!window.earChart) return;
  window.earChart.data.datasets[0].data = earBuf.slice();
  window.earChart.data.datasets[1].data = Array(earBuf.length).fill(d.threshold);
  window.earChart.data.labels = earBuf.map(() => '');
  window.earChart.update('none');
}

// ── EAR trend — works at low FPS (5-6) and high FPS alike ────────
function updateTrend() {
  let trend = "—";

  // Only need 6 frames (split 3+3); kicks in after ~1s at 5 FPS
  const MIN = 6;
  if (earBuf.length >= MIN) {
    const recent   = earBuf.slice(-MIN);
    const half     = MIN / 2;
    const firstAvg = recent.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const lastAvg  = recent.slice(half).reduce((a, b) => a + b, 0) / half;

    if (lastAvg > firstAvg + 0.002) {
      trend = "↑ improving";
    } else if (lastAvg < firstAvg - 0.002) {
      trend = "↓ drowsy";
    } else {
      trend = "→ stable";
    }
  }

  const trendEl = document.getElementById('ear-trend');
  if (!trendEl) return;
  trendEl.textContent = trend;

  if (trend.includes("↑")) {
    trendEl.style.color = "var(--green)";
  } else if (trend.includes("↓")) {
    trendEl.style.color = "var(--red)";
  } else {
    trendEl.style.color = "var(--sub)";
  }
}

// ══ UI HELPERS ═══════════════════════════════════════════════════
function setBanner(type, msg) {
  const el = document.getElementById('conn-banner');
  el.className = 'conn-banner' + (type === 'hidden' ? ' hidden' : type === 'ok' ? ' ok' : '');
  el.textContent = msg;
}

// ── FIX: setIdle resets detection UI but does NOT touch ear-trend
//         (trend stays visible until next session starts fresh)
function setIdle() {
  document.getElementById('ear-num').textContent = '—';
  document.getElementById('ear-num').className = 'ear-num ok';
  document.getElementById('state-pill-wrap').innerHTML = '<span class="state-pill idle"><span class="dot"></span>IDLE</span>';
  document.getElementById('frame-fill').style.width = '0%';
  document.getElementById('frame-ct').textContent = '0 / 45';
  document.getElementById('thr-label').textContent = '— waiting —';
  document.getElementById('fps-stat').textContent = '—';
  // Reset trend when session ends so it shows fresh on next start
  const trendEl = document.getElementById('ear-trend');
  if (trendEl) { trendEl.textContent = '—'; trendEl.style.color = 'var(--sub)'; }
}

let _toastEl;
function toast(msg, type = '') {
  if (_toastEl) { _toastEl.classList.add('out'); setTimeout(() => _toastEl?.remove(), 300); }
  _toastEl = document.createElement('div');
  _toastEl.className = 'toast' + (type ? ' ' + type : '');
  _toastEl.textContent = msg;
  document.body.appendChild(_toastEl);
  setTimeout(() => { if (_toastEl) { _toastEl.classList.add('out'); setTimeout(() => _toastEl?.remove(), 300); } }, 3000);
}

// ══ BOOT ═════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!document.getElementById('form-login').classList.contains('hidden')) doLogin();
    else if (!document.getElementById('form-signup').classList.contains('hidden')) doSignup();
  });

  const saved = localStorage.getItem('dg_user');
  if (token && saved) {
    try {
      currentUser = JSON.parse(saved);
      showApp();
    } catch { localStorage.clear(); }
  }
});
