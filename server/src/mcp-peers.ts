import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPeers, peerSummaries, peerReviewMarkdown } from './peers.js';

/**
 * The "peers" MCP server — a stdio server the viewer attaches to a launched Claude
 * Code session so that session can READ other sessions (read-only collaboration).
 *
 * The viewer spawns one of these per collaborating session and sets CSV_CALLER_ID to
 * that session's id. The caller's allowlist (peers.json) is the ONLY gate — we never
 * trust an id the model passes without checking it against the allowlist.
 */
const CALLER = process.env.CSV_CALLER_ID || '';

const server = new McpServer({ name: 'peers', version: '1.0.0' });

server.registerTool(
  'list_peers',
  {
    title: 'List peer sessions',
    description:
      "List the other Claude Code sessions THIS session is allowed to read (its collaboration allowlist). Returns each peer's id, title, working directory, git branch, and last-updated time. Use read_peer to read one.",
    inputSchema: {},
  },
  async () => {
    const peers = peerSummaries(getPeers(CALLER));
    if (!peers.length) {
      return { content: [{ type: 'text', text: 'No peer sessions are configured for this session.' }] };
    }
    const text = peers
      .map(
        (p) =>
          `- ${p.id}\n    title: ${p.title}\n    cwd: ${p.cwd ?? '?'}\n    branch: ${p.gitBranch ?? '?'}\n    updated: ${p.updatedAt ?? '?'}${p.found ? '' : '   (NOT FOUND)'}`,
      )
      .join('\n');
    return { content: [{ type: 'text', text: `You may read these ${peers.length} peer session(s):\n${text}` }] };
  },
);

server.registerTool(
  'read_peer',
  {
    title: 'Read a peer session',
    description:
      "Read another session's work as a de-noised Markdown trace (its prompts, reasoning, tool actions with targets, results, and files touched). Only sessions in your allowlist (see list_peers) can be read. Pass the peer's full session id.",
    inputSchema: { session_id: z.string().describe('The full id of a peer session from list_peers') },
  },
  async ({ session_id }) => {
    if (!getPeers(CALLER).includes(session_id)) {
      return {
        content: [
          {
            type: 'text',
            text: `Not permitted: "${session_id}" is not in this session's allowlist. Call list_peers to see which sessions you may read.`,
          },
        ],
        isError: true,
      };
    }
    const md = peerReviewMarkdown(session_id);
    if (md == null) {
      return { content: [{ type: 'text', text: `Peer session "${session_id}" was not found on disk.` }], isError: true };
    }
    return { content: [{ type: 'text', text: md }] };
  },
);

await server.connect(new StdioServerTransport());
