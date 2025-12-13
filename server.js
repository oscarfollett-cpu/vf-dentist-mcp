import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ------------------------------------------------ */
/* Google Calendar Helpers                          */
/* ------------------------------------------------ */

function getCalendar() {
  const auth = new google.auth.JWT(
    process.env.GC_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GC_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar"]
  );

  return {
    calendar: google.calendar({ version: "v3", auth }),
    calendarId: process.env.GC_CALENDAR_ID,
  };
}

async function hasConflict(start, end) {
  const { calendar, calendarId } = getCalendar();

  const res = await calendar.events.list({
    calendarId,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items || []).length > 0;
}

/* ------------------------------------------------ */
/* Routes Voiceflow Calls                           */
/* ------------------------------------------------ */

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.get("/mcp.json", (req, res) => {
  res.sendFile(new URL("./mcp.json", import.meta.url).pathname);
});

/* CHECK AVAILABILITY */
app.post("/check", async (req, res) => {
  const { start, end } = req.body;

  if (!start || !end) {
    return res.status(400).json({ error: "Missing start or end" });
  }

  const available = !(await hasConflict(start, end));

  res.json({
    available,
    token: available ? uuidv4() : null,
  });
});

/* CREATE APPOINTMENT */
app.post("/create", async (req, res) => {
  const { token, title, start, end, patient } = req.body;

  if (!token || !start || !end || !patient?.name || !patient?.phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (await hasConflict(start, end)) {
    return res.status(409).json({ error: "Time slot unavailable" });
  }

  const { calendar, calendarId } = getCalendar();

  const event = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title || "Dentist Appointment",
      description: `Patient: ${patient.name}\nPhone: ${patient.phone}\nEmail: ${patient.email || "N/A"}`,
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });

  res.json({
    success: true,
    eventId: event.data.id,
  });
});

/* UPDATE APPOINTMENT */
app.post("/update", async (req, res) => {
  const { eventId, start, end } = req.body;

  if (!eventId || !start || !end) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const { calendar, calendarId } = getCalendar();

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });

  res.json({ success: true });
});

/* DELETE APPOINTMENT */
app.post("/delete", async (req, res) => {
  const { eventId } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: "Missing eventId" });
  }

  const { calendar, calendarId } = getCalendar();

  await calendar.events.delete({
    calendarId,
    eventId,
  });

  res.json({ success: true });
});

/* ------------------------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`REST MCP server listening on port ${PORT}`);
});
