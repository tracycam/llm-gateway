import { Database } from 'bun:sqlite';
import { NodeRecord } from './cluster';

interface NodeRow {
  id: string;
  name: string;
  url: string;
  token: string | null;
  node_id: string;
  created_at: string;
}

/**
 * The registered nodes, in the gateway's one database. The only place a node token is stored.
 * The table is created by `schema.migrate`; this store never opens or closes a connection.
 */
export class NodeStore {
  constructor(private readonly db: Database) {}

  public list(): NodeRecord[] {
    const rows = this.db.query<NodeRow, []>('SELECT * FROM nodes ORDER BY created_at, id').all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      token: row.token,
      nodeId: row.node_id,
      createdAt: row.created_at,
    }));
  }

  public insert(record: NodeRecord): void {
    this.db
      .query('INSERT INTO nodes (id, name, url, token, node_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.name, record.url, record.token, record.nodeId, record.createdAt);
  }

  public update(record: NodeRecord): void {
    this.db
      .query('UPDATE nodes SET name = ?, url = ?, token = ? WHERE id = ?')
      .run(record.name, record.url, record.token, record.id);
  }

  public delete(id: string): boolean {
    return this.db.query('DELETE FROM nodes WHERE id = ?').run(id).changes > 0;
  }
}
