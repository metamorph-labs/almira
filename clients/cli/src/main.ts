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
  },
  io: { stderr: process.stderr, stdout: process.stdout },
});
