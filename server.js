import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-api-key"],
}));
app.use(bodyParser.json());

// -------------------------------------
// REQUIRE API KEY FOR MCP TOOLS (BUT NOT MANIFEST)
// -------------------------------------
const REQUIRED_KEY = process.env.MCP_API_KEY;

app.use((req, res, next) => {
  const openPaths = [
    "/mcp.json",
    "/.well-known/mcp.json",
    "/status",
    "/",
    "/__vf_mcp_check"
  ];

  // Allow public paths
  if (openPaths.includes(req.path)) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  const tokenHeader = req.headers["x-auth-token"];

  // Allow VF handshake (empty body)
  if ((!authHeader && !tokenHeader) && (!req.body || Object.keys(req.body).length === 0)) {
    return next();
  }

  if (!REQUIRED_KEY) {
    console.error("Missing MCP_API_KEY in environment!");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Check supported header types
  const valid =
    authHeader === `Bearer ${REQUIRED_KEY}` ||
    tokenHeader === REQUIRED_KEY;

  if (!valid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// -------------------------------------
// SERVE MCP MANIFEST FOR VOICEFLOW
// -------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from "fs";

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "mcp.json"), "utf8")
);

app.get("/mcp.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json(manifest);
});

app.get("/.well-known/mcp.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json(manifest);
});

// MCP health check
app.get("/status", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ------------------------------
// GOOGLE AUTH SETUP
// ------------------------------
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: process.env.GC_PROJECT_ID,
    private_key: process.env.GC_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GC_CLIENT_EMAIL
  },
  scopes: ["https://www.googleapis.com/auth/calendar"]
});

const calendar = google.calendar({ version: "v3", auth });

// ------------------------------
// HELPERS
// ------------------------------
function isWeekend(dateString) {
  const d = new Date(dateString);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

async function hasConflict(start, end) {
  const res = await calendar.events.list({
    calendarId: process.env.GC_CALENDAR_ID,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime"
  });

  return res.data.items.length > 0;
}

// ------------------------------
// API ROUTES
// ------------------------------

app.post("/check", async (req, res) => {
  const { start, end } = req.body;

  if (isWeekend(start)) {
    return res.json({ available: false, reason: "weekend_not_allowed" });
  }

  const conflict = await hasConflict(start, end);

  if (conflict) {
    return res.json({ available: false, reason: "double_booking" });
  }

  const token = uuidv4();

  return res.json({
    available: true,
    token
  });
});

app.post("/create", async (req, res) => {
  const { token, title, start, end, patient } = req.body;

  if (!token) {
    return res.status(400).json({ error: "No reservation token provided" });
  }

  const event = {
    summary: title,
    description: `Patient: ${patient?.name}\nEmail: ${patient?.email}\nPhone: ${patient?.phone}`,
    start: { dateTime: start, timeZone: "Pacific/Auckland" },
    end: { dateTime: end, timeZone: "Pacific/Auckland" }
  };

  try {
    const created = await calendar.events.insert({
      calendarId: process.env.GC_CALENDAR_ID,
      resource: event
    });

    res.json({
      success: true,
      eventId: created.data.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/update", async (req, res) => {
  const { eventId, start, end } = req.body;

  try {
    const updated = await calendar.events.patch({
      calendarId: process.env.GC_CALENDAR_ID,
      eventId,
      resource: {
        start: { dateTime: start, timeZone: "Pacific/Auckland" },
        end: { dateTime: end, timeZone: "Pacific/Auckland" }
      }
    });

    res.json({
      success: true,
      event: updated.data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/delete", async (req, res) => {
  const { eventId } = req.body;

  try {
    await calendar.events.delete({
      calendarId: process.env.GC_CALENDAR_ID,
      eventId
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
app.get("/", (_, res) => res.send("Dentist MCP Calendar Backend Running"));
// ------------------------------

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MCP backend running on ${port}`));