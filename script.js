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
const liveEl    = document.getElementById("live");
const dbStatus  = document.getElementById("db-status");
const toggleBtn = document.getElementById("toggle");
const clearBtn  = document.getElementById("clear");
const listEl    = document.getElementById("list");

let model = null;
let stream = null;
let running = false;
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
    log("3/3 Model siap. Tekan “Mulai kamera”.");
    toggleBtn.disabled = false;
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
      dbStatus.textContent = "Firebase: " + (err.code || "gagal");
      dbStatus.className = "badge offline";
    });
  } catch (err) {
    console.error(err);
    dbStatus.textContent = "Firebase: gagal dimuat";
    dbStatus.className = "badge offline";
  }
}

function renderHistory(snap) {
  dbStatus.textContent = "Firebase: terhubung";
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
      <span class="score">${Math.round(d.score * 100)}%</span>`;
    listEl.appendChild(li);
  });
}

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

clearBtn.addEventListener("click", async () => {
  if (!fb || !confirm("Hapus semua riwayat deteksi?")) return;
  const snap = await fb.fs.getDocs(fb.ref);
  const batch = fb.fs.writeBatch(fb.db);
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
});


async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false
    });
  } catch (err) {
    log("Kamera gagal: " + err.message + " (buka lewat localhost & izinkan kamera)");
    return;
  }
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  statusEl.classList.add("hidden");
  running = true;
  toggleBtn.textContent = "Hentikan kamera";
  detectLoop();
}

function stopCamera() {
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  statusEl.classList.remove("hidden");
  log("Kamera dihentikan.");
  toggleBtn.textContent = "Mulai kamera";
  liveEl.textContent = "Belum ada deteksi";
}

toggleBtn.addEventListener("click", () => (running ? stopCamera() : startCamera()));


async function detectLoop() {
  if (!running) return;
  const predictions = (await model.detect(video)).filter(p => p.score >= MIN_SCORE);
  draw(predictions);
  predictions.forEach(saveDetection);
  liveEl.textContent = predictions.length
    ? predictions.map(p => p.class).join(", ")
    : "Belum ada deteksi";
  requestAnimationFrame(detectLoop);
}

function draw(predictions) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.lineWidth = 3;
  ctx.font = "16px sans-serif";
  predictions.forEach(p => {
    const [x, y, w, h] = p.bbox;
    const text = `${p.class} ${Math.round(p.score * 100)}%`;
    ctx.strokeStyle = "#3dd6c6";
    ctx.strokeRect(x, y, w, h);
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = "#3dd6c6";
    ctx.fillRect(x, Math.max(y - 24, 0), tw, 24);
    ctx.fillStyle = "#06201d";
    ctx.fillText(text, x + 5, Math.max(y - 7, 17));
  });
}


loadModel();
initFirebase();