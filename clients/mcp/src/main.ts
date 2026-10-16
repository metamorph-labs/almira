#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AlmiraClient } from "@metamorph-labs/almira-sdk";

import { createAlmiraMcpServer } from "./server.js";

const baseUrl = process.env.ALMIRA_BASE_URL;
const credential = process.env.METAMORPH_TOKEN;

if (baseUrl === undefined || baseUrl.length === 0) {
  console.error(JSON.stringify({ code: "ALMIRA_MCP_BASE_URL_REQUIRED" }));
  process.exitCode = 2;
} else if (credential === undefined || credential.length === 0) {
  console.error(JSON.stringify({ code: "ALMIRA_MCP_TOKEN_REQUIRED" }));
  process.exitCode = 2;
} else {
  try {
    const client = new AlmiraClient({ baseUrl, credential });
    await serveStdio(() => createAlmiraMcpServer(client));
  } catch {
    console.error(JSON.stringify({ code: "ALMIRA_MCP_RUNTIME_FAILED" }));
    process.exitCode = 1;
  }
}
