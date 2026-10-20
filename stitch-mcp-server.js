// Servidor MCP local de Stitch (transporte stdio).
// El paquete @google/stitch-sdk no incluye un ejecutable para "npx", así que
// este pequeño script levanta su StitchProxy, que reenvía las herramientas
// del servidor remoto de Stitch (https://stitch.googleapis.com/mcp) por stdio.
import { StitchProxy } from "@google/stitch-sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const proxy = new StitchProxy({ apiKey: process.env.STITCH_API_KEY });
await proxy.start(new StdioServerTransport());
