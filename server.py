import threading
import time
import json
import os
from datetime import datetime

from flask import Flask, send_from_directory, Response
from flask_socketio import SocketIO, emit

import cv2
import dlib
from scipy.spatial import distance as scipy_distance
import numpy as np
from collections import deque
import imageio

# ── Audio (optional) ─────────────────────────────────────────────
try:
    from pygame import mixer
    mixer.init()
    AUDIO_ENABLED = True
except:
    AUDIO_ENABLED = False


# ── Flask setup ─────────────────────────────────────────────────
app = Flask(__name__)
app.config['SECRET_KEY'] = 'drowseguard'
socketio = SocketIO(app, cors_allowed_origins="*")


# ── Paths ───────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(__file__)

PREDICTOR_PATH = os.path.join(BASE_DIR, 'models', 'shape_predictor_68_face_landmarks.dat')
ALARM_PATH = os.path.join(BASE_DIR, 'alarm.wav')
SESSIONS_FILE = os.path.join(BASE_DIR, 'sessions.json')
USERS_FILE = os.path.join(BASE_DIR, 'users.json')
print("Looking for model at:", PREDICTOR_PATH)
print("Exists:", os.path.exists(PREDICTOR_PATH))

# ── Config ──────────────────────────────────────────────────────
EAR_THRESHOLD = 0.17
EAR_CONSEC_FRAMES = 45
CALIBRATION_FRAMES = 150
ALARM_COOLDOWN = 1


# ── Global State ────────────────────────────────────────────────
state = {
    'calibrated': False,
    'running': False,
    'calibrating': False,
    'calib_progress': 0,
    'ear': 0.0,
    'threshold': EAR_THRESHOLD,
    'status': 'idle',
    'drowsy_frames': 0,
    'alarms': 0,
    'fps': 0.0,
    'start_time': None,
}

latest_frame = None
frame_lock = threading.Lock()

_detector_thread = None
_stop_event = threading.Event()


# ── EAR Calculation ─────────────────────────────────────────────
def calc_ear(eye):
    A = scipy_distance.euclidean(eye[1], eye[5])
    B = scipy_distance.euclidean(eye[2], eye[4])
    C = scipy_distance.euclidean(eye[0], eye[3])
    return (A + B) / (2.0 * C)


# ── Detection Thread ────────────────────────────────────────────
def run_detection():
    global latest_frame
    clip_saved_for_event = False

    try:
        face_detector = dlib.get_frontal_face_detector()
        landmark_predictor = dlib.shape_predictor(PREDICTOR_PATH)
    except Exception as e:
        socketio.emit('error', {'msg': str(e)})
        return

    alarm_sound = None
    if AUDIO_ENABLED and os.path.exists(ALARM_PATH):
        alarm_sound = mixer.Sound(ALARM_PATH)

    cap = cv2.VideoCapture(0)
    frame_buffer = deque(maxlen=40)  # ~5 seconds buffer

    if not cap.isOpened():
        socketio.emit('error', {'msg': 'Cannot open camera'})
        return

    calib_ears = []
    drowsy_frames = 0
    last_alarm = 0
    frame_times = []

    if not state['calibrated']:
        state['calibrating'] = True
    else:
        state['calibrating'] = False
        
    state['start_time'] = time.time()

    while not _stop_event.is_set():
        t0 = time.time()

        ret, frame = cap.read()
        frame_buffer.append(frame.copy())
        if not ret:
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_detector(gray)

        ear = None

        if faces:
            lm = landmark_predictor(gray, faces[0])

            left = [(lm.part(n).x, lm.part(n).y) for n in range(36, 42)]
            right = [(lm.part(n).x, lm.part(n).y) for n in range(42, 48)]

            ear = (calc_ear(left) + calc_ear(right)) / 2.0

            # Draw eyes
            color = (0, 255, 0) if ear >= state['threshold'] else (0, 0, 255)

            for eye in [left, right]:
                for i in range(len(eye)):
                    cv2.line(frame, eye[i], eye[(i+1) % len(eye)], color, 1)

        # ── Calibration ──
        if state['calibrating']:
            if ear:
                calib_ears.append(ear)

            progress = int(len(calib_ears) / CALIBRATION_FRAMES * 100)
            state['calib_progress'] = min(progress, 100)

            socketio.emit('calib_progress', {'progress': state['calib_progress']})

            if len(calib_ears) >= CALIBRATION_FRAMES:
                mean = np.mean(calib_ears)
                std = np.std(calib_ears)

                state['threshold'] = max(0.15, mean - 1.5 * std)
                state['calibrating'] = False
                state['calibrated'] = True

                socketio.emit('calibrated', {
                    'threshold': round(state['threshold'], 3)
                })

            # Save frame for UI
            with frame_lock:
                latest_frame = frame.copy()

            time.sleep(0.03)
            continue

        # ── Detection ──
        if ear:
            now = time.time()

            if ear < state['threshold']:
                drowsy_frames += 1
            else:
                drowsy_frames = 0
                clip_saved_for_event = False

            is_drowsy = drowsy_frames >= EAR_CONSEC_FRAMES

            if is_drowsy:
                if not clip_saved_for_event:
                    clip_saved_for_event = True  # lock

        
                if (now - last_alarm) > ALARM_COOLDOWN:
                    state['alarms'] += 1

                    # 🔥 SAVE CLIP
                    os.makedirs("clips", exist_ok=True)

                    buffer_copy = list(frame_buffer)

                    gif_filename = f"clips/{int(time.time())}.gif"

                    def save_gif_async(frames, path):
                        try:
                            rgb_frames = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in frames[::2]]
                            imageio.mimsave(path, rgb_frames, fps=10)
                        except Exception as e:
                            print("GIF save error:", e)

                    # 🔥 run FULL processing in background
                    threading.Thread(
                        target=save_gif_async,
                        args=(buffer_copy, gif_filename),
                        daemon=True
                    ).start()

                    state['last_clip'] = gif_filename
                    

                    if alarm_sound:
                        try:
                            alarm_sound.play()
                        except:
                            pass

                    last_alarm = now

            state['status'] = 'drowsy' if is_drowsy else 'alert'

            # Overlay text
            cv2.putText(frame, f"EAR: {round(ear,3)}",
                        (20, 40), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (255,255,255), 2)

            cv2.putText(frame, state['status'].upper(),
                        (20, 80), cv2.FONT_HERSHEY_SIMPLEX,
                        1, (0,255,0) if state['status']=="alert" else (0,0,255), 2)

            # FPS
            frame_times.append(time.time() - t0)
            if len(frame_times) > 30:
                frame_times.pop(0)

            fps = len(frame_times) / sum(frame_times) if frame_times else 0

            state.update({
                'ear': round(ear, 3),
                'drowsy_frames': drowsy_frames,
                'fps': round(fps, 1),
            })

            socketio.emit('frame', {
                'ear': state['ear'],
                'threshold': round(state['threshold'], 3),
                'status': state['status'],
                'drowsy_frames': drowsy_frames,
                'alarms': state['alarms'],
                'fps': state['fps'],
                'runtime': int(time.time() - state['start_time']),
            })

        # Save frame for streaming
        with frame_lock:
            latest_frame = frame.copy()

        time.sleep(max(0, 0.033 - (time.time() - t0)))

    cap.release()
    state['running'] = False
    state['status'] = 'idle'

    socketio.emit('stopped', {
        'alarms': state['alarms'],
        'runtime': int(time.time() - state['start_time'])
    })


# ── Video Streaming ─────────────────────────────────────────────
def generate_frames():
    global latest_frame

    while True:
        with frame_lock:
            if latest_frame is None:
                time.sleep(0.01)
                continue
            frame = latest_frame.copy()

        _, buffer = cv2.imencode('.jpg', frame)
        frame_bytes = buffer.tobytes()

        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')


@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')


# ── Routes ──────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/clips/<path:filename>')
def serve_clip(filename):
    return send_from_directory('clips', filename)

# ── Socket Events ───────────────────────────────────────────────
@socketio.on('start')
def start():
    global _detector_thread

    if state['running']:
        return

    _stop_event.clear()
    state['running'] = True
    state['alarms'] = 0

    _detector_thread = threading.Thread(target=run_detection, daemon=True)
    _detector_thread.start()

    emit('started', {})


@socketio.on('stop')
def stop():
    _stop_event.set()


@socketio.on('save_session')
def save_session(data):
    sessions = []

    # Load existing sessions
    if os.path.exists(SESSIONS_FILE):
        try:
            with open(SESSIONS_FILE, 'r') as f:
                sessions = json.load(f)
        except:
            sessions = []

    # Create new session
    session = {
        'date': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'duration': data.get('runtime', 0),
        'alarms': data.get('alarms', 0),
        'mean_ear': data.get('mean_ear', 0),
        'threshold': data.get('threshold', state['threshold']),
        'alert_pct': data.get('alert_pct', 100),
        'clip': state.get('last_clip', None),
        'ear_series': data.get('ear_series', []),
    }

    sessions.insert(0, session)

    # Save (keep last 50)
    with open(SESSIONS_FILE, 'w') as f:
        json.dump(sessions[:50], f, indent=2)

    # Send back to UI
    emit('sessions', sessions[:50])
    
@socketio.on('get_sessions')
def get_sessions():
    sessions = []

    if os.path.exists(SESSIONS_FILE):
        try:
            with open(SESSIONS_FILE, 'r') as f:
                sessions = json.load(f)
        except:
            sessions = []

    emit('sessions', sessions)
    
@socketio.on('save_user_threshold')
def save_user_threshold(data):
    username = data['user']
    threshold = data['threshold']

    users = {}

    # load existing users
    if os.path.exists(USERS_FILE):
        with open(USERS_FILE, 'r') as f:
            users = json.load(f)

    # update user
    users[username] = {
        'threshold': threshold
    }

    # save back
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=2)
        
@socketio.on('load_user')
def load_user(data):
    username = data['user']

    if os.path.exists(USERS_FILE):
        with open(USERS_FILE, 'r') as f:
            users = json.load(f)

        if username in users:
            state['threshold'] = users[username]['threshold']
            state['calibrated'] = True

            emit('user_loaded', {
                'threshold': state['threshold']
            })

# ── Run ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("\n🚀 Server running at http://localhost:5000\n")
    socketio.run(app, host='0.0.0.0', port=5000)