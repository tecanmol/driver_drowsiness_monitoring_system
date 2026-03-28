import threading
import time
import json
import os
import hashlib
import secrets
from datetime import datetime

from flask import Flask, send_from_directory, Response, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room

import cv2
import dlib
from scipy.spatial import distance as scipy_distance
import numpy as np
from collections import deque
try:
    import imageio
    IMAGEIO_AVAILABLE = True
except ImportError:
    IMAGEIO_AVAILABLE = False
    print("⚠ imageio not installed — GIF clips disabled. Run: pip install imageio")

# ── Audio (optional) ─────────────────────────────────────────────
try:
    from pygame import mixer
    mixer.init()
    AUDIO_ENABLED = True
except:
    AUDIO_ENABLED = False

# Load alarm sound once at module level so it survives thread restarts
_alarm_sound = None

# ── Flask setup ─────────────────────────────────────────────────
app = Flask(__name__)
app.config['SECRET_KEY'] = 'drowseguard-secret-2024'
socketio = SocketIO(app, cors_allowed_origins="*")

# ── Paths ───────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(__file__)
PREDICTOR_PATH = os.path.join(BASE_DIR, 'models', 'shape_predictor_68_face_landmarks.dat')
ALARM_PATH = os.path.join(BASE_DIR, 'alarm.wav')
USERS_FILE = os.path.join(BASE_DIR, 'users.json')
SESSIONS_FILE = os.path.join(BASE_DIR, 'sessions.json')

# ── Config ──────────────────────────────────────────────────────
EAR_THRESHOLD = 0.17
EAR_CONSEC_FRAMES = 45
CALIBRATION_FRAMES = 150
ALARM_COOLDOWN = 1

# Load alarm sound once at module level — survives across thread restarts
if AUDIO_ENABLED and os.path.exists(ALARM_PATH):
    try:
        _alarm_sound = mixer.Sound(ALARM_PATH)
    except Exception as e:
        print(f"⚠ Could not load alarm sound: {e}")
        _alarm_sound = None

# ── Per-driver detection state ───────────────────────────────────
driver_states = {}  # sid -> state dict
latest_frame = None
frame_lock = threading.Lock()
_detector_threads = {}  # sid -> thread
_stop_events = {}       # sid -> Event

# ── Token store ─────────────────────────────────────────────────
active_tokens = {}  # token -> username


def hash_password(pw):
    return hashlib.sha256(pw.encode()).hexdigest()

def load_users():
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE) as f:
                return json.load(f)
        except:
            pass
    return {}

def save_users(users):
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=2)

def load_sessions():
    if os.path.exists(SESSIONS_FILE):
        try:
            with open(SESSIONS_FILE) as f:
                return json.load(f)
        except:
            pass
    return []

def save_sessions(sessions):
    with open(SESSIONS_FILE, 'w') as f:
        json.dump(sessions, f, indent=2)

def get_user_from_token(token):
    return active_tokens.get(token)

# ── EAR Calculation ─────────────────────────────────────────────
def calc_ear(eye):
    A = scipy_distance.euclidean(eye[1], eye[5])
    B = scipy_distance.euclidean(eye[2], eye[4])
    C = scipy_distance.euclidean(eye[0], eye[3])
    return (A + B) / (2.0 * C)

# ── Auth REST endpoints ──────────────────────────────────────────
@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.json
    username = data.get('username', '').strip().lower()
    password = data.get('password', '')
    role = data.get('role', 'driver')
    manager = data.get('manager', None)

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400

    users = load_users()
    if username in users:
        return jsonify({'error': 'Username already taken'}), 409

    if role == 'driver' and manager:
        mgr_user = users.get(manager)
        if not mgr_user or mgr_user.get('role') != 'admin':
            return jsonify({'error': 'Selected manager not found'}), 400

    users[username] = {
        'password': hash_password(password),
        'role': role,
        'name': data.get('name', username),
        'created': datetime.now().isoformat(),
        'threshold': EAR_THRESHOLD,
        'calibrated': False,
        'manager': manager if role == 'driver' else None,
    }
    save_users(users)

    token = secrets.token_hex(32)
    active_tokens[token] = username

    return jsonify({
        'token': token,
        'username': username,
        'role': role,
        'name': users[username]['name'],
        'threshold': users[username]['threshold'],
        'calibrated': users[username]['calibrated'],
        'manager': users[username]['manager'],
    })

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username', '').strip().lower()
    password = data.get('password', '')

    users = load_users()
    user = users.get(username)

    if not user or user['password'] != hash_password(password):
        return jsonify({'error': 'Invalid username or password'}), 401

    token = secrets.token_hex(32)
    active_tokens[token] = username

    return jsonify({
        'token': token,
        'username': username,
        'role': user.get('role', 'driver'),
        'name': user.get('name', username),
        'threshold': user.get('threshold', EAR_THRESHOLD),
        'calibrated': user.get('calibrated', False),
        'manager': user.get('manager', None),
    })

@app.route('/api/admins', methods=['GET'])
def get_admins():
    users = load_users()
    admins = [
        {'username': uname, 'name': udata.get('name', uname)}
        for uname, udata in users.items()
        if udata.get('role') == 'admin'
    ]
    return jsonify(admins)

@app.route('/api/drivers', methods=['GET'])
def get_drivers():
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    user = get_user_from_token(token)
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    users = load_users()
    if users[user].get('role') != 'admin':
        return jsonify({'error': 'Forbidden'}), 403

    drivers = []
    for uname, udata in users.items():
        if udata.get('role') == 'driver' and udata.get('manager') == user:
            drivers.append({
                'username': uname,
                'name': udata.get('name', uname),
                'calibrated': udata.get('calibrated', False),
                'threshold': udata.get('threshold', EAR_THRESHOLD),
                'created': udata.get('created', ''),
                'manager': udata.get('manager', None),
            })
    return jsonify(drivers)

@app.route('/api/sessions', methods=['GET'])
def get_sessions_api():
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    username = get_user_from_token(token)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401

    users = load_users()
    role = users[username].get('role', 'driver')

    all_sessions = load_sessions()

    if role == 'admin':
        my_drivers = {
            uname for uname, udata in users.items()
            if udata.get('role') == 'driver' and udata.get('manager') == username
        }
        return jsonify([s for s in all_sessions if s.get('driver') in my_drivers])
    else:
        my_sessions = [s for s in all_sessions if s.get('driver') == username]
        return jsonify(my_sessions)

# ── Static routes ────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/style.css')
def serve_css():
    return send_from_directory('static', 'style.css')

@app.route('/script.js')
def serve_js():
    return send_from_directory('static', 'script.js')

@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)

@app.route('/clips/<path:filename>')
def serve_clip(filename):
    clips_dir = os.path.join(BASE_DIR, 'clips')
    return send_from_directory(clips_dir, filename)

# ── Video Streaming ─────────────────────────────────────────────
def generate_frames():
    while True:
        with frame_lock:
            if latest_frame is None:
                time.sleep(0.01)
                continue
            frame = latest_frame.copy()
        _, buffer = cv2.imencode('.jpg', frame)
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

# ── Detection Thread ─────────────────────────────────────────────
def run_detection(sid, username, threshold, already_calibrated):
    """
    already_calibrated=True  → skip calibration, go straight to detection
    already_calibrated=False → run calibration first (always, even if user was
                               previously calibrated — used for recalibration)
    """
    global latest_frame

    try:
        face_detector = dlib.get_frontal_face_detector()
        landmark_predictor = dlib.shape_predictor(PREDICTOR_PATH)
    except Exception as e:
        socketio.emit('error', {'msg': str(e)}, to=sid)
        return

    # Use the module-level alarm sound (loaded once, reused across restarts)
    alarm_sound = _alarm_sound

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        socketio.emit('error', {'msg': 'Cannot open camera'}, to=sid)
        return

    stop_event = _stop_events.get(sid)
    state = driver_states[sid]
    state['start_time'] = time.time()

    if already_calibrated:
        state['calibrating'] = False
        state['threshold'] = threshold
    else:
        state['calibrating'] = True

    calib_ears = []
    drowsy_frames = 0
    last_alarm = 0
    frame_times = []
    frame_buffer = deque(maxlen=90)
    session_clips = []
    clip_saved_for_event = False

    def save_gif(frames, path):
        if not IMAGEIO_AVAILABLE:
            return
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            sampled = frames[::2]
            rgb = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in sampled]
            h, w = rgb[0].shape[:2]
            scale = 320 / w
            nh, nw = int(h * scale), 320
            rgb_small = [cv2.resize(f, (nw, nh)) for f in rgb]
            imageio.mimsave(path, rgb_small, fps=10, loop=0)
        except Exception as e:
            print(f"GIF save error: {e}")

    while not stop_event.is_set():
        t0 = time.time()
        ret, frame = cap.read()
        if not ret:
            continue

        frame_buffer.append(frame.copy())

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_detector(gray)
        ear = None

        if faces:
            lm = landmark_predictor(gray, faces[0])
            left = [(lm.part(n).x, lm.part(n).y) for n in range(36, 42)]
            right = [(lm.part(n).x, lm.part(n).y) for n in range(42, 48)]
            ear = (calc_ear(left) + calc_ear(right)) / 2.0
            color = (0, 255, 0) if ear >= state['threshold'] else (0, 0, 255)
            for eye in [left, right]:
                for i in range(len(eye)):
                    cv2.line(frame, eye[i], eye[(i+1) % len(eye)], color, 1)

        if state['calibrating']:
            if ear:
                calib_ears.append(ear)
            progress = int(len(calib_ears) / CALIBRATION_FRAMES * 100)
            state['calib_progress'] = min(progress, 100)
            socketio.emit('calib_progress', {'progress': state['calib_progress']}, to=sid)

            if len(calib_ears) >= CALIBRATION_FRAMES:
                mean = np.mean(calib_ears)
                std = np.std(calib_ears)
                new_threshold = max(0.15, mean - 1.5 * std)
                state['threshold'] = new_threshold
                state['calibrating'] = False
                state['calibrated'] = True

                users = load_users()
                if username in users:
                    users[username]['threshold'] = round(new_threshold, 3)
                    users[username]['calibrated'] = True
                    save_users(users)

                socketio.emit('calibrated', {'threshold': round(new_threshold, 3)}, to=sid)

            with frame_lock:
                latest_frame = frame.copy()
            time.sleep(0.03)
            continue

        if ear:
            now = time.time()
            if ear < state['threshold']:
                drowsy_frames += 1
            else:
                drowsy_frames = 0

            is_drowsy = drowsy_frames >= EAR_CONSEC_FRAMES

            if not is_drowsy:
                clip_saved_for_event = False

            if is_drowsy and (now - last_alarm) > ALARM_COOLDOWN:
                state['alarms'] += 1
                if alarm_sound:
                    try:
                        alarm_sound.play()
                    except:
                        pass
                last_alarm = now

                if not clip_saved_for_event:
                    clip_saved_for_event = True
                    snap = list(frame_buffer)
                    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
                    clip_rel = f"{username}/{ts}.gif"
                    clip_abs = os.path.join(BASE_DIR, 'clips', clip_rel)
                    threading.Thread(
                        target=save_gif,
                        args=(snap, clip_abs),
                        daemon=True,
                    ).start()
                    session_clips.append(clip_rel)
                    state['last_clip'] = clip_rel

                users = load_users()
                driver_manager = users.get(username, {}).get('manager')
                alert_room = f'admin_room_{driver_manager}' if driver_manager else 'admin_room'

                socketio.emit('driver_alert', {
                    'driver': username,
                    'ear': round(ear, 3),
                    'timestamp': datetime.now().strftime('%H:%M:%S'),
                    'clip': state.get('last_clip'),
                }, to=alert_room)

            state['status'] = 'drowsy' if is_drowsy else 'alert'

            cv2.putText(frame, f"EAR: {round(ear,3)}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)
            cv2.putText(frame, state['status'].upper(), (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 1,
                        (0,255,0) if state['status'] == "alert" else (0,0,255), 2)

            frame_times.append(time.time() - t0)
            if len(frame_times) > 30:
                frame_times.pop(0)
            fps = len(frame_times) / sum(frame_times) if frame_times else 0

            state.update({'ear': round(ear, 3), 'drowsy_frames': drowsy_frames, 'fps': round(fps, 1)})

            socketio.emit('frame', {
                'ear': state['ear'],
                'threshold': round(state['threshold'], 3),
                'status': state['status'],
                'drowsy_frames': drowsy_frames,
                'alarms': state['alarms'],
                'fps': state['fps'],
                'runtime': int(time.time() - state['start_time']),
                'driver': username,
            }, to=sid)

            users = load_users()
            driver_manager = users.get(username, {}).get('manager')
            status_room = f'admin_room_{driver_manager}' if driver_manager else 'admin_room'
            socketio.emit('driver_status', {
                'driver': username,
                'ear': round(ear, 3),
                'status': state['status'],
                'alarms': state['alarms'],
            }, to=status_room)

        with frame_lock:
            latest_frame = frame.copy()
        time.sleep(max(0, 0.033 - (time.time() - t0)))

    cap.release()
    state['running'] = False
    state['status'] = 'idle'
    socketio.emit('stopped', {
        'alarms': state['alarms'],
        'runtime': int(time.time() - state['start_time']),
        'clips': session_clips,
    }, to=sid)

# ── Socket Events ────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    pass

@socketio.on('auth')
def on_auth(data):
    token = data.get('token')
    username = get_user_from_token(token)
    if not username:
        emit('auth_error', {'msg': 'Invalid session. Please log in again.'})
        return

    users = load_users()
    user = users.get(username, {})
    role = user.get('role', 'driver')

    if role == 'admin':
        join_room(f'admin_room_{username}')
        join_room('admin_room')
        emit('auth_ok', {'username': username, 'role': role, 'name': user.get('name', username)})
        return

    sid = request.sid
    driver_states[sid] = {
        'running': False, 'calibrating': False, 'calibrated': user.get('calibrated', False),
        'calib_progress': 0, 'ear': 0.0, 'threshold': user.get('threshold', EAR_THRESHOLD),
        'status': 'idle', 'drowsy_frames': 0, 'alarms': 0, 'fps': 0.0, 'start_time': None,
    }
    emit('auth_ok', {
        'username': username, 'role': role, 'name': user.get('name', username),
        'threshold': user.get('threshold', EAR_THRESHOLD),
        'calibrated': user.get('calibrated', False),
        'manager': user.get('manager', None),
    })

@socketio.on('start')
def on_start(data=None):
    sid = request.sid
    token = (data or {}).get('token')
    # ── FIX: read force_calibrate flag sent by the client ──────────
    force_calibrate = (data or {}).get('force_calibrate', False)

    username = get_user_from_token(token)
    if not username or sid not in driver_states:
        return

    state = driver_states[sid]
    if state['running']:
        return

    users = load_users()
    user = users.get(username, {})

    _stop_events[sid] = threading.Event()
    state['running'] = True
    state['alarms'] = 0
    _stop_events[sid].clear()

    # ── FIX: if force_calibrate is True, treat as uncalibrated ─────
    already_calibrated = user.get('calibrated', False) and not force_calibrate

    t = threading.Thread(
        target=run_detection,
        args=(sid, username, state['threshold'], already_calibrated),
        daemon=True,
    )
    _detector_threads[sid] = t
    t.start()
    emit('started', {})

@socketio.on('stop')
def on_stop():
    sid = request.sid
    if sid in _stop_events:
        _stop_events[sid].set()

@socketio.on('save_session')
def on_save_session(data):
    token = data.get('token')
    username = get_user_from_token(token)
    if not username:
        return

    users = load_users()
    manager = users.get(username, {}).get('manager', None)

    sessions = load_sessions()
    session = {
        'id': secrets.token_hex(8),
        'driver': username,
        'manager': manager,
        'date': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'duration': data.get('runtime', 0),
        'alarms': data.get('alarms', 0),
        'mean_ear': data.get('mean_ear', 0),
        'threshold': data.get('threshold', EAR_THRESHOLD),
        'alert_pct': data.get('alert_pct', 100),
        'ear_series': data.get('ear_series', []),
        'clips': data.get('clips', []),
    }
    sessions.insert(0, session)
    save_sessions(sessions[:200])
    emit('session_saved', session)

@socketio.on('get_sessions')
def on_get_sessions(data=None):
    token = (data or {}).get('token')
    username = get_user_from_token(token)
    if not username:
        return

    users = load_users()
    role = users.get(username, {}).get('role', 'driver')
    all_sessions = load_sessions()

    if role == 'admin':
        my_drivers = {
            uname for uname, udata in users.items()
            if udata.get('role') == 'driver' and udata.get('manager') == username
        }
        emit('sessions', [s for s in all_sessions if s.get('driver') in my_drivers])
    else:
        emit('sessions', [s for s in all_sessions if s.get('driver') == username])

@socketio.on('admin_join')
def on_admin_join(data):
    token = data.get('token')
    username = get_user_from_token(token)
    if not username:
        return
    users = load_users()
    if users.get(username, {}).get('role') == 'admin':
        join_room(f'admin_room_{username}')
        join_room('admin_room')
        active = []
        for sid, st in driver_states.items():
            if st['running']:
                active.append({'driver': sid, 'status': st['status'], 'ear': st['ear']})
        emit('active_drivers', active)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if sid in _stop_events:
        _stop_events[sid].set()
    driver_states.pop(sid, None)

if __name__ == '__main__':
    print("\n🚀 DrowseGuard Multi-Driver Server at http://localhost:5000\n")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
