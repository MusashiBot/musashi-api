import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';

function loadEnvFile(fileName: string, override = false): void {
  const filePath = resolve(process.cwd(), fileName);

  if (!existsSync(filePath)) {
    return;
  }

  const contents = readFileSync(filePath, 'utf8');

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    value = value.replace(/\\n/g, '\n');

    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile('.env');
loadEnvFile('.env.local', true);

import analyzeTextHandler from '../api/analyze-text';
import groundProbabilityHandler from '../api/ground-probability';
import healthHandler from '../api/health';
import feedHandler from '../api/feed';
import feedStatsHandler from '../api/feed/stats';
import feedAccountsHandler from '../api/feed/accounts';
import arbitrageHandler from '../api/markets/arbitrage';
import moversHandler from '../api/markets/movers';

type Handler = (req: any, res: any) => Promise<void> | void;
type QueryValue = string | string[];

const HOST = process.env.MUSASHI_LOCAL_API_HOST || '127.0.0.1';
const PORT = Number(process.env.MUSASHI_LOCAL_API_PORT || 3000);

const ROUTES = new Map<string, Handler>([
  ['/api/analyze-text', analyzeTextHandler],
  ['/api/ground-probability', groundProbabilityHandler],
  ['/api/health', healthHandler],
  ['/api/feed', feedHandler],
  ['/api/feed/stats', feedStatsHandler],
  ['/api/feed/accounts', feedAccountsHandler],
  ['/api/markets/arbitrage', arbitrageHandler],
  ['/api/markets/movers', moversHandler],
]);

function buildQuery(url: URL): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};

  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }

  return query;
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > 1_000_000) {
      throw new Error('Request body too large');
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseFormBody(rawBody: string): Record<string, string | string[]> {
  const params = new URLSearchParams(rawBody);
  const body: Record<string, string | string[]> = {};

  for (const [key, value] of params.entries()) {
    const existing = body[key];
    if (existing === undefined) {
      body[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      body[key] = [existing, value];
    }
  }

  return body;
}

async function parseBody(req: IncomingMessage): Promise<any> {
  const method = req.method || 'GET';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return undefined;
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    return {};
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    return JSON.parse(rawBody);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseFormBody(rawBody);
  }

  if (contentType.startsWith('text/')) {
    return rawBody;
  }

  return rawBody;
}

function createResponse(res: ServerResponse) {
  let statusCode = 200;

  return {
    setHeader(name: string, value: string | number | readonly string[]) {
      res.setHeader(name, value);
      return this;
    },
    getHeader(name: string) {
      return res.getHeader(name);
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      if (!res.hasHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.statusCode = statusCode;
      res.end(JSON.stringify(payload));
      return this;
    },
    send(payload: unknown) {
      res.statusCode = statusCode;
      if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        res.end(payload);
      } else {
        if (!res.hasHeader('Content-Type')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(JSON.stringify(payload));
      }
      return this;
    },
    end(payload?: string | Buffer) {
      res.statusCode = statusCode;
      res.end(payload);
      return this;
    },
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function createRequest(req: IncomingMessage, url: URL, body: unknown) {
  return Object.assign(req, {
    query: buildQuery(url),
    body,
    cookies: {},
  });
}

function wantsJson(headers: IncomingHttpHeaders): boolean {
  const accept = String(headers.accept || '');
  return accept.includes('application/json') || accept.includes('*/*') || accept === '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const handler = ROUTES.get(url.pathname);

  if (!handler) {
    sendJson(res, 404, {
      success: false,
      error: 'Route not found.',
    });
    return;
  }

  let body: unknown;
  try {
    body = await parseBody(req);
  } catch (error) {
    if (wantsJson(req.headers)) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid request body',
      });
    } else {
      res.statusCode = 400;
      res.end('Invalid request body');
    }
    return;
  }

  const localReq = createRequest(req, url, body);
  const localRes = createResponse(res);

  try {
    await handler(localReq, localRes);
  } catch (error) {
    console.error('[Local API] Unhandled route error:', error);
    if (!res.writableEnded) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local Musashi API listening on http://${HOST}:${PORT}`);
});
