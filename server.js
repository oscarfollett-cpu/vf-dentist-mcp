import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------ */
/* PUBLIC ROUTES — NO AUTH (VOICEFLOW REQUIRES THIS) */
/* ------------------------------------------------ */

app.get("/", (req, res) => {
  res.status(200).json({ ok: true });
});

// REQUIRED Voiceflow handshake
app.post("/", (req, res) => {
  res.status(200).json({ ok: true });
});

// MCP discovery
app.get("/.well-known/mcp.json", (req, res) => {
  res.json({
    version: "1.0",
    name: "Dentist Calendar MCP",
    description: "MCP server for dentist appointment booking",
    transports: {
      sse: {
        url: "/sse"
      }
    }
  });
});

/* ------------------------------------------------ */
/* MCP SERVER                                       */
/* ------------------------------------------------ */

const mcp = new McpServer({
  name: "Dentist Calendar MCP",
  version: "1.0.0"
});

// Example tool
mcp.tool(
  "check_availability",
  "Check if a time slot is available",
  {
    start: z.string(),
    end: z.string()
  },
  async ({ start, end }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            available: true,
            start,
            end
          })
        }
      ]
    };
  }
);

/* ------------------------------------------------ */
/* SSE TRANSPORT — MUST BE PUBLIC                    */
/* ------------------------------------------------ */

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/sse", res);

  res.on("close", () => {
    transport.close();
  });

  await mcp.connect(transport);
});

/* ------------------------------------------------ */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${PORT}`);
});
