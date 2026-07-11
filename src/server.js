import express from "express";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const log = pino({ level: "info" });
const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || "https://nawaqis-backend.onrender.com";
const WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "nawaqis_dev";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";

const sessions = new Map();

// Ensure sessions dir exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

async function startSession(storeId) {
  if (sessions.has(storeId)) {
    const existing = sessions.get(storeId);
    if (existing.connected) return { status: "connected", qr: null };
    if (existing.qr) return { status: "qr_ready", qr: existing.qr };
  }

  const sessionPath = path.join(SESSIONS_DIR, storeId);

  // Clear old session if exists (force fresh QR)
  if (fs.existsSync(sessionPath)) {
    log.info(`Clearing old session for ${storeId}`);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  // لا نستخدم fetchLatestBaileysVersion — نستخدم إصدار ثابت معروف
  const version = [2, 3000, 1015900966];
  log.info(`Baileys ${version.join('.')} starting for ${storeId}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    printQRInTerminal: false,
    logger: pino({ level: "debug" }),
    browser: ["Nawaqis", "Chrome", "1.0.0"],
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 120000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  const sessionData = { sock, qr: null, connected: false, reconnectTimeout: null };
  sessions.set(storeId, sessionData);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    // سجل كل تفاصيل التحديث للتشخيص
    log.info({ storeId, connection, hasQR: !!qr, update: JSON.stringify(update).slice(0, 500) }, "connection.update");

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
      sessionData.qr = qrDataUrl;
      log.info(`✅ QR generated for ${storeId}`);
    }

    if (connection === "open") {
      sessionData.connected = true;
      sessionData.qr = null;
      log.info(`✅ WhatsApp connected: ${storeId}`);
    }

    if (connection === "connecting") {
      log.info(`🔄 Connecting to WhatsApp for ${storeId}...`);
    }

    if (connection === "close") {
      sessionData.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "unknown";
      log.error({ storeId, code, errorMsg, error: JSON.stringify(lastDisconnect?.error || {}).slice(0, 300) }, "❌ Connection closed");
      if (code !== DisconnectReason.loggedOut) {
        sessionData.reconnectTimeout = setTimeout(() => startSession(storeId), 5000);
      } else {
        sessions.delete(storeId);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.key.fromMe && m.type === "notify") {
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        if (text) {
          await fetch(`${BACKEND_URL}/api/v1/webhooks/baileys/inbound`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Baileys-Secret": WEBHOOK_SECRET },
            body: JSON.stringify({
              store_id: storeId,
              from: from?.replace("@s.whatsapp.net", ""),
              message: text,
              type: "text",
              message_id: msg.key.id,
              timestamp: msg.messageTimestamp,
            }),
          });
        }
      }
    } catch (e) { log.error(e); }
  });

  // Wait 90s for QR (extended for Render free tier)
  await new Promise((resolve) => {
    let done = false;
    const i = setInterval(() => {
      if (done) return;
      if (sessionData.qr || sessionData.connected) {
        done = true;
        clearInterval(i);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      if (!done) { done = true; clearInterval(i); resolve(); }
    }, 90000);
  });

  if (sessionData.qr) return { status: "qr_ready", qr: sessionData.qr };
  if (sessionData.connected) return { status: "connected", qr: null };
  return { status: "timeout", qr: null, error: "WhatsApp did not send QR in 90s. Check Render logs." };
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    connected: Array.from(sessions.entries()).filter(([_, v]) => v.connected).map(([k]) => k),
  });
});

app.post("/session/:storeId/start", async (req, res) => {
  try {
    res.json(await startSession(req.params.storeId));
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/:storeId/qr", (req, res) => {
  const s = sessions.get(req.params.storeId);
  if (!s) return res.status(404).json({ error: "Not found" });
  if (s.connected) return res.json({ status: "connected", qr: null });
  if (s.qr) return res.json({ status: "qr_ready", qr: s.qr });
  res.json({ status: "waiting", qr: null });
});

app.get("/session/:storeId/status", (req, res) => {
  const s = sessions.get(req.params.storeId);
  if (!s) return res.json({ connected: false, status: "not_started" });
  res.json({ connected: s.connected, status: s.connected ? "connected" : s.qr ? "qr_ready" : "connecting" });
});

app.post("/session/:storeId/send", async (req, res) => {
  const { to, message } = req.body;
  const s = sessions.get(req.params.storeId);
  if (!s?.connected) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const r = await s.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message_id: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/session/:storeId/send-media", async (req, res) => {
  const { to, mediaUrl, caption, type } = req.body;
  const s = sessions.get(req.params.storeId);
  if (!s?.connected) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const msg = type === "image" ? { image: { url: mediaUrl }, caption } : { document: { url: mediaUrl }, caption };
    const r = await s.sock.sendMessage(jid, msg);
    res.json({ success: true, message_id: r?.key?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/session/:storeId", async (req, res) => {
  const s = sessions.get(req.params.storeId);
  if (!s) return res.json({ success: true });
  if (s.reconnectTimeout) clearTimeout(s.reconnectTimeout);
  try { if (s.sock) await s.sock.logout(); } catch {}
  sessions.delete(req.params.storeId);
  // Also delete session files
  const p = path.join(SESSIONS_DIR, req.params.storeId);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  res.json({ success: true });
});

app.listen(PORT, () => log.info(`Baileys on :${PORT}`));
