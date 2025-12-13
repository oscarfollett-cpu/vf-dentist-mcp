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
const API_KEY = process.env.MCP_API_KEY;

// --------------------
// PUBLIC ROUTES (NO AUTH)
// --------------------
app.get("/", (_, res) => res.json({ ok: true }));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// Serve MCP discovery
app.get("/.well-known/mcp.json", (_, res) => {
  res.json({
    version: "1.0",
    name: "Dentist Calendar MCP",
    transports: {
      sse: { url: "/sse" }
    }
  });
});

// --------------------
// AUTH (ONLY FOR MCP)
// --------------------
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --------------------
// MCP SERVER
// --------------------
const mcp = new McpServer({
  name: "Dentist Calendar MCP",
  version: "1.0.0"
});

// Example tool (Voiceflow requires at least one)
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

// --------------------
// SSE ENDPOINT (REQUIRED)
// --------------------
app.get("/sse", requireApiKey, async (req, res) => {
  const transport = new SSEServerTransport("/sse", res);
  await mcp.connect(transport);
});

// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${PORT}`);
});
