import pg from 'pg';
import { migrate } from '../db/migrate';
import type {
  Account,
  CharacterRecord,
  EventRecord,
  InjuryRecord,
  ItemData,
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
    c: Omit<CharacterRecord, 'id' | 'coin' | 'bluff' | 'insight' | 'languages' | 'hp' | 'maxHp' | 'xp' | 'deathDebt' | 'deeds' | 'retired'>,
  ): Promise<CharacterRecord | 'character_name_taken'> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `insert into characters (account_id, name, appearance_seed, area_id, x, y)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [c.accountId, c.name, c.appearanceSeed, c.areaId, c.x, c.y],
      );
      return {
        ...c, id: rows[0]!.id, coin: 0, bluff: 10, insight: 10, languages: ['common'],
        hp: 20, maxHp: 20, xp: 0, deathDebt: 0, deeds: 0, retired: false,
      };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'character_name_taken';
      throw err;
    }
  }

  async setCharacterLanguages(id: string, languages: string[]): Promise<void> {
    await this.pool.query('update characters set languages = $2 where id = $1', [id, languages]);
  }

  async setCharacterSkills(id: string, skills: { bluff?: number; insight?: number }): Promise<void> {
    await this.pool.query(
      'update characters set bluff = coalesce($2, bluff), insight = coalesce($3, insight) where id = $1',
      [id, skills.bluff ?? null, skills.insight ?? null],
    );
  }

  async saveCharacterVitals(
    id: string,
    vitals: { hp?: number; xp?: number; deathDebt?: number; deeds?: number },
  ): Promise<void> {
    await this.pool.query(
      `update characters set
         hp = coalesce($2, hp), xp = coalesce($3, xp),
         death_debt = coalesce($4, death_debt), deeds = coalesce($5, deeds)
       where id = $1`,
      [id, vitals.hp ?? null, vitals.xp ?? null, vitals.deathDebt ?? null, vitals.deeds ?? null],
    );
  }

  async addLegacyPoints(accountId: string, amount: number): Promise<void> {
    await this.pool.query('update accounts set legacy_points = legacy_points + $2 where id = $1', [
      accountId,
      amount,
    ]);
  }

  async getLegacyPoints(accountId: string): Promise<number> {
    const { rows } = await this.pool.query('select legacy_points from accounts where id = $1', [
      accountId,
    ]);
    return rows[0] ? Number(rows[0].legacy_points) : 0;
  }

  async retireCharacter(id: string): Promise<void> {
    await this.pool.query('update characters set retired_at = now() where id = $1', [id]);
  }

  async countRetired(accountId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'select count(*) as n from characters where account_id = $1 and retired_at is not null',
      [accountId],
    );
    return Number(rows[0]!.n);
  }

  async addInjury(injury: Omit<InjuryRecord, 'id'>): Promise<InjuryRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into injuries (character_id, location, kind, severity)
       values ($1, $2, $3, $4) returning id`,
      [injury.characterId, injury.location, injury.kind, injury.severity],
    );
    return { ...injury, id: rows[0]!.id };
  }

  async listInjuries(characterId: string): Promise<InjuryRecord[]> {
    const { rows } = await this.pool.query(
      'select id, character_id, location, kind, severity from injuries where character_id = $1 order by created_at',
      [characterId],
    );
    return rows.map((r) => ({
      id: r.id,
      characterId: r.character_id,
      location: r.location,
      kind: r.kind,
      severity: r.severity,
    }));
  }

  async removeInjury(injuryId: string): Promise<boolean> {
    const result = await this.pool.query('delete from injuries where id = $1', [injuryId]);
    return result.rowCount === 1;
  }

  async downgradeInjuries(characterId: string): Promise<void> {
    await this.pool.query(`update injuries set severity = 'minor' where character_id = $1`, [
      characterId,
    ]);
  }

  async getKnowledge(
    observerId: string,
    subjectIds: string[],
    presentation = 'normal',
  ): Promise<Map<string, KnowledgeRecord>> {
    if (subjectIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `select * from identity_knowledge
       where observer_character_id = $1 and presentation = $3
         and subject_character_id = any($2::uuid[])`,
      [observerId, subjectIds, presentation],
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

  async grantItem(
    ownerCharacterId: string,
    templateId: string,
    qty: number,
    data?: ItemData,
  ): Promise<ItemRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into items (template_id, owner_character_id, qty, data) values ($1, $2, $3, $4) returning id',
      [templateId, ownerCharacterId, qty, data ? JSON.stringify(data) : null],
    );
    return { id: rows[0]!.id, templateId, ownerCharacterId, qty, data: data ?? null };
  }

  async getItem(itemId: string): Promise<ItemRecord | null> {
    const { rows } = await this.pool.query(
      'select id, template_id, owner_character_id, qty, data from items where id = $1',
      [itemId],
    );
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async getItemsByCharacter(characterId: string): Promise<ItemRecord[]> {
    const { rows } = await this.pool.query(
      'select id, template_id, owner_character_id, qty, data from items where owner_character_id = $1 order by created_at',
      [characterId],
    );
    return rows.map(rowToItem);
  }

  async consumeOneItem(ownerCharacterId: string, templateId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string; qty: number }>(
        `select id, qty from items
         where owner_character_id = $1 and template_id = $2
         order by created_at limit 1 for update`,
        [ownerCharacterId, templateId],
      );
      const row = rows[0];
      if (!row) {
        await client.query('rollback');
        return false;
      }
      if (row.qty > 1) {
        await client.query('update items set qty = qty - 1 where id = $1', [row.id]);
      } else {
        await client.query('delete from items where id = $1', [row.id]);
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

  async mergeKnowledge(
    observerId: string,
    subjectId: string,
    fromPresentation: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Fold the disguised thread into 'normal' unless normal already holds a
      // name, then drop the disguised row (D-219 merge).
      await client.query(
        `insert into identity_knowledge
           (observer_character_id, subject_character_id, presentation, known_name, provenance, impression)
         select observer_character_id, subject_character_id, 'normal', known_name, provenance, impression
         from identity_knowledge
         where observer_character_id = $1 and subject_character_id = $2 and presentation = $3
         on conflict (observer_character_id, subject_character_id, presentation)
         do update set
           known_name = coalesce(identity_knowledge.known_name, excluded.known_name),
           updated_at = now()`,
        [observerId, subjectId, fromPresentation],
      );
      await client.query(
        `delete from identity_knowledge
         where observer_character_id = $1 and subject_character_id = $2 and presentation = $3`,
        [observerId, subjectId, fromPresentation],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async createDmEvent(name: string, doc: unknown) {
    const { rows } = await this.pool.query<{ id: string }>(
      'insert into dm_events (name, doc) values ($1, $2) returning id',
      [name, JSON.stringify(doc)],
    );
    return { id: rows[0]!.id, name, doc, enabled: true };
  }

  async listDmEvents() {
    const { rows } = await this.pool.query(
      'select id, name, doc, enabled from dm_events order by created_at',
    );
    return rows.map((r) => ({ id: r.id, name: r.name, doc: r.doc, enabled: r.enabled }));
  }

  async getDmEvent(id: string) {
    const { rows } = await this.pool.query(
      'select id, name, doc, enabled from dm_events where id = $1',
      [id],
    );
    const r = rows[0];
    return r ? { id: r.id, name: r.name, doc: r.doc, enabled: r.enabled } : null;
  }

  async updateDmEvent(id: string, patch: { name?: string; doc?: unknown; enabled?: boolean }) {
    await this.pool.query(
      `update dm_events set
         name = coalesce($2, name),
         doc = coalesce($3, doc),
         enabled = coalesce($4, enabled),
         updated_at = now()
       where id = $1`,
      [id, patch.name ?? null, patch.doc !== undefined ? JSON.stringify(patch.doc) : null, patch.enabled ?? null],
    );
  }

  async deleteDmEvent(id: string) {
    await this.pool.query('delete from dm_events where id = $1', [id]);
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

function rowToItem(r: Record<string, unknown>): ItemRecord {
  return {
    id: r.id as string,
    templateId: r.template_id as string,
    ownerCharacterId: r.owner_character_id as string,
    qty: r.qty as number,
    data: (r.data as ItemData | null) ?? null,
  };
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
    languages: (r.languages as string[] | null) ?? ['common'],
    hp: Number(r.hp ?? 20),
    maxHp: Number(r.max_hp ?? 20),
    xp: Number(r.xp ?? 0),
    deathDebt: Number(r.death_debt ?? 0),
    deeds: Number(r.deeds ?? 0),
    retired: r.retired_at != null,
  };
}
