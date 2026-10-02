#!/usr/bin/env node
import { createChannelMcp } from './_shared/create-channel-mcp.mjs';

const mcp = createChannelMcp({
  slug: "workablejobs",
  boardId: "workablejobs-official",
  domain: "jobs.workable.com",
  npmName: "zc-workablejobs-scout-mcp",
});

mcp.start().catch((e) => {
  console.error(e);
  process.exit(1);
});
