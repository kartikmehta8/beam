/**
 * @file HTTP entry point: `GET /health`, `POST /v1/agent`, `/v1/approvals`
 * and `/v1/handles`, with bearer auth, rate limiting, body limit, zod
 * validation and one log line per request. Run directly to start the server;
 * tests import `createApp`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { anthropicCreateMessage, runAgent, type AgentDeps } from './agent';
import { createApprovals, type Approvals } from './approvals/routes';
import { createSessionStore } from './approvals/sessions';
import { createApprover } from './approvals/signer';
import { createWorldId } from './approvals/worldId';
import { createProfileRoutes } from './profile/routes';
import { createChainClient, createEnsClient } from './chain';
import { loadServerConfig } from './config';
import { loadHandlesConfig, type HandlesConfig } from './handles/config';
import { createHandleRoutes } from './handles/routes';
import { maskAddress, type Env } from './http';
import { mountMcpHttp } from './mcpHttp';
import { agentRequestSchema } from './schemas';

export { maskAddress };

const BODY_LIMIT_BYTES = 32 * 1024;
const RATE_LIMIT_PER_MIN = 30;
/** Polls of a known approval get their own window per approval id, so polling never starves `/v1/agent` and vice versa. */
const POLLS_PER_SECOND = 2;
const COMPLETE_PATH = /^\/v1\/approvals\/([^/]{1,64})\/complete$/;

/** Agent dependencies plus the HTTP layer's token, approvals, handles, clock and log sink. */
export type AppDeps = AgentDeps & {
  agentToken: string;
  approvals: Approvals;
  /** `createHandleRoutes(...)` from the handles module; null when not mounted. */
  handleRoutes: Hono | null;
  /** Whether handle claims can actually be made (handles configured). */
  handlesEnabled: boolean;
  ensChainId: number;
  /** Daily limit (network token) the hosted MCP proposes under; the phone re-checks before signing. Default 100. */
  mcpDailyLimit?: string;
  /** Folder for uploaded profile avatars; defaults to `uploads`. */
  uploadsDir?: string;
  /** Clock for the rate limiter; injectable for tests. */
  now?: () => number;
  /** Receives one JSON line per request. */
  log?: (line: string) => void;
};

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Fixed window counters, one per key; stale windows are dropped when a new one opens.
 * ponytail: one shared token, so windows live in process memory. Use a store keyed per token/device if tokens multiply.
 * @param limit Requests allowed per window and key.
 * @param windowMs Window length.
 * @param now Clock.
 * @returns `hit(key)`, false once that key exceeds the limit.
 */
function fixedWindows(limit: number, windowMs: number, now: () => number): { hit: (key: string) => boolean } {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit: (key) => {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        for (const [k, old] of windows) if (t - old.start >= windowMs) windows.delete(k);
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      return ++w.count <= limit;
    },
  };
}

/**
 * Builds the Hono app. All I/O (model, chain, ENS, World, clock, log sink) is injected.
 * @param deps Token, agent deps, approvals, handle routes and optional clock/log sink.
 * @returns The app; use `app.fetch` or `app.request`.
 */
export function createApp(deps: AppDeps): Hono<Env> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const expected = sha256(deps.agentToken);
  const apiWindow = fixedWindows(RATE_LIMIT_PER_MIN, 60_000, now);
  const pollWindows = fixedWindows(POLLS_PER_SECOND, 1_000, now);
  const requestSchema = agentRequestSchema(deps.network);

  const app = new Hono<Env>();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      network: deps.network.key,
      chainId: deps.network.chainId,
      model: deps.model,
      beamPay: deps.beamPay,
      world: deps.approvals.mode,
      handles: deps.handlesEnabled,
      ensChainId: deps.ensChainId,
    }),
  );

  // One log line per API request, whatever the outcome. Handlers add safe fields via `c.set('log', …)`.
  app.use('/v1/*', async (c, next) => {
    const started = now();
    await next();
    log(JSON.stringify({ path: c.req.path, status: c.res.status, ms: now() - started, ...c.get('log') }));
  });

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    // Hashing first gives equal-length buffers, so the compare is constant-time regardless of input length.
    if (!token || !timingSafeEqual(sha256(token), expected)) return c.json({ error: 'UNAUTHORIZED', message: 'Missing or bad token.' }, 401);
    // Polls of a known approval use its own window; unknown ids count against the shared one (no free enumeration).
    const pollId = c.req.method === 'POST' ? COMPLETE_PATH.exec(c.req.path)?.[1] : undefined;
    const allowed = pollId !== undefined && deps.approvals.isKnown(pollId) ? pollWindows.hit(pollId) : apiWindow.hit('');
    if (!allowed) return c.json({ error: 'RATE_LIMITED', message: 'Too many requests.' }, 429);
    return next();
  };
  app.use('/v1/*', auth);
  app.use(
    '/v1/*',
    bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Body too large.' }, 413) }),
  );

  app.post('/v1/agent', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'BAD_REQUEST', message: z.prettifyError(parsed.error).slice(0, 500) }, 400);
    }
    const req = parsed.data;
    const { response, errorCodes } = await runAgent(req, deps);
    c.set('log', {
      requestId: req.requestId.slice(0, 64),
      tools: response.meta.toolCalls,
      intents: response.intents.length,
      routes: response.intents.map((i) => i.route),
      clarification: !!response.clarification,
      fallback: response.meta.fallback,
      errors: errorCodes,
      wallet: maskAddress(req.wallet.address),
      to: response.intents.map((i) => maskAddress(i.to)),
      byName: response.intents.filter((i) => i.toName).length,
      contextChars: req.context?.text.length ?? 0,
    });
    return c.json(response);
  });

  app.route('/v1/approvals', deps.approvals.routes);
  if (deps.handleRoutes) app.route('/v1/handles', deps.handleRoutes);
  app.route('/profile', createProfileRoutes({ agentToken: deps.agentToken, uploadsDir: deps.uploadsDir ?? 'uploads' }));

  // Hosted MCP over HTTP (outside /v1 auth): `claude mcp add --transport http beam <url>/mcp/<wallet>`.
  mountMcpHttp(app, {
    chain: deps.chain,
    ens: deps.ens,
    network: deps.network,
    beamPay: deps.beamPay,
    dailyLimit: deps.mcpDailyLimit ?? '100',
  });

  app.onError((err, c) => {
    c.set('log', { errors: [err.name] });
    return c.json({ error: 'INTERNAL', message: 'Something went wrong.' }, 500);
  });

  return app;
}

/** Reads env, refuses unsafe config, and starts listening. */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  await mkdir('uploads', { recursive: true });
  const loaded = await loadServerConfig(process.env);
  if (!loaded.ok) {
    console.error(`Refusing to start:\n- ${loaded.errors.join('\n- ')}`);
    process.exit(1);
  }
  let handles: HandlesConfig | null;
  try {
    handles = loadHandlesConfig(process.env);
  } catch (e) {
    console.error(`Refusing to start:\n- ${(e as Error).message}`);
    process.exit(1);
  }
  for (const w of loaded.warnings) console.warn(w);
  if (!handles) console.warn('Handles are not configured (ENS_PARENT_NAME, ENS_REGISTRAR_PRIVATE_KEY, ENS_HANDLE_REGISTRY): claims return 503.');
  const config = loaded.config;
  const chain = createChainClient(config.network, config.rpcUrl);
  const ens = createEnsClient(config.ensChain, config.ensRpcUrl);
  const approvals = createApprovals({
    world: config.world.id ? createWorldId(config.world.id) : null,
    approver: config.world.approverKey ? createApprover(config.world.approverKey, config.network.chainId, config.beamPay) : null,
    sessions: createSessionStore(config.world.sessionsPath),
    chain,
    network: config.network,
    beamPay: config.beamPay,
    humanHashSalt: config.world.humanHashSalt,
  });
  const handleRoutes = createHandleRoutes({
    ensClient: ens,
    takeHandleApproval: approvals.takeHandleApproval,
    config: handles,
  });
  const app = createApp({
    agentToken: config.agentToken,
    model: config.model,
    chain,
    ens,
    network: config.network,
    beamPay: config.beamPay,
    createMessage: config.anthropicApiKey ? anthropicCreateMessage(new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1 })) : null,
    approvals,
    handleRoutes,
    handlesEnabled: handles !== null,
    ensChainId: config.ensChainId,
  });
  serve({ fetch: app.fetch, port: config.port }, () =>
    console.log(
      `Beam server on :${config.port} (${config.network.name}, chain ${config.network.chainId}, model ${config.model}, world ${config.world.mode}, ENS chain ${config.ensChainId})`,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
