// server.js
// Voiceflow-compatible MCP + Google Calendar server

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";
import * as z from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Google Calendar helpers                                             */
/* ------------------------------------------------------------------ */

function getCalendar() {
  const clientEmail = process.env.GC_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GC_PRIVATE_KEY;
  const calendarId = process.env.GC_CALENDAR_ID;

  if (!clientEmail || !privateKey || !calendarId) {
    throw new Error("Missing Google Calendar environment variables");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return {
    calendar: google.calendar({ version: "v3", auth }),
    calendarId,
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

async function createEvent({ title, description, start, end, patient }) {
  const { calendar, calendarId } = getCalendar();

  const event = {
    summary: title || "Dentist Appointment",
    description:
      description ||
      `Patient: ${patient.name}\nPhone: ${patient.phone}\nEmail: ${patient.email || "N/A"}`,
    start: { dateTime: start },
    end: { dateTime: end },
  };

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  return res.data;
}

/* ------------------------------------------------------------------ */
/* MCP SERVER (SINGLE INSTANCE — REQUIRED FOR VOICEFLOW)               */
/* ------------------------------------------------------------------ */

const mcpServer = new McpServer({
  name: "Dentist MCP",
  version: "1.0.0",
});

/* Tool: check_availability */
mcpServer.tool(
  "check_availability",
  "Check if a time slot is free",
  {
    start: z.string(),
    end: z.string(),
  },
  async ({ start, end }) => {
    const available = !(await hasConflict(start, end));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            available,
            token: available ? uuidv4() : null,
          }),
        },
      ],
    };
  }
);

/* Tool: create_appointment */
mcpServer.tool(
  "create_appointment",
  "Create a dentist appointment",
  {
    token: z.string(),
    title: z.string().optional(),
    start: z.string(),
    end: z.string(),
    patient: z.object({
      name: z.string(),
      phone: z.string(),
      email: z.string().optional(),
    }),
    description: z.string().optional(),
  },
  async ({ title, start, end, patient, description }) => {
    if (await hasConflict(start, end)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Time slot unavailable",
            }),
          },
        ],
      };
    }

    const event = await createEvent({
      title,
      start,
      end,
      patient,
      description,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            eventId: event.id,
          }),
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ */
/* EXPRESS APP                                                         */
/* ------------------------------------------------------------------ */

const app = createMcpExpressApp(mcpServer);

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP Calendar server listening on port ${port}`);
});
