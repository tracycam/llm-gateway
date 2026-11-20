// DGP/1, the wire contract between an AI-Hub daemon and this gateway, as the gateway reads it
// (docs/daemon-protocol.md). Only the fields the gateway uses are declared: a daemon's snapshot
// carries much more, and none of it matters on this side of the wire.
//
// This is the gateway's own copy of the contract: the daemon and the gateway are two programs,
// and neither imports the other's code. `deriveWorkerToken` is the one function both compute
// for themselves; `dgp.test.ts` pins it to a fixed value so the two sides cannot drift.
import { createHmac } from 'node:crypto';

/** The daemon API version this gateway speaks. */
export const DAEMON_API_VERSION = 1;

export type ServiceStatus = 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'ERROR';

/** A wire protocol a worker speaks. */
export type WireProtocol = 'chat' | 'messages' | 'responses';

/** The fields of a daemon's `ServiceInstance` the gateway reads. */
export interface ServiceInstance {
  /** Unique service instance id on its daemon. */
  id: string;
  status: ServiceStatus;
  /** The upstream model name this daemon exposes. */
  modelName: string;
  /** The worker's TCP port; null unless `status` is `READY`. */
  port: number | null;
  /** Verified worker concurrency limit, at least 1. */
  maxConcurrency: number;
  /** Context window in tokens. */
  contextLength: number;
  /** Max output tokens; absent or null when the daemon does not know. */
  maxOutputTokens?: number | null;
  /** Wire protocols the worker speaks; absent when it only speaks Chat. */
  protocols?: WireProtocol[];
}

/** What `GET /api/v1/node` answers. */
export interface NodeIdentity {
  /** Persistent UUID; unchanged across daemon restarts. */
  nodeId: string;
  hostname: string;
  version: string;
  apiVersion: 1;
  /** Inclusive `[min, max]` of the worker port range. */
  workerPortRange?: [number, number];
  capabilities?: {
    workerProtocols: boolean;
  };
}

/**
 * The daemon state the gateway mirrors. Only the service list is read: cards, models, logs and
 * the rest belong to the console in front of the daemon, not to the gateway.
 */
export interface DaemonSnapshot {
  services: ServiceInstance[];
}

/** One frame of `GET /api/v1/events`. */
export type DaemonEvent =
  | { type: 'snapshot'; data: DaemonSnapshot }
  | { type: 'state'; data: { services: ServiceInstance[] } }
  | { type: 'log'; data: { engineId: string; line: string } }
  | { type: 'logs_cleared'; data: { engineId: string } }
  | { type: 'app_log'; data: { appId: string; line: string } }
  | { type: 'app_logs_cleared'; data: { appId: string } };

/**
 * The snapshot after one event. `snapshot` replaces it, `state` moves its service list forward;
 * log frames carry text for the console and leave the snapshot as it was.
 */
export function applyDaemonEvent(snapshot: DaemonSnapshot, event: DaemonEvent): DaemonSnapshot {
  switch (event.type) {
    case 'snapshot':
      return event.data;
    case 'state':
      return { ...snapshot, services: event.data.services };
    default:
      return snapshot;
  }
}

/**
 * The token a daemon's workers require, derived from the daemon's admin token: the daemon and
 * the gateway each compute it, and the control-plane token is never passed to a worker.
 */
export function deriveWorkerToken(nodeToken: string): string {
  return createHmac('sha256', nodeToken).update('aihub-worker-v1').digest('hex');
}
