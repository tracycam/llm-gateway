// The gateway's copy of DGP/1: the reducer it mirrors a daemon with, and the worker token it
// derives from the daemon's own token.
import { describe, expect, test } from 'bun:test';
import { applyDaemonEvent, deriveWorkerToken, type DaemonEvent, type ServiceInstance } from './dgp';

const TOKEN = 'daemon-admin-token-0123456789';

const service = { id: 'svc-1', status: 'READY', modelName: 'local-model' } as unknown as ServiceInstance;

describe('deriveWorkerToken', () => {
  test('is HMAC-SHA256 of the daemon token over the fixed label', () => {
    // Computed once from the daemon's implementation (protocol/workerToken.ts) and pinned here:
    // the daemon and the gateway each compute this token, so the two may never drift.
    expect(deriveWorkerToken(TOKEN)).toBe(
      '3f51d84fe5de5c78bfd1c36be0ea12ff16d2a345905ddade6b4ed72b3b0c6929',
    );
  });

  test('is not the daemon token itself', () => {
    expect(deriveWorkerToken(TOKEN)).not.toBe(TOKEN);
  });
});

describe('applyDaemonEvent', () => {
  test('a snapshot replaces the state', () => {
    const next = applyDaemonEvent({ services: [] }, { type: 'snapshot', data: { services: [service] } });
    expect(next).toEqual({ services: [service] });
  });

  test('a state moves the service list forward', () => {
    const next = applyDaemonEvent({ services: [service] }, { type: 'state', data: { services: [] } });
    expect(next).toEqual({ services: [] });
  });

  test('a log frame leaves the service list alone', () => {
    const event: DaemonEvent = { type: 'log', data: { engineId: 'engine', line: '加载权重' } };
    expect(applyDaemonEvent({ services: [service] }, event)).toEqual({ services: [service] });
  });
});
