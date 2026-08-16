import pg from 'pg';
import { migrate } from '../db/migrate';
import type {
  Account,
  CharacterRecord,
  EventRecord,
  ItemRecord,
  KnowledgeRecord,
  SessionRecord,
  Store,
} from './types';

/** Production Store. Postgres is the source of truth (D-106). */
export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }

  async init(): Promise<void> {
    await migrate(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createAccount(username: string, passHash: string): Promise<Account | 'username_taken'> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        'insert into accounts (username, pass_hash) values ($1, $2) returning id',
        [username, passHash],
      );
      return { id: rows[0]!.id, username, passHash };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'username_taken';
      throw err;
    }
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    const { rows } = await this.pool.query(
      'select id, username, pass_hash from accounts where lower(username) = lower($1)',
      [username],
    );
    const r = rows[0];
    return r ? { id: r.id, username: r.username, passHash: r.pass_hash } : null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      'insert into sessions (token, account_id, expires_at) values ($1, $2, to_timestamp($3 / 1000.0))',
      [session.token, session.accountId, session.expiresAt],
    );
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query(
      `select token, account_id, (extract(epoch from expires_at) * 1000)::bigint as expires_at
       from sessions where token = $1 and expires_at > now()`,
      [token],
    );
    const r = rows[0];
    return r ? { token: r.token, accountId: r.account_id, expiresAt: Number(r.expires_at) } : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('delete from sessions where token = $1', [token]);
  }

  async createCharacter(
    c: Omit<CharacterRecord, 'id' | 'coin' | 'bluff' | 'insight'>,
  ): Promise<CharacterRecord | 'character_name_taken'> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `insert into characters (account_id, name, appearance_seed, area_id, x, y)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [c.accountId, c.name, c.appearanceSeed, c.areaId, c.x, c.y],
      );
      return { ...c, id: rows[0]!.id, coin: 0, bluff: 10, insight: 10 };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'character_name_taken';
      throw err;
    }
  }

  async setCharacterSkills(id: string, skills: { bluff?: number; insight?: number }): Promise<void> {
    await this.pool.query(
      'update characters set bluff = coalesce($2, bluff), insight = coalesce($3, insight) where id = $1',
      [id, skills.bluff ?? null, skills.insight ?? null],
    );
  }

  async getKnowledge(
    observerId: string,
    subjectIds: string[],
  ): Promise<Map<string, KnowledgeRecord>> {
    if (subjectIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `select * from identity_knowledge
       where observer_character_id = $1 and presentation = 'normal'
         and subject_character_id = any($2::uuid[])`,
      [observerId, subjectIds],
    );
    const out = new Map<string, KnowledgeRecord>();
    for (const r of rows) {
      out.set(r.subject_character_id, {
        observerCharacterId: r.observer_character_id,
        subjectCharacterId: r.subject_character_id,
        presentation: r.presentation,
        knownName: r.known_name,
        provenance: r.provenance,
        impression: r.impression,
      });
    }
    return out;
  }

  async upsertKnowledge(k: KnowledgeRecord): Promise<void> {
    await this.pool.query(
      `insert into identity_knowledge
         (observer_character_id, subject_character_id, presentation, known_name, provenance, impression)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (observer_character_id, subject_character_id, presentation)
       do update set known_name = $4, provenance = $5, impression = $6, updated_at = now()`,
      [
        k.observerCharacterId,
        k.subjectCharacterId,
        k.presentation,
        k.knownName,
        k.provenance,
        k.impression,
      ],
    );
  }

  async getCharacter(id: string): Promise<CharacterRecord | null> {
    const { rows } = await this.pool.query('select * from characters where id = $1', [id]);
    return rows[0] ? rowToCharacter(rows[0]) : null;
  }

  async getCharactersByAccount(accountId: string): Promise<CharacterRecord[]> {
    const { rows } = await this.pool.query(
      'select * from characters where account_id = $1 order by created_at',
      [accountId],
    );
    return rows.map(rowToCharacter);
  }

  async saveCharacterPosition(id: string, areaId: string, x: number, y: number): Promise<void> {
    await this.pool.query('update characters set area_id = $2, x = $3, y = $4 where id = $1', [
      id,
      areaId,
      x,
      y,
    ]);
  }

  async grantItem(ownerCharacterId: string, templateId: string, qty: number): Promise<ItemRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into items (template_id, owner_character_id, qty) values ($1, $2, $3) returning id',
      [templateId, ownerCharacterId, qty],
    );
    return { id: rows[0]!.id, templateId, ownerCharacterId, qty };
  }

  async getItemsByCharacter(characterId: string): Promise<ItemRecord[]> {
    const { rows } = await this.pool.query(
      'select id, template_id, owner_character_id, qty from items where owner_character_id = $1 order by created_at',
      [characterId],
    );
    return rows.map((r) => ({
      id: r.id,
      templateId: r.template_id,
      ownerCharacterId: r.owner_character_id,
      qty: r.qty,
    }));
  }

  async transferItem(
    itemId: string,
    fromCharacterId: string,
    toCharacterId: string,
  ): Promise<boolean> {
    // Single conditional UPDATE — atomic under concurrency: only one caller
    // can match owner = from, so an item can never be duplicated (D-114).
    const result = await this.pool.query(
      `update items set owner_character_id = $3
       where id = $1 and owner_character_id = $2
         and exists (select 1 from characters where id = $3)`,
      [itemId, fromCharacterId, toCharacterId],
    );
    return result.rowCount === 1;
  }

  async grantCoin(characterId: string, amount: number): Promise<void> {
    await this.pool.query('update characters set coin = coin + $2 where id = $1', [
      characterId,
      amount,
    ]);
  }

  async getCoin(characterId: string): Promise<number> {
    const { rows } = await this.pool.query('select coin from characters where id = $1', [
      characterId,
    ]);
    return rows[0] ? Number(rows[0].coin) : 0;
  }

  async transferCoin(
    fromCharacterId: string,
    toCharacterId: string,
    amount: number,
  ): Promise<boolean> {
    if (amount <= 0 || !Number.isInteger(amount)) return false;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Deterministic lock order (by id) prevents deadlock on crossing payments.
      const first = fromCharacterId < toCharacterId ? fromCharacterId : toCharacterId;
      const second = fromCharacterId < toCharacterId ? toCharacterId : fromCharacterId;
      await client.query('select 1 from characters where id = $1 for update', [first]);
      await client.query('select 1 from characters where id = $1 for update', [second]);
      const debit = await client.query(
        'update characters set coin = coin - $2 where id = $1 and coin >= $2',
        [fromCharacterId, amount],
      );
      if (debit.rowCount !== 1) {
        await client.query('rollback');
        return false;
      }
      const credit = await client.query('update characters set coin = coin + $2 where id = $1', [
        toCharacterId,
        amount,
      ]);
      if (credit.rowCount !== 1) {
        await client.query('rollback');
        return false;
      }
      await client.query('commit');
      return true;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async appendEvent(type: string, data: Record<string, unknown>): Promise<void> {
    await this.pool.query('insert into event_log (type, data) values ($1, $2)', [
      type,
      JSON.stringify(data),
    ]);
  }

  async listRecentEvents(limit: number): Promise<EventRecord[]> {
    const { rows } = await this.pool.query(
      'select id, type, data from event_log order by id desc limit $1',
      [limit],
    );
    return rows.reverse().map((r) => ({ id: Number(r.id), type: r.type, data: r.data }));
  }

  async totalCoin(): Promise<number> {
    const { rows } = await this.pool.query('select coalesce(sum(coin), 0) as total from characters');
    return Number(rows[0]!.total);
  }

  async countItems(): Promise<number> {
    const { rows } = await this.pool.query('select coalesce(sum(qty), 0) as total from items');
    return Number(rows[0]!.total);
  }

  /** Escape hatch for tests that need to assert database-level behaviour. */
  query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    return this.pool.query(text, params as never[]);
  }
}

function rowToCharacter(r: Record<string, unknown>): CharacterRecord {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    name: r.name as string,
    appearanceSeed: Number(r.appearance_seed),
    areaId: r.area_id as string,
    x: r.x as number,
    y: r.y as number,
    coin: Number(r.coin),
    bluff: Number(r.bluff ?? 10),
    insight: Number(r.insight ?? 10),
  };
}
