const statusEl = document.getElementById("status");
const log = (msg) => { statusEl.textContent = msg; console.log(msg); };

window.addEventListener("error", e => log("ERROR: " + e.message));
window.addEventListener("unhandledrejection", e =>
  log("ERROR: " + (e.reason?.message || e.reason)));

log("1/3 script.js berjalan…");

// ====== 1. KONFIGURASI ======
const firebaseConfig = {
  apiKey: "AIzaSyDSmLKGhQKeBgwh38kW9e3MxbP4fR5C9Vo",
  authDomain: "expense-traker-mahasiswa.firebaseapp.com",
  projectId: "expense-traker-mahasiswa",
  storageBucket: "expense-traker-mahasiswa.firebasestorage.app",
  messagingSenderId: "6440253128",
  appId: "1:6440253128:web:6b6879fdbf5b3d5ef657fd"
};
const COLLECTION = "detections";
const MIN_SCORE = 0.6;
const COOLDOWN_MS = 5000;
const HISTORY_LIMIT = 20;


const video     = document.getElementById("video");
const overlay   = document.getElementById("overlay");
const ctx       = overlay.getContext("2d");
const liveEl    = document.querySelector("#live span");
const dbStatus  = document.getElementById("db-status");
const dbText    = dbStatus.querySelector("span");
const camBtn    = document.getElementById("btn-camera");
const switchBtn = document.getElementById("btn-switch");
const flashBtn  = document.getElementById("btn-flash");
const detectBtn = document.getElementById("btn-detect");
const clearBtn  = document.getElementById("clear");
const listEl    = document.getElementById("list");

let model = null;
let stream = null;
let running = false;   // kamera menyala
let detecting = false; // deteksi menyala
let flashOn = false;
let loopActive = false;
let facing = "environment"; // "environment" = belakang, "user" = depan
let fb = null; // diisi kalau Firebase berhasil
const lastSaved = {};

async function loadModel() {
  try {
    log(`2/3 Memuat model… (tf: ${typeof tf}, cocoSsd: ${typeof cocoSsd})`);
    if (typeof tf === "undefined" || typeof cocoSsd === "undefined") {
      throw new Error("Library TensorFlow/COCO-SSD tidak termuat dari CDN. Cek koneksi internet.");
    }
    await tf.ready();
    model = await cocoSsd.load();
    log("Model siap. Tekan tombol Kamera.");
    updateButtons();
  } catch (err) {
    log("GAGAL memuat model: " + err.message);
    console.error(err);
  }
}

// ====== 4. FIREBASE (dimuat terpisah, tidak menghalangi model) ======
async function initFirebase() {
  try {
    const base = "https://www.gstatic.com/firebasejs/10.12.2/";
    const appMod = await import(base + "firebase-app.js");
    const fs = await import(base + "firebase-firestore.js");

    const app = appMod.initializeApp(firebaseConfig);
    const db = fs.getFirestore(app);
    const ref = fs.collection(db, COLLECTION);
    fb = { fs, db, ref };

    const q = fs.query(ref, fs.orderBy("createdAt", "desc"), fs.limit(HISTORY_LIMIT));
    fs.onSnapshot(q, renderHistory, err => {
      console.error(err);
      dbText.textContent = "Firebase: " + (err.code || "gagal");
      dbStatus.className = "badge offline";
    });
  } catch (err) {
    console.error(err);
    dbText.textContent = "Firebase gagal";
    dbStatus.className = "badge offline";
  }
}

function renderHistory(snap) {
  dbText.textContent = "Terhubung";
  dbStatus.className = "badge online";
  listEl.innerHTML = "";
  if (snap.empty) {
    listEl.innerHTML = '<li class="empty">Belum ada riwayat. Arahkan kamera ke sebuah objek.</li>';
    return;
  }
  snap.forEach(doc => {
    const d = doc.data();
    const time = d.createdAt ? d.createdAt.toDate().toLocaleString("id-ID") : "menyimpan…";
    const li = document.createElement("li");
    li.innerHTML = `
      <img src="${d.image || ""}" alt="${d.label}">
      <div>
        <div class="label">${d.label}</div>
        <div class="meta">${time}</div>
      </div>
      <span class="score">${Math.round(d.score * 100)}%</span>
      <button class="del" data-id="${doc.id}" title="Hapus">
        <i class="fa-solid fa-trash-can"></i>
      </button>`;
    listEl.appendChild(li);
  });
}

// Hapus satu item riwayat
listEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".del");
  if (!btn || !fb) return;
  btn.disabled = true;
  try {
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, COLLECTION, btn.dataset.id));
  } catch (err) {
    console.error("Gagal menghapus:", err);
    btn.disabled = false;
  }
});

async function saveDetection(p) {
  if (!fb) return;
  const now = Date.now();
  if (now - (lastSaved[p.class] || 0) < COOLDOWN_MS) return;
  lastSaved[p.class] = now;
  try {
    await fb.fs.addDoc(fb.ref, {
      label: p.class,
      score: Number(p.score.toFixed(2)),
      image: snapshot(),
      createdAt: fb.fs.serverTimestamp()
    });
  } catch (err) {
    console.error("Gagal menyimpan:", err);
  }
}

function snapshot() {
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = Math.round(160 * video.videoHeight / video.videoWidth);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.6);
}

// Hapus semua riwayat
clearBtn.addEventListener("click", async () => {
  if (!fb || !confirm("Hapus semua riwayat deteksi?")) return;
  const snap = await fb.fs.getDocs(fb.ref);
  const batch = fb.fs.writeBatch(fb.db);
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
});


// ====== TOMBOL & KAMERA ======
function updateButtons() {
  camBtn.classList.toggle("on", running);
  camBtn.querySelector("i").className = running ? "fa-solid fa-video" : "fa-solid fa-video-slash";
  switchBtn.disabled = !running;
  flashBtn.disabled = !running;
  flashBtn.classList.toggle("on", flashOn);
  detectBtn.disabled = !running || !model;
  detectBtn.classList.toggle("on", detecting);
}

async function openStream() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing } }, audio: false
  });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

async function startCamera() {
  try {
    await openStream();
  } catch (err) {
    log("Kamera gagal: " + err.message + " (buka lewat localhost/HTTPS & izinkan kamera)");
    return;
  }
  statusEl.classList.add("hidden");
  running = true;
  updateButtons();
}

function stopCamera() {
  running = false;
  detecting = false;
  flashOn = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  statusEl.classList.remove("hidden");
  log("Kamera dimatikan.");
  liveEl.textContent = "Belum ada deteksi";
  updateButtons();
}

async function switchCamera() {
  if (!running) return;
  facing = facing === "environment" ? "user" : "environment";
  flashOn = false;
  stream?.getTracks().forEach(t => t.stop());
  try {
    await openStream();
  } catch (err) {
    liveEl.textContent = "Gagal ganti kamera: " + err.message;
  }
  updateButtons();
}

async function toggleFlash() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !flashOn }] });
    flashOn = !flashOn;
    if (flashOn && track.getSettings().torch === false) throw new Error("torch off");
  } catch (err) {
    flashOn = false;
    liveEl.textContent = "Flash tidak didukung di perangkat/browser ini.";
  }
  updateButtons();
}

function toggleDetect() {
  detecting = !detecting;
  if (detecting) {
    detectLoop();
  } else {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    liveEl.textContent = "Belum ada deteksi";
  }
  updateButtons();
}

camBtn.addEventListener("click", () => (running ? stopCamera() : startCamera()));
switchBtn.addEventListener("click", switchCamera);
flashBtn.addEventListener("click", toggleFlash);
detectBtn.addEventListener("click", toggleDetect);
updateButtons();


// ====== DETEKSI ======
async function detectLoop() {
  if (loopActive) return;
  loopActive = true;
  while (running && detecting) {
    await detectOnce();
    await new Promise(requestAnimationFrame);
  }
  loopActive = false;
}

async function detectOnce() {
  if (video.readyState < 2) return;
  const predictions = (await model.detect(video)).filter(p => p.score >= MIN_SCORE);
  if (!detecting) return;
  draw(predictions);
  predictions.forEach(saveDetection);
  liveEl.textContent = predictions.length
    ? predictions.map(p => p.class).join(", ")
    : "Belum ada deteksi";
}

function draw(predictions) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.lineWidth = 3;
  ctx.font = "16px sans-serif";
  predictions.forEach(p => {
    const [x, y, w, h] = p.bbox;
    const text = `${p.class} ${Math.round(p.score * 100)}%`;
    ctx.strokeStyle = "#e8a3b8";
    ctx.strokeRect(x, y, w, h);
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = "#e8a3b8";
    ctx.fillRect(x, Math.max(y - 24, 0), tw, 24);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + 5, Math.max(y - 7, 17));
  });
}


loadModel();
initFirebase();