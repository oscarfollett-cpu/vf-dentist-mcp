import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(bodyParser.json());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// -----------------------------------
// CONSTANTS
// -----------------------------------
const REQUIRED_KEY = process.env.MCP_API_KEY;

// -----------------------------------
// PATH HELPERS
// -----------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load manifest
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "mcp.json"), "utf8")
);

// -----------------------------------
// AUTH MIDDLEWARE (Voiceflow compatible)
// -----------------------------------
app.use((req, res, next) => {
  const openPaths = [
    "/",
    "/status",
    "/mcp.json",
    "/.well-known/mcp.json",
    "/__vf_mcp_check" // Voiceflow handshake
  ];

  // Allow Voiceflow validation + public endpoints
  if (openPaths.includes(req.path)) {
    return next();
  }

  const key = req.headers["x-api-key"];

  // Allow EMPTY BODY requests (VF handshake)
  if (!key) {
    if (req.method === "OPTIONS") return res.sendStatus(200);
    if (!req.body || Object.keys(req.body).length === 0) {
      return next();
    }
  }

  // Require correct API key
  if (key !== REQUIRED_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// -----------------------------------
// MANIFEST ROUTES
// -----------------------------------
app.get("/mcp.json", (req, res) => {
  res.status(200).json(manifest);
});

app.get("/.well-known/mcp.json", (req, res) => {
  res.status(200).json(manifest);
});

// -----------------------------------
// HEALTH CHECK
// -----------------------------------
app.get("/status", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// -----------------------------------
// GOOGLE AUTH SETUP
// -----------------------------------
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: process.env.GC_PROJECT_ID,
    private_key: process.env.GC_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GC_CLIENT_EMAIL,
  },
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

// -----------------------------------
// HELPERS
// -----------------------------------
function isWeekend(dateString) {
  const d = new Date(dateString);
  return d.getUTCDay() === 0 || d.getUTCDay() === 6;
}

async function hasConflict(start, end) {
  try {
    const res = await calendar.events.list({
      calendarId: process.env.GC_CALENDAR_ID,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: "startTime",
    });

    return res.data.items.length > 0;
  } catch (err) {
    console.error("Google Calendar error:", err.response?.data || err);
    throw new Error("google_calendar_error");
  }
}

// -----------------------------------
// ROUTES
// -----------------------------------

// Check availability
app.post("/check", async (req, res) => {
  const { start, end } = req.body;

  if (isWeekend(start)) {
    return res.json({ available: false, reason: "weekend_not_allowed" });
  }

  try {
    const conflict = await hasConflict(start, end);

    if (conflict) {
      return res.json({ available: false, reason: "double_booking" });
    }

    const token = uuidv4();
    return res.json({ available: true, token });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Create appointment
app.post("/create", async (req, res) => {
  const { token, title, start, end, patient } = req.body;

  if (!token) return res.status(400).json({ error: "No reservation token" });

  const event = {
    summary: title,
    description: `Name: ${patient?.name}\nEmail: ${patient?.email}\nPhone: ${patient?.phone}`,
    start: { dateTime: start, timeZone: "Pacific/Auckland" },
    end: { dateTime: end, timeZone: "Pacific/Auckland" },
  };

  try {
    const created = await calendar.events.insert({
      calendarId: process.env.GC_CALENDAR_ID,
      resource: event,
    });

    res.json({
      success: true,
      eventId: created.data.id,
    });
  } catch (err) {
    console.error("Create error:", err.response?.data || err);
    res.status(500).json({ error: err.message });
  }
});

// Update appointment
app.post("/update", async (req, res) => {
  const { eventId, start, end } = req.body;

  try {
    const updated = await calendar.events.patch({
      calendarId: process.env.GC_CALENDAR_ID,
      eventId,
      resource: {
        start: { dateTime: start, timeZone: "Pacific/Auckland" },
        end: { dateTime: end, timeZone: "Pacific/Auckland" },
      },
    });

    res.json({ success: true, event: updated.data });
  } catch (err) {
    console.error("Update error:", err.response?.data || err);
    res.status(500).json({ error: err.message });
  }
});

// Delete appointment
app.post("/delete", async (req, res) => {
  const { eventId } = req.body;

  try {
    await calendar.events.delete({
      calendarId: process.env.GC_CALENDAR_ID,
      eventId,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err.response?.data || err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------
app.get("/", (_, res) =>
  res.send("Dentist MCP Calendar Backend Running")
);

// -----------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MCP backend running on ${port}`));