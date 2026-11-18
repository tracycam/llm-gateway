import { HubSnapshot, HubSseEvent, NodeIdentity } from '../server/types';
import { NodeLink, NodeLinkOptions, NodeLinkState } from './nodeLink';

/** A daemon the administrator registered. */
export interface NodeRecord {
  id: string;
  name: string;
  /** Base URL of the daemon, without a trailing slash. */
  url: string;
  /** The daemon's admin token; null for a daemon that has none. Never leaves the gateway. */
  token: string | null;
  /** The daemon's own node id, read when it was registered. */
  nodeId: string;
  createdAt: string;
}

/** A node as the console sees it: the record without its token, plus what the link knows. */
export interface NodeView {
  id: string;
  name: string;
  url: string;
  nodeId: string;
  createdAt: string;
  online: boolean;
  /** Why the node is not online; null while it is. */
  reason: string | null;
  identity: NodeIdentity | null;
  /** The daemon's state; null whenever the node is not online. */
  snapshot: HubSnapshot | null;
}

export type ClusterEvent =
  | { type: 'cluster'; data: { nodes: NodeView[] } }
  /** A node was added, renamed, re-addressed, or went online or offline. */
  | { type: 'node'; data: NodeView }
  | { type: 'node_removed'; data: { id: string } }
  /** An event of one online node's daemon, as the daemon sent it. */
  | { type: 'daemon'; data: { id: string; event: HubSseEvent } };

type LinkTiming = Pick<NodeLinkOptions, 'watchdogMs' | 'handshakeTimeoutMs' | 'retryMinMs' | 'retryMaxMs'>;

interface Member {
  record: NodeRecord;
  link: NodeLink;
}

function view(record: NodeRecord, state: NodeLinkState): NodeView {
  const { token: _token, ...visible } = record;
  return { ...visible, ...state };
}

/**
 * The registered nodes and the gateway's connection to each. Everything the gateway knows
 * about a machine is in here and comes from that machine's daemon.
 */
export class Cluster {
  private members = new Map<string, Member>();
  private listeners = new Set<(event: ClusterEvent) => void>();

  constructor(records: NodeRecord[], private readonly timing: LinkTiming = {}) {
    for (const record of records) this.connect(record);
  }

  public list(): NodeView[] {
    return [...this.members.values()].map(({ record, link }) => view(record, link.state));
  }

  public get(id: string): NodeView | undefined {
    const member = this.members.get(id);
    return member && view(member.record, member.link.state);
  }

  /** The record with its token, for calling the node's daemon. */
  public record(id: string): NodeRecord | undefined {
    return this.members.get(id)?.record;
  }

  public add(record: NodeRecord): void {
    if (this.members.has(record.id)) throw new Error(`node ${record.id} already exists`);
    this.connect(record);
    this.emit({ type: 'node', data: this.get(record.id)! });
  }

  /** Replaces a node's record. A new address or token starts a new connection. */
  public update(record: NodeRecord): void {
    const member = this.members.get(record.id);
    if (!member) throw new Error(`node ${record.id} does not exist`);
    const sameConnection =
      member.record.url === record.url &&
      member.record.token === record.token &&
      member.record.nodeId === record.nodeId;
    if (sameConnection) {
      member.record = record;
    } else {
      // The old link reports nothing from here on; the node is never absent from the list.
      void member.link.stop();
      this.connect(record);
    }
    this.emit({ type: 'node', data: this.get(record.id)! });
  }

  public remove(id: string): void {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);
    void member.link.stop();
    this.emit({ type: 'node_removed', data: { id } });
  }

  /** Calls `listener` with every event from now on; returns the function that ends it. */
  public subscribe(listener: (event: ClusterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async close(): Promise<void> {
    const members = [...this.members.values()];
    this.members.clear();
    this.listeners.clear();
    await Promise.all(members.map((member) => member.link.stop()));
  }

  private connect(record: NodeRecord): void {
    const link = new NodeLink({
      ...this.timing,
      url: record.url,
      token: record.token,
      expectedNodeId: record.nodeId,
      onChange: () => {
        const current = this.get(record.id);
        if (current) this.emit({ type: 'node', data: current });
      },
      onEvent: (event) => this.emit({ type: 'daemon', data: { id: record.id, event } }),
    });
    this.members.set(record.id, { record, link });
    link.start();
  }

  private emit(event: ClusterEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // A failing subscriber must not end the connection that delivered the event.
        console.error('[cluster] subscriber failed:', err);
      }
    }
  }
}
