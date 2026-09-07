/**
 * Inbound email.
 *
 * The properties defended here are the ones that decide whether syncing a
 * mailbox is safe to offer at all:
 *
 *   - Only mail exchanged with a known contact is stored. A mailbox belongs to
 *     a person and most of it is none of this product's business.
 *   - The same message is never stored twice, however often a sync overlaps.
 *   - An inbound message is data. It cannot become an outbound one, and nothing
 *     about it is treated as an instruction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withService } from '@/lib/db';
import { createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser } from '../helpers/factories';

describe('inbound email', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let company: { id: string; name: string };
  let connectionId: string;
  let contactId: string;

  /** Calls the ingest function the way the sync job does. */
  async function ingest(overrides: Partial<Record<string, unknown>> = {}) {
    const message = {
      rfc822: `<${randomUUID()}@mail.example>`,
      thread: 'thread-1',
      inReplyTo: null,
      from: 'priya@clientco.example',
      fromName: 'Priya Anand',
      to: ['us@velozity.example'],
      subject: 'Re: the proposal',
      body: 'Looks good, one question about scope.',
      snippet: 'Looks good, one question…',
      receivedAt: new Date().toISOString(),
      ...overrides,
    };

    return withService('test ingest', async (tx) => {
      await tx.bindOrg(org.id);
      const row = await tx.one<{ id: string | null }>(
        `select app.ingest_inbound_email($1,$2,'gmail',$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12) as id`,
        [
          org.id, connectionId, message.rfc822, message.thread, message.inReplyTo,
          message.from, message.fromName, message.to, message.subject,
          message.body, message.snippet, message.receivedAt,
        ],
      );
      return row.id;
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'agency-one', name: 'Agency One' });
    org = a.org;
    admin = a.admin;
    company = await createCompany(db.driver, org.id, { name: 'Client Co' });

    contactId = randomUUID();
    await db.driver.query(
      `insert into contacts (id, org_id, company_id, first_name, last_name, email,
                             contact_role, is_primary, created_by)
       values ($1,$2,$3,'Priya','Anand','priya@clientco.example','decision_maker',true,$4)`,
      [contactId, org.id, company.id, admin.id],
    );

    connectionId = randomUUID();
    await db.driver.query(
      `insert into integration_connections (id, org_id, provider, purpose, display_name,
                                            config, secret_ref, status, created_by)
       values ($1,$2,'gmail','mailbox','Sales mailbox','{}','GMAIL_TOKEN','active',$3)`,
      [connectionId, org.id, admin.id],
    );
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('stores a message from a known contact and attaches it to their company', async () => {
    const id = await ingest();
    expect(id).not.toBeNull();

    const row = await db.driver.query<{
      direction: string; company_id: string; contact_id: string; status: string;
      requires_approval: boolean; sent_at: string | null;
    }>(
      `select direction, company_id, contact_id, status, requires_approval, sent_at
         from email_messages where id = $1`,
      [id],
    );

    expect(row.rows[0]).toMatchObject({
      direction: 'inbound',
      company_id: company.id,
      contact_id: contactId,
      status: 'delivered',
      requires_approval: false,
      sent_at: null,
    });
  });

  it('ignores a message from someone who is not a contact', async () => {
    // The mailbox owner's dentist is not a client.
    const id = await ingest({ from: 'appointments@dentist.example', to: ['us@velozity.example'] });
    expect(id).toBeNull();
  });

  it('matches on a recipient when we were the sender', async () => {
    // Our own outbound reply, seen from inside the synced mailbox: the client is
    // in `to`, not `from`.
    const id = await ingest({
      from: 'us@velozity.example',
      to: ['priya@clientco.example'],
      subject: 'Re: the proposal',
    });
    expect(id).not.toBeNull();

    const row = await db.driver.query<{ contact_id: string }>(
      `select contact_id from email_messages where id = $1`, [id],
    );
    expect(row.rows[0]?.contact_id).toBe(contactId);
  });

  it('stores the same message only once, however often a sync overlaps', async () => {
    const rfc822 = `<duplicate-${randomUUID()}@mail.example>`;

    const first = await ingest({ rfc822 });
    const second = await ingest({ rfc822 });
    const third = await ingest({ rfc822 });

    expect(first).not.toBeNull();
    // Not an error — overlapping reads are how a sync avoids losing messages at
    // the page boundary.
    expect(second).toBeNull();
    expect(third).toBeNull();

    const rows = await db.driver.query(
      `select id from email_messages where rfc822_message_id = $1`, [rfc822],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('matches an address regardless of case', async () => {
    const id = await ingest({
      from: 'PRIYA@ClientCo.Example',
      rfc822: `<case-${randomUUID()}@mail.example>`,
    });
    expect(id).not.toBeNull();
  });

  it('puts the message on the client timeline, not marked internal', async () => {
    const id = await ingest({ rfc822: `<timeline-${randomUUID()}@mail.example>` });

    const activity = await db.driver.query<{ is_internal: boolean; actor_type: string; company_id: string }>(
      `select is_internal, actor_type, company_id from activities
        where entity_type = 'email' and entity_id = $1`,
      [id],
    );
    // A message from the client is not an internal note; the client may see it
    // on their own portal timeline.
    expect(activity.rows[0]).toMatchObject({
      is_internal: false,
      actor_type: 'provider',
      company_id: company.id,
    });
  });

  it('never marks an inbound message as requiring approval or as sent', async () => {
    // The database refuses the shape outright, so no code path can create an
    // inbound message that looks like something waiting to be sent.
    await expect(
      db.driver.query(
        `insert into email_messages (org_id, direction, provider, from_email, to_emails,
                                     subject, body_html, status, requires_approval, received_at)
         values ($1,'inbound','gmail','x@y.test', array['a@b.test']::citext[],
                 'S','', 'delivered', true, now())`,
        [org.id],
      ),
    ).rejects.toThrow();
  });

  it('refuses an inbound message that claims to have been sent', async () => {
    await expect(
      db.driver.query(
        `insert into email_messages (org_id, direction, provider, from_email, to_emails,
                                     subject, body_html, status, received_at, sent_at)
         values ($1,'inbound','gmail','x@y.test', array['a@b.test']::citext[],
                 'S','', 'delivered', now(), now())`,
        [org.id],
      ),
    ).rejects.toThrow();
  });

  it('does not let the ingest function be called by an ordinary user', async () => {
    // It is SECURITY DEFINER and writes across companies; only the worker's
    // service role may call it.
    const { withTenant } = await import('@/lib/db');
    await expect(
      withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
        tx.one(
          `select app.ingest_inbound_email($1,$2,'gmail','<x@y>',null,null,'a@b.test',null,
                  array['c@d.test']::text[],'S','B','s',now())`,
          [org.id, connectionId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('keeps threading information so a conversation stays together', async () => {
    const rfc822 = `<threaded-${randomUUID()}@mail.example>`;
    const id = await ingest({
      rfc822,
      thread: 'conversation-42',
      inReplyTo: '<earlier@mail.example>',
    });

    const row = await db.driver.query<{ thread_key: string; in_reply_to: string }>(
      `select thread_key, in_reply_to from email_messages where id = $1`, [id],
    );
    expect(row.rows[0]).toMatchObject({
      thread_key: 'conversation-42',
      in_reply_to: '<earlier@mail.example>',
    });
  });
});
