import { Database } from 'bun:sqlite';
import { NodeRecord } from './cluster';
import { openGatewayDatabase } from './database';

interface NodeRow {
  id: string;
  name: string;
  url: string;
  token: string | null;
  node_id: string;
  created_at: string;
}

/** The registered nodes, in the gateway's database. The only place a node token is stored. */
export class NodeStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    this.db = openGatewayDatabase(dataDir);
    this.db.exec(`CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      token TEXT,
      node_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`);
  }

  public list(): NodeRecord[] {
    const rows = this.db.query('SELECT * FROM nodes ORDER BY created_at, id').all() as NodeRow[];
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

  public close(): void {
    this.db.close();
  }
}
