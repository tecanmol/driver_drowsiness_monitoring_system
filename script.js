const user = localStorage.getItem('user') || "driver1";
// ── Socket.IO connection ───────────────────────────────────────────────────
const socket = io();

let running = false;
let currentThreshold = 0.16;
let earBuf = [];
let prevEAR = null;
// ── Connection state ──
socket.on('connect', () => {
  setBanner('ok', '✓ Connected to backend');
  socket.emit('load_user', { user });
  setTimeout(() => setBanner('hidden', ''), 2000);
  document.getElementById('main-btn').disabled = false;
  document.getElementById('calib-btn').disabled = false;
  document.getElementById('sys-dot').style.background = 'var(--green)';
});

socket.on('user_loaded', (d) => {
  currentThreshold = d.threshold;

  document.getElementById('thr-label').textContent =
    'threshold ' + d.threshold.toFixed(3);
});

socket.on('disconnect', () => {
  setBanner('warn', '⚡ Disconnected — is server.py running?');
  document.getElementById('sys-dot').style.background = 'var(--red)';
  document.getElementById('main-btn').disabled = true;
  document.getElementById('calib-btn').disabled = true;
});

socket.on('error', (d) => toast('Error: ' + d.msg));

// ── Detection ──
socket.on('started', () => {
  running = true;
  earBuf = [];
  document.getElementById('main-btn').textContent = '⏹  Stop Detection';
  document.getElementById('main-btn').className   = 'btn stop';
  const label = document.getElementById('cam-label');
  if (label) label.textContent = 'Camera active';
  document.getElementById('sys-dot').style.background = 'var(--amber)';
  document.getElementById('detect-feed').style.display = 'block';
});

socket.on('frame', (d) => {
  currentThreshold = d.threshold;

  earBuf.push(d.ear);
  if (earBuf.length > 300) earBuf.shift();

  // EAR number + colour
  const n = document.getElementById('ear-num');
  n.textContent = d.ear.toFixed(3);
  n.className = 'ear-num ' + (d.ear < d.threshold ? 'bad' : d.ear < d.threshold + 0.03 ? 'warn' : 'ok');

  // State pill
  document.getElementById('state-pill-wrap').innerHTML = d.status === 'drowsy'
    ? '<span class="state-pill drowsy"><span class="dot"></span>DROWSY</span>'
    : '<span class="state-pill alert"><span class="dot"></span>ALERT</span>';

  // Threshold label
  document.getElementById('thr-label').textContent = 'threshold ' + d.threshold.toFixed(3);

  // 3-second filter bar
  document.getElementById('frame-fill').style.width = (d.drowsy_frames / 45 * 100) + '%';
  document.getElementById('frame-ct').textContent = d.drowsy_frames + ' / 45';

  // Stats
  document.getElementById('alarm-ct').textContent = d.alarms;
  document.getElementById('fps-stat').textContent  = d.fps;

  // Runtime
  const secs = d.runtime;
  const m = Math.floor(secs / 60), s = secs % 60;
  document.getElementById('runtime').textContent =
    String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');

  // Mean EAR
  const mean = earBuf.reduce((a, b) => a + b, 0) / earBuf.length;
  document.getElementById('mean-ear').textContent = 'mean ' + mean.toFixed(3);

  // Chart
  if (window.earChart && window.earChart.data) {
    window.earChart.data.datasets[0].data = earBuf.slice();
    window.earChart.data.datasets[1].data = Array(earBuf.length).fill(d.threshold);
    window.earChart.data.labels = earBuf.map(() => '');
    window.earChart.update('none');
  }

// ── TREND LOGIC (FINAL FIX) ──
let trend = "—";

if (earBuf.length > 10) {
  const recent = earBuf.slice(-10);

  const firstAvg = recent.slice(0, 5).reduce((a,b)=>a+b,0)/5;
  const lastAvg  = recent.slice(5).reduce((a,b)=>a+b,0)/5;

  if (lastAvg > firstAvg + 0.002) {
    trend = "↑ improving";
  } else if (lastAvg < firstAvg - 0.002) {
    trend = "↓ drowsy";
  } else {
    trend = "→ stable";
  }
}

console.log("TREND:", trend); // debug

const trendEl = document.getElementById('ear-trend');
trendEl.textContent = trend;

if (trend.includes("↑")) {
  trendEl.style.color = "var(--green)";
} else if (trend.includes("↓")) {
  trendEl.style.color = "var(--red)";
} else {
  trendEl.style.color = "var(--muted)";
}
});

socket.on('stopped', (d) => {
  running = false;
  document.getElementById('main-btn').textContent = '▶  Start Detection';
  document.getElementById('main-btn').className   = 'btn start';
  const label = document.getElementById('cam-label');
  if (label) label.textContent = 'Camera active';
  document.getElementById('sys-dot').style.background = 'var(--green)';
  document.getElementById('detect-feed').style.display = 'none';
  setIdle();

  // Save session
  const alertFrames = earBuf.filter(e => e >= currentThreshold).length;
  const alertPct    = earBuf.length ? Math.round(alertFrames / earBuf.length * 100) : 100;
  const meanEar     = earBuf.length ? +(earBuf.reduce((a, b) => a + b, 0) / earBuf.length).toFixed(3) : 0;
  socket.emit('save_session', {
    runtime: d.runtime, alarms: d.alarms,
    mean_ear: meanEar, threshold: currentThreshold, alert_pct: alertPct,
    ear_series: earBuf
  });

  toast('Session ended — ' + d.alarms + ' alarm' + (d.alarms !== 1 ? 's' : ''));
});

// ── Calibration ──
socket.on('calib_progress', (d) => {
  const total = 408;
  document.getElementById('ring').style.strokeDashoffset = total - (total * d.progress / 100);
  document.getElementById('calib-pct').textContent = d.progress + '%';
  document.getElementById('calib-sub').textContent  = 'collecting';
});

socket.on('calibrated', (d) => {
  currentThreshold = d.threshold;

  document.getElementById('ring').style.strokeDashoffset = 0;
  document.getElementById('calib-pct').textContent = '✓';
  document.getElementById('calib-sub').textContent = 'done';
  document.getElementById('calib-result').style.display = 'flex';
  document.getElementById('calib-val').textContent = d.threshold.toFixed(3);
  document.getElementById('calib-feed').style.display = 'none';

  toast('Calibration complete');
  socket.emit('save_user_threshold', {
    user,
    threshold: d.threshold
  });
  // 🛑 STOP detection after calibration
  socket.emit('stop');
});

// ── Sessions ──
socket.on('sessions', renderSessions);

// ── UI helpers ─────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('page-' + id).classList.add('active');

  // 🔥 IMPORTANT FIX
  if (id !== 'detect') {
    document.getElementById('detect-feed').style.display = 'none';
  }
  if (id !== 'calibrate') {
    document.getElementById('calib-feed').style.display = 'none';
  }

  document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.textContent.toLowerCase().includes(id.slice(0, 4))) {
      b.classList.add('active');
    }
  });

  if (id === 'detect') setTimeout(initChart, 50);
}

function setBanner(type, msg) {
  const el = document.getElementById('conn-banner');
  el.className = 'conn-banner' + (type === 'hidden' ? ' hidden' : type === 'ok' ? ' ok' : '');
  el.innerHTML = msg;
}

function setIdle() {
  document.getElementById('ear-num').textContent = '—';
  document.getElementById('ear-num').className   = 'ear-num ok';
  document.getElementById('state-pill-wrap').innerHTML =
    '<span class="state-pill idle"><span class="dot"></span>IDLE</span>';
  document.getElementById('frame-fill').style.width = '0%';
  document.getElementById('frame-ct').textContent   = '0 / 45';
  document.getElementById('thr-label').textContent  = '— waiting —';
  document.getElementById('fps-stat').textContent   = '—';
}

function toggleDetect() {
  if (!running) socket.emit('start');
  else          socket.emit('stop');
}

function startCalib() {
  // Always stop detection first
  socket.emit('stop');

  // Reset UI
  document.getElementById('calib-pct').textContent = '0%';
  document.getElementById('calib-sub').textContent = 'collecting';
  document.getElementById('ring').style.strokeDashoffset = '408';
  document.getElementById('calib-result').style.display = 'none';

  // Start backend (will auto-calibrate first)
  setTimeout(() => {
    socket.emit('start');
    document.getElementById('calib-feed').style.display = 'block';
  }, 500);
}

function loadSessions() { socket.emit('get_sessions'); }

function renderSessions(data) {
  const list  = document.getElementById('session-list');
  const count = document.getElementById('sessions-count');
  if (!data || !data.length) {
    list.innerHTML  = '<div class="empty">No sessions yet — start detecting to record one.</div>';
    count.textContent = '0 sessions';
    return;
  }
  count.textContent = data.length + ' session' + (data.length !== 1 ? 's' : '');
  list.innerHTML = data.map(s => {
    const sec = s.duration || 0;
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const sc  = sec % 60;
    const dur = (h > 0 ? h + 'h ' : '') + m + 'm ' + sc + 's';
    const ok  = (s.alert_pct || 0) >= 90;
    const col = s.alarms > 10 ? 'var(--red)' : s.alarms > 3 ? 'var(--amber)' : 'var(--green)';
    return `
      <div class="session-item" onclick='openSession(${JSON.stringify(s)})'>
          ${s.clip ? `
          <img src="/${s.clip}" width="180" style="margin-top:6px;border-radius:6px"/>
        ` : ''}
        <div class="session-dot" style="background:${ok ? 'var(--green)' : 'var(--red)'}"></div>
        <div class="session-main">
          <div class="session-time">${s.date}</div>
          <div class="session-dur">${dur}</div>
        </div>
        <div style="text-align:right">
          <div class="session-pct" style="color:${col}">${s.alarms} alarm${s.alarms !== 1 ? 's' : ''}</div>
          <div class="session-pct">${s.alert_pct || 0}% alert</div>
        </div>
      </div>`;
  }).join('');
}

function exportCSV() {
  socket.emit('get_sessions');
  socket.once('sessions', (data) => {
    if (!data.length) { toast('No sessions to export'); return; }
    const rows = ['Date,Duration (s),Alarms,Alert %,Mean EAR,Threshold']
      .concat(data.map(s => `${s.date},${s.duration},${s.alarms},${s.alert_pct},${s.mean_ear},${s.threshold}`))
      .join('\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([rows], { type: 'text/csv' })),
      download: 'sessions.csv',
    });
    a.click();
    toast('Exported sessions.csv');
  });
}

// ── Chart ──────────────────────────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('earChart');
  if (!ctx || window.earChart) return;
  window.earChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { data: [], borderColor: '#3b82f6', borderWidth: 1.5, pointRadius: 0,
          fill: { target: 'origin', above: 'rgba(59,130,246,0.06)' }, tension: 0.3 },
        { data: [], borderColor: 'rgba(245,158,11,0.4)', borderWidth: 1,
          pointRadius: 0, borderDash: [5, 5], fill: false },
      ]
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0.08, max: 0.38,
             grid: { color: 'rgba(255,255,255,0.04)' },
             ticks: { color: '#6b7280', font: { family: 'Space Mono', size: 9 } } },
        x: { display: false }
      }
    }
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastEl;
function toast(msg) {
  if (_toastEl) { _toastEl.classList.add('out'); setTimeout(() => _toastEl && _toastEl.remove(), 300); }
  _toastEl = document.createElement('div');
  _toastEl.className = 'toast';
  _toastEl.textContent = msg;
  document.body.appendChild(_toastEl);
  setTimeout(() => {
    if (_toastEl) { _toastEl.classList.add('out'); setTimeout(() => _toastEl && _toastEl.remove(), 300); }
  }, 2800);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('detect-feed').style.display = 'none';
  document.getElementById('calib-feed').style.display = 'none';
  setTimeout(initChart, 100);
});

function showAnalytics(session) {

  console.log("SESSION DATA:", session);
  console.log("EAR length:", session.ear_series.length);

  if (!session.ear_series || session.ear_series.length === 0) {
    toast("No EAR data for this session");
    return;
  }

  const container = document.getElementById('analyticsContainer');


  const canvas = document.getElementById('analyticsChart');
  const ctx = canvas.getContext('2d');

  window.analyticsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: session.ear_series.map((_, i) => i),
      datasets: [
        {
          label: 'EAR',
          data: session.ear_series,
          borderColor: '#3b82f6',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Threshold',
          data: Array(session.ear_series.length).fill(session.threshold),
          borderColor: 'orange',
          borderDash: [5,5],
          borderWidth: 2,
          pointRadius: 0
        },
        {
          label: 'Alarms',
          data: session.ear_series.map((v, i) => 
            v < session.threshold ? v : null
          ),
          pointBackgroundColor: 'red',
          pointRadius: 4,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true }
      },
      scales: {
        y: {
          min: 0.1,
          max: 0.4
        }
      }
    }
  });

  console.log("✅ FORCED chart render");
}

function openSession(s) {
  showAnalytics(s);
}