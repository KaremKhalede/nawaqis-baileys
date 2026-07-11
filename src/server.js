/**
 * Nawaqis Baileys Microservice — WhatsApp QR Connection
 * =====================================================
 * 
 * Node.js microservice that manages WhatsApp Web sessions via Baileys.
 * Each merchant gets one session (identified by store_id).
 * 
 * REST API:
 *   GET  /health                 — health check
 *   POST /session/:storeId/start — start session, returns QR code
 *   GET  /session/:storeId/qr    — get current QR code
 *   GET  /session/:storeId/status — connection status
 *   POST /session/:storeId/send  — send text message
 *   POST /session/:storeId/send-media — send media (image/document)
 *   DELETE /session/:storeId     — logout + destroy session
 * 
 * Webhook (outbound to Python backend):
 *   POST <BACKEND_URL>/api/v1/webhooks/baileys/inbound
 *   Header: X-Baileys-Secret: <secret>
 *   Body: { store_id, from, message, type }
 */

import express from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";

const log = pino({ level: "info" });
const app = express();
app.use(express.json({ limit: "10mb" }));

// ─── Configuration ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || "https://nawaqis-backend.onrender.com";
const WEBHOOK_SECRET = process.env.BAILEYS_WEBHOOK_SECRET || "nawaqis_baileys_dev_secret";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";

// ─── Session Manager ─────────────────────────────────────────────
const sessions = new Map(); // store_id → { sock, qr, connected, reconnectTimeout }

async function startSession(storeId) {
  if (sessions.has(storeId)) {
    const existing = sessions.get(storeId);
    if (existing.connected) {
      return { status: "already_connected", qr: null };
    }
    // Return existing QR if available
    if (existing.qr) {
      return { status: "qr_ready", qr: existing.qr };
    }
  }

  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.info(`Baileys version: ${version} (latest: ${isLatest})`);

  const { state, saveCreds } = await useMultiFileAuthState(`${SESSIONS_DIR}/${storeId}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Nawaqis", "Chrome", "1.0.0"],
    defaultQueryTimeoutMs: 60000,
  });

  const sessionData = {
    sock,
    qr: null,
    connected: false,
    reconnectTimeout: null,
  };

  sessions.set(storeId, sessionData);

  // ─── QR Code handler ──────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Convert QR to base64 data URL
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
      sessionData.qr = qrDataUrl;
      log.info(`QR generated for store: ${storeId}`);
    }

    if (connection === "open") {
      sessionData.connected = true;
      sessionData.qr = null;
      log.info(`✅ WhatsApp connected for store: ${storeId}`);
    }

    if (connection === "close") {
      sessionData.connected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        log.info(`🔄 Reconnecting store: ${storeId}`);
        // Auto-reconnect after 3 seconds
        sessionData.reconnectTimeout = setTimeout(() => {
          startSession(storeId);
        }, 3000);
      } else {
        log.info(`🔒 Logged out, destroying session: ${storeId}`);
        sessions.delete(storeId);
      }
    }
  });

  // ─── Credentials update ───────────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ─── Incoming messages ────────────────────────────────────────
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
          // Send webhook to Python backend
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
              type: msg.message?.imageMessage
                ? "image"
                : msg.message?.videoMessage
                ? "video"
                : "text",
              message_id: msg.key.id,
              timestamp: msg.messageTimestamp,
            }),
          });
          log.info(`📩 Inbound message from ${from} for store ${storeId}`);
        }
      }
    } catch (err) {
      log.error(`Error processing inbound message: ${err}`);
    }
  });

  // Wait for QR — Baileys may take up to 30s on first connection
  await new Promise((resolve) => {
    const checkQR = setInterval(() => {
      if (sessionData.qr || sessionData.connected) {
        clearInterval(checkQR);
        resolve();
      }
    }, 500);
    // Timeout after 30 seconds (increased from 15)
    setTimeout(() => {
      clearInterval(checkQR);
      resolve();
    }, 30000);
  });

  if (sessionData.qr) {
    return { status: "qr_ready", qr: sessionData.qr };
  } else if (sessionData.connected) {
    return { status: "connected", qr: null };
  } else {
    return { status: "timeout", qr: null };
  }
}

// ─── Routes ──────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    connected: Array.from(sessions.entries())
      .filter(([_, v]) => v.connected)
      .map(([k]) => k),
  });
});

app.post("/session/:storeId/start", async (req, res) => {
  const { storeId } = req.params;
  try {
    const result = await startSession(storeId);
    res.json(result);
  } catch (err) {
    log.error(`Failed to start session for ${storeId}: ${err}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/session/:storeId/qr", (req, res) => {
  const { storeId } = req.params;
  const session = sessions.get(storeId);
  if (!session) {
    return res.status(404).json({ error: "Session not found. Call /start first." });
  }
  if (session.connected) {
    return res.json({ status: "connected", qr: null });
  }
  if (session.qr) {
    return res.json({ status: "qr_ready", qr: session.qr });
  }
  res.json({ status: "waiting", qr: null });
});

app.get("/session/:storeId/status", (req, res) => {
  const { storeId } = req.params;
  const session = sessions.get(storeId);
  if (!session) {
    return res.json({ connected: false, status: "not_started" });
  }
  res.json({
    connected: session.connected,
    status: session.connected ? "connected" : session.qr ? "qr_ready" : "connecting",
  });
});

app.post("/session/:storeId/send", async (req, res) => {
  const { storeId } = req.params;
  const { to, message } = req.body;

  const session = sessions.get(storeId);
  if (!session || !session.connected) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const jid = to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) {
    log.error(`Send failed for ${storeId}: ${err}`);
    res.status(500).json({ error: err.message });
  }
});

app.post("/session/:storeId/send-media", async (req, res) => {
  const { storeId } = req.params;
  const { to, mediaUrl, caption, type } = req.body;

  const session = sessions.get(storeId);
  if (!session || !session.connected) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const jid = to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
    let message;
    if (type === "image") {
      message = { image: { url: mediaUrl }, caption: caption || "" };
    } else {
      message = { document: { url: mediaUrl }, caption: caption || "" };
    }
    const result = await session.sock.sendMessage(jid, message);
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) {
    log.error(`Send media failed for ${storeId}: ${err}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/session/:storeId", async (req, res) => {
  const { storeId } = req.params;
  const session = sessions.get(storeId);
  if (!session) {
    return res.json({ success: true, message: "Session not found" });
  }

  try {
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    if (session.sock) {
      await session.sock.logout();
    }
    sessions.delete(storeId);
    log.info(`🔒 Session destroyed for store: ${storeId}`);
    res.json({ success: true });
  } catch (err) {
    log.error(`Logout failed for ${storeId}: ${err}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
  log.info(`🚀 Nawaqis Baileys microservice running on port ${PORT}`);
  log.info(`   Backend URL: ${BACKEND_URL}`);
  log.info(`   Sessions dir: ${SESSIONS_DIR}`);
});
