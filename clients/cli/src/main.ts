#!/usr/bin/env node

import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  environment: {
    ...(process.env.ALMIRA_BASE_URL === undefined
      ? {}
      : { ALMIRA_BASE_URL: process.env.ALMIRA_BASE_URL }),
    ...(process.env.METAMORPH_TOKEN === undefined
      ? {}
      : { METAMORPH_TOKEN: process.env.METAMORPH_TOKEN }),
    ...(process.env.ALMIRA_CONTEXT === undefined
      ? {}
      : { ALMIRA_CONTEXT: process.env.ALMIRA_CONTEXT }),
    ...(process.env.ALMIRA_CONTEXT_FILE === undefined
      ? {}
      : { ALMIRA_CONTEXT_FILE: process.env.ALMIRA_CONTEXT_FILE }),
  },
  io: { stdin: process.stdin, stderr: process.stderr, stdout: process.stdout },
});
