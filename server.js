// server.js
// MCP + Google Calendar server for Voiceflow

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";

// MCP SDK imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";

dotenv.config();

/**
 * 1) GOOGLE CALENDAR CLIENT
 */

function getCalendar() {
  const clientEmail = process.env.GC_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GC_PRIVATE_KEY;
  const calendarId = process.env.GC_CALENDAR_ID;

  if (!clientEmail || !privateKey || !calendarId) {
    throw new Error(
      "Missing GC_SERVICE_ACCOUNT_EMAIL, GC_PRIVATE_KEY, or GC_CALENDAR_ID env var"
    );
  }

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth: jwt });
  return { calendar, calendarId };
}

async function hasConflict(start, end) {
  const { calendar, calendarId } = getCalendar();

  const response = await calendar.events.list({
    calendarId,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items || []).length > 0;
}

async function createEvent({ title, description, start, end, patient }) {
  const { calendar, calendarId } = getCalendar();

  const event = {
    summary: title || "Dentist Appointment",
    description:
      description ||
      `Patient: ${patient?.name || "Unknown"}\nPhone: ${
        patient?.phone || "N/A"
      }\nEmail: ${patient?.email || "N/A"}`,
    start: { dateTime: start },
    end: { dateTime: end },
  };

  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  return response.data;
}

async function updateEvent({ eventId, start, end }) {
  const { calendar, calendarId } = getCalendar();

  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });

  return response.data;
}

async function deleteEvent({ eventId }) {
  const { calendar, calendarId } = getCalendar();
  await calendar.events.delete({ calendarId, eventId });
}

/**
 * 2) BUILD MCP SERVER (TOOLS)
 */

function buildMcpServer() {
  const server = new McpServer(
    { name: "dentist-calendar", version: "1.0.0" },
    {
      capabilities: {
        logging: {}, // allows logging back to client
      },
    }
  );

  // Tool: check_availability
  server.tool(
    "check_availability",
    "Check if a time slot is free and get a booking token.",
    {
      start: z.string().describe("ISO 8601 start time, e.g. 2025-01-01T10:00:00+13:00"),
      end: z.string().describe("ISO 8601 end time, e.g. 2025-01-01T10:30:00+13:00"),
    },
    async ({ start, end }) => {
      const busy = await hasConflict(start, end);
      const available = !busy;
      const token = available ? uuidv4() : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ available, token }),
          },
        ],
      };
    }
  );

  // Tool: create_appointment
  server.tool(
    "create_appointment",
    "Create a dentist appointment after checking availability.",
    {
      token: z.string().describe("Booking token from check_availability"),
      title: z.string().default("Dentist Appointment"),
      start: z.string().describe("ISO 8601 start time"),
      end: z.string().describe("ISO 8601 end time"),
      patient: z
        .object({
          name: z.string().describe("Patient name"),
          email: z.string().optional().describe("Patient email"),
          phone: z.string().describe("Patient phone"),
        })
        .describe("Patient details"),
      description: z
        .string()
        .optional()
        .describe("Optional description / reason for visit"),
    },
    async ({ token, title, start, end, patient, description }) => {
      // Simple check: ensure token is non-empty (you can add your own tracking if you like)
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Missing booking token",
              }),
            },
          ],
        };
      }

      const busy = await hasConflict(start, end);
      if (busy) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Time slot is no longer available",
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

  // Tool: update_appointment
  server.tool(
    "update_appointment",
    "Reschedule an existing appointment using its eventId.",
    {
      eventId: z.string().describe("Google Calendar event ID"),
      start: z.string().describe("New ISO 8601 start time"),
      end: z.string().describe("New ISO 8601 end time"),
    },
    async ({ eventId, start, end }) => {
      const busy = await hasConflict(start, end);
      if (busy) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "New time slot is not available",
              }),
            },
          ],
        };
      }

      const event = await updateEvent({ eventId, start, end });

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

  // Tool: delete_appointment
  server.tool(
    "delete_appointment",
    "Cancel an appointment using its eventId.",
    {
      eventId: z.string().describe("Google Calendar event ID"),
    },
    async ({ eventId }) => {
      await deleteEvent({ eventId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              eventId,
            }),
          },
        ],
      };
    }
  );

  return server;
}

/**
 * 3) EXPRESS + MCP HTTP TRANSPORT
 *    This is the part Voiceflow actually talks to.
 */

const app = createMcpExpressApp();

// MCP endpoint (Streamable HTTP)
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Optional: allow GET/DELETE /mcp to fail cleanly
app.get("/mcp", (req, res) => {
  res
    .status(405)
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.delete("/mcp", (req, res) => {
  res
    .status(405)
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

// Simple health check for you / curl
app.get("/", (req, res) => {
  res.json({ ok: true, mcp: true });
});

// Normal CORS & JSON parsing
app.use(cors());
app.use(bodyParser.json());

// START SERVER
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP Calendar server listening on port ${port}`);
});
