import { randomBytes } from 'node:crypto';
import { errorResponse, jsonResponse } from './http';
import { Cluster, NodeRecord } from './cluster';
import { fetchNodeIdentity } from './nodeLink';
import { NodeStore } from './nodeStore';

export const NODES_PATH = '/api/gateway/nodes';

const IDENTITY_TIMEOUT_MS = 5_000;

/** What a daemon owns (AGENTS.md 1.5). Only these of its /api/v1/ resources are forwarded. */
const FORWARDED_RESOURCES = new Set(['services', 'catalog', 'hardware', 'engines', 'operations', 'settings']);

/** A request the gateway turns down; the message is what the administrator is shown. */
class Refused extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

async function readObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new Refused('请求体无效');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Refused('请求体无效');
  return body as Record<string, unknown>;
}

function nameFrom(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Refused('名称不能为空');
  return value.trim();
}

/** A daemon's base URL: scheme, host and port, nothing after them. */
function urlFrom(value: unknown): string {
  if (typeof value !== 'string' || !URL.canParse(value)) throw new Refused('地址无效');
  const url = new URL(value);
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  const isBare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!isHttp || !isBare) throw new Refused('地址无效');
  return url.origin;
}

/** The empty string means the daemon has no token. */
function tokenFrom(value: unknown): string | null {
  if (typeof value !== 'string') throw new Refused('令牌必须是字符串');
  return value === '' ? null : value;
}

/** The node id of the daemon that answers at `url` with `token`. */
async function nodeIdAt(url: string, token: string | null): Promise<string> {
  const timeout = AbortSignal.timeout(IDENTITY_TIMEOUT_MS);
  try {
    return (await fetchNodeIdentity(url, token, timeout)).nodeId;
  } catch (err) {
    if (timeout.aborted) throw new Refused('连接失败：握手超时');
    throw new Refused(err instanceof Error ? err.message : String(err));
  }
}

async function register(req: Request, cluster: Cluster, store: NodeStore): Promise<Response> {
  const body = await readObject(req);
  const name = nameFrom(body.name);
  const url = urlFrom(body.url);
  const token = body.token === undefined ? null : tokenFrom(body.token);
  const nodeId = await nodeIdAt(url, token);

  // Nothing is awaited from here to the insert, so one daemon cannot be registered twice.
  const registered = cluster.list().find((node) => node.nodeId === nodeId);
  if (registered) throw new Refused(`该节点已登记为「${registered.name}」`, 409);
  const record: NodeRecord = {
    id: `node-${randomBytes(4).toString('hex')}`,
    name,
    url,
    token,
    nodeId,
    createdAt: new Date().toISOString(),
  };
  store.insert(record);
  cluster.add(record);
  return jsonResponse({ node: cluster.get(record.id) }, 201);
}

async function change(req: Request, id: string, cluster: Cluster, store: NodeStore): Promise<Response> {
  const body = await readObject(req);
  const changes: Partial<Pick<NodeRecord, 'name' | 'url' | 'token'>> = {};
  if ('name' in body) changes.name = nameFrom(body.name);
  if ('url' in body) changes.url = urlFrom(body.url);
  if ('token' in body) changes.token = tokenFrom(body.token);

  const before = cluster.record(id);
  if (!before) throw new Refused('Not Found', 404);
  const connection = { ...before, ...changes };
  if (connection.url !== before.url || connection.token !== before.token) {
    const nodeId = await nodeIdAt(connection.url, connection.token);
    if (nodeId !== before.nodeId) throw new Refused('该地址上是另一个节点；请删除后重新登记');
  }

  // The check above takes time: the node may have been changed or removed meanwhile.
  const current = cluster.record(id);
  if (!current) throw new Refused('Not Found', 404);
  const updated = { ...current, ...changes };
  store.update(updated);
  cluster.update(updated);
  return jsonResponse({ node: cluster.get(id) });
}

/** Sends a management request to the node's daemon and returns the daemon's answer as it is. */
async function forward(req: Request, id: string, rest: string, cluster: Cluster): Promise<Response> {
  const record = cluster.record(id);
  const node = cluster.get(id);
  if (!record || !node || !FORWARDED_RESOURCES.has(rest.split('/')[0])) throw new Refused('Not Found', 404);
  if (node.reason !== null) throw new Refused(node.reason, 502);

  // Built from nothing: the browser's own Cookie and Authorization stay at the gateway.
  const headers = new Headers();
  if (record.token !== null) headers.set('Authorization', `Bearer ${record.token}`);
  const contentType = req.headers.get('content-type');
  if (contentType !== null) headers.set('Content-Type', contentType);

  let answer: Response;
  try {
    answer = await fetch(`${record.url}/api/v1/${rest}${new URL(req.url).search}`, {
      method: req.method,
      headers,
      body: req.body === null ? undefined : await req.arrayBuffer(),
      signal: req.signal,
      redirect: 'manual',
    });
  } catch (err) {
    throw new Refused(`连接失败：${err instanceof Error ? err.message : String(err)}`, 502);
  }
  const answerType = answer.headers.get('content-type');
  return new Response(answer.body, {
    status: answer.status,
    headers: answerType === null ? {} : { 'Content-Type': answerType },
  });
}

function route(req: Request, cluster: Cluster, store: NodeStore): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === NODES_PATH && req.method === 'GET') return jsonResponse({ nodes: cluster.list() });
  if (pathname === NODES_PATH && req.method === 'POST') return register(req, cluster, store);

  const [, id, rest] = pathname.match(/^\/api\/gateway\/nodes\/([^/]+)(?:\/daemon\/(.+))?$/) ?? [];
  if (rest !== undefined) return forward(req, id, rest, cluster);
  if (id !== undefined && req.method === 'PATCH') return change(req, id, cluster, store);
  if (id !== undefined && req.method === 'DELETE' && store.delete(id)) {
    cluster.remove(id);
    return jsonResponse({ ok: true });
  }
  throw new Refused('Not Found', 404);
}

/** Everything under /api/gateway/nodes: the node list, registration, and calls to a node's daemon. */
export async function handleNodeRoute(req: Request, cluster: Cluster, store: NodeStore): Promise<Response> {
  try {
    return await route(req, cluster, store);
  } catch (err) {
    if (err instanceof Refused) return errorResponse(err.message, err.status);
    throw err;
  }
}
