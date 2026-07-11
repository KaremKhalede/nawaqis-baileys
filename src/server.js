/**
 * Nawaqis Baileys Microservice — WhatsApp QR Connection
 */

import express from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "baileys";
import QRCode from "qrcode";

const log = pino({ level: "info" });
const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || "https://nawaqis-backend.onrender.com";
const WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "nawaqis_baileys_dev_secret";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";

const sessions = new Map();

async function startSession(storeId) {
  // إذا الجلسة موجودة ومتصلة، نرجع فوراً
  if (sessions.has(storeId)) {
    const existing = sessions.get(storeId);
    if (existing.connected) {
      return { status: "connected", qr: null };
    }
    if (existing.qr) {
      return { status: "qr_ready", qr: existing.qr };
    }
    // الجلسة موجودة بس ما تولد QR بعد — ننتظر
  }

  log.info(`Starting session for store: ${storeId}`);

  const { version } = await fetchLatestBaileysVersion();
  log.info(`Baileys version: ${version}`);

  const { state, saveCreds } = await useMultiFileAuthState(`${SESSIONS_DIR}/${storeId}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "warn" }),
    browser: ["Nawaqis", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    markOnlineOnConnect: false,
  });

  const sessionData = {
    sock,
    qr: null,
    connected: false,
    reconnectTimeout: null,
  };

  sessions.set(storeId, sessionData);

  // QR handler
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log.info(`QR received for store: ${storeId}`);
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
      sessionData.qr = qrDataUrl;
    }

    if (connection === "open") {
      sessionData.connected = true;
      sessionData.qr = null;
      log.info(`WhatsApp connected for store: ${storeId}`);
    }

    if (connection === "close") {
      sessionData.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      log.info(`Connection closed: ${code}`);

      if (code !== DisconnectReason.loggedOut) {
        log.info(`Reconnecting store: ${storeId}`);
        sessionData.reconnectTimeout = setTimeout(() => {
          startSession(storeId);
        }, 5000);
      } else {
        log.info(`Logged out: ${storeId}`);
        sessions.delete(storeId);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.key.fromMe && m.type === "notify") {
        const from = msg.key.remoteJid;
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";

        if (messageText || msg.message?.imageMessage || msg.message?.videoMessage) {
          await fetch(`${BACKEND_URL}/api/v1/webhooks/baileys/inbound`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Baileys-Secret": WEBHOOK_SECRET,
            },
            body: JSON.stringify({
              store_id: storeId,
              from: from?.replace("@s.whatsapp.net", ""),
              message: messageText,
              type: msg.message?.imageMessage ? "image" : msg.message?.videoMessage ? "video" : "text",
              message_id: msg.key.id,
              timestamp: msg.messageTimestamp,
            }),
          });
          log.info(`Inbound from ${from} for ${storeId}`);
        }
      }
    } catch (err) {
      log.error(`Inbound error: ${err}`);
    }
  });

  // Wait for QR — 60 ثانية
  await new Promise((resolve) => {
    let done = false;
    const checkQR = setInterval(() => {
      if (done) return;
      if (sessionData.qr || sessionData.connected) {
        done = true;
        clearInterval(checkQR);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      if (!done) {
        done = true;
        clearInterval(checkQR);
        log.warn(`QR timeout for ${storeId} after 60s`);
        resolve();
      }
    }, 60000);
  });

  if (sessionData.qr) {
    return { status: "qr_ready", qr: sessionData.qr };
  } else if (sessionData.connected) {
    return { status: "connected", qr: null };
  } else {
    return { status: "timeout", qr: null, error: "QR not generated in 60s — check if WhatsApp is blocking" };
  }
}

// Routes
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    connected: Array.from(sessions.entries()).filter(([_, v]) => v.connected).map(([k]) => k),
  });
});

app.post("/session/:storeId/start", async (req, res) => {
  try {
    const result = await startSession(req.params.storeId);
    res.json(result);
  } catch (err) {
    log.error(`Start failed: ${err}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/:storeId/qr", (req, res) => {
  const session = sessions.get(req.params.storeId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.connected) return res.json({ status: "connected", qr: null });
  if (session.qr) return res.json({ status: "qr_ready", qr: session.qr });
  res.json({ status: "waiting", qr: null });
});

app.get("/session/:storeId/status", (req, res) => {
  const session = sessions.get(req.params.storeId);
  if (!session) return res.json({ connected: false, status: "not_started" });
  res.json({
    connected: session.connected,
    status: session.connected ? "connected" : session.qr ? "qr_ready" : "connecting",
  });
});

app.post("/session/:storeId/send", async (req, res) => {
  const { to, message } = req.body;
  const session = sessions.get(req.params.storeId);
  if (!session?.connected) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/session/:storeId/send-media", async (req, res) => {
  const { to, mediaUrl, caption, type } = req.body;
  const session = sessions.get(req.params.storeId);
  if (!session?.connected) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
    const message = type === "image"
      ? { image: { url: mediaUrl }, caption: caption || "" }
      : { document: { url: mediaUrl }, caption: caption || "" };
    const result = await session.sock.sendMessage(jid, message);
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/session/:storeId", async (req, res) => {
  const session = sessions.get(req.params.storeId);
  if (!session) return res.json({ success: true });
  try {
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    if (session.sock) await session.sock.logout();
    sessions.delete(req.params.storeId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log.info(`Nawaqis Baileys running on port ${PORT}`);
});
