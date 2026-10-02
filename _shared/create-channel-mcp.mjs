#!/usr/bin/env node
/**
 * 一渠一仓 MCP 工厂：固定 BOARD_ID，标准 search_jobs / get_job。
 *
 * Runner 优先级（Portable）：
 * 1. ZC_SCOUT_RUNNER（显式覆盖）
 * 2. _shared/standalone-runner.bundle.cjs（打包进仓，无需 monorepo）
 * 3. monorepo backend/scripts/zc-b4-board-scout-runner.ts（开发回退）
 *
 * Env:
 *   ZC_SCOUT_RUNNER   — 覆盖 runner 路径（.cjs 用 node；.ts 用 npx tsx）
 *   ZC_MONOREPO_ROOT  — 仅开发回退 ts runner 时需要
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDALONE_BUNDLE = resolve(__dirname, 'standalone-runner.bundle.cjs');

function resolveMonorepoRoot() {
  if (process.env.ZC_MONOREPO_ROOT) {
    return resolve(process.env.ZC_MONOREPO_ROOT);
  }
  return resolve(__dirname, '../../../../..');
}

function resolveRunner() {
  if (process.env.ZC_SCOUT_RUNNER) {
    return resolve(process.env.ZC_SCOUT_RUNNER);
  }
  if (existsSync(STANDALONE_BUNDLE)) {
    return STANDALONE_BUNDLE;
  }
  // 统一 B2+B4 runner（旧 b4-only 脚本仍可被 ZC_SCOUT_RUNNER 覆盖）
  return resolve(resolveMonorepoRoot(), 'backend/scripts/zc-board-scout-runner.ts');
}

function isNodeBundle(runnerPath) {
  return /\.(cjs|js)$/i.test(runnerPath) && !/\.ts$/i.test(runnerPath);
}

function loadMcpSdk() {
  const candidates = [
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../job-scout-mcp/package.json'),
    resolve(__dirname, 'package.json'),
  ];
  for (const pkg of candidates) {
    if (!existsSync(pkg)) continue;
    try {
      const require = createRequire(pkg);
      return {
        Server: require('@modelcontextprotocol/sdk/server/index.js').Server,
        StdioServerTransport: require('@modelcontextprotocol/sdk/server/stdio.js')
          .StdioServerTransport,
        CallToolRequestSchema: require('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema,
        ListToolsRequestSchema: require('@modelcontextprotocol/sdk/types.js').ListToolsRequestSchema,
      };
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Cannot load @modelcontextprotocol/sdk. Run `npm i` in zc-scout-channels/ (or job-scout-mcp).',
  );
}

export function createChannelMcp(meta) {
  const {
    Server,
    StdioServerTransport,
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = loadMcpSdk();

  const BOARD = meta.boardId;
  const RUNNER = meta.runner
    ? resolve(resolveMonorepoRoot(), meta.runner)
    : resolveRunner();

  let lastCallAt = 0;
  const MIN_GAP_MS = 800;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rateLimit() {
    const now = Date.now();
    const wait = MIN_GAP_MS - (now - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  }

  function runRunner(payload) {
    if (!existsSync(RUNNER)) {
      return Promise.reject(
        new Error(
          `Scout runner not found: ${RUNNER}. ` +
            'Rebuild with `npm run build:runner` in zc-scout-channels, or set ZC_SCOUT_RUNNER.',
        ),
      );
    }
    const useNode = isNodeBundle(RUNNER);
    const command = useNode ? 'node' : 'npx';
    const args = useNode
      ? [RUNNER, JSON.stringify({ ...payload, board: BOARD })]
      : ['tsx', RUNNER, JSON.stringify({ ...payload, board: BOARD })];
    const cwd = useNode ? dirname(RUNNER) : resolveMonorepoRoot();

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(err.slice(0, 400) || `runner exit ${code}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(out.trim() || '{}'));
        } catch {
          reject(new Error(`bad runner JSON: ${out.slice(0, 200)}`));
        }
      });
    });
  }

  const server = new Server(
    { name: meta.npmName || `zc-${meta.slug}-scout-mcp`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_jobs',
        description:
          `Search jobs on ${meta.domain} (standard channel scraper MCP). ` +
          'Supports query, location (soft match), remoteOnly, postedAfter, limit. Read-only; does not apply.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keyword / role filter (title, company, description)',
            },
            location: {
              type: 'string',
              description:
                'Location soft filter. Use "远程"/"remote" for remote-friendly; or city/country tokens matched loosely.',
            },
            remoteOnly: {
              type: 'boolean',
              description: 'If true, keep remote-friendly roles only (default true for this board).',
            },
            postedAfter: {
              type: 'string',
              description: 'ISO date YYYY-MM-DD; prefer roles posted on/after (soft if undated).',
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 40,
              description: 'Max results (default 20)',
            },
          },
        },
      },
      {
        name: 'get_job',
        description: 'Get one job by apply/detail URL from a prior search_jobs result (read-only).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Job apply or detail URL' },
          },
          required: ['url'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = String(req.params?.name || '');
    const args = req.params?.arguments || {};
    await rateLimit();
    try {
      if (name === 'search_jobs') {
        const data = await runRunner({
          op: 'search',
          query: args.query || '',
          location: args.location,
          remoteOnly: args.remoteOnly,
          postedAfter: args.postedAfter,
          limit: args.limit || 20,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      if (name === 'get_job') {
        const data = await runRunner({ op: 'get', url: args.url });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }],
        isError: true,
      };
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          },
        ],
        isError: true,
      };
    }
  });

  return {
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
