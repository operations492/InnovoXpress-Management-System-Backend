import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanChat,
  ensureConsoleUser,
  prisma,
  seedReference,
  TEST_DOMAIN,
} from './helpers/api.js';
import { resetSendRateLimits } from '../src/modules/chat/chat.rateLimit.js';

/*
 * The broadcast path, asserted against the real database.
 *
 * These are the tests that justify the fan-out design: recipients are chosen
 * per message, so a removal takes effect immediately rather than whenever the
 * removed person happens to reconnect.
 */

interface BroadcastRow {
  topic: string;
  event: string;
  private: boolean;
  extension: string;
  payload: Record<string, unknown>;
}

interface ConsoleUser {
  id: string;
  email: string;
  token: string;
}

let alice: ConsoleUser;
let bob: ConsoleUser;
let carol: ConsoleUser;

/**
 * Message fan-out only.
 *
 * The event filter matters: membership changes broadcast onto the same inbox
 * topics, so without it every test that creates a space would also count the
 * "you were added" events.
 */
function broadcasts(): Promise<BroadcastRow[]> {
  return prisma.$queryRawUnsafe<BroadcastRow[]>(
    `select topic, event, private, extension, payload
       from realtime.messages
      where topic like 'chat:%' and event = 'chat.message.created'
      order by topic`,
  );
}

function membershipBroadcasts(): Promise<BroadcastRow[]> {
  return prisma.$queryRawUnsafe<BroadcastRow[]>(
    `select topic, event, private, extension, payload
       from realtime.messages
      where topic like 'chat:%' and event = 'chat.membership.changed'
      order by inserted_at`,
  );
}

function inboxOf(user: ConsoleUser): string {
  return `chat:${user.id}:inbox`;
}

beforeAll(async () => {
  await seedReference();
  alice = await ensureConsoleUser({ email: `rt-alice@${TEST_DOMAIN}`, name: 'RT Alice' });
  bob = await ensureConsoleUser({ email: `rt-bob@${TEST_DOMAIN}`, name: 'RT Bob' });
  carol = await ensureConsoleUser({ email: `rt-carol@${TEST_DOMAIN}`, name: 'RT Carol' });

  /*
   * realtime.messages is partitioned by day, and only Supabase's Realtime
   * service can create the partitions — `postgres` gets "permission denied
   * for schema realtime". Worse, realtime.send() swallows the resulting
   * failure as a RAISE WARNING, so without this check every assertion below
   * fails with a mystifying "expected 2, got 0".
   *
   * If this throws: connect any Realtime client to the project once and the
   * tenant provisions several days of partitions immediately.
   */
  const [{ partitions }] = await prisma.$queryRawUnsafe<{ partitions: bigint }[]>(
    `select count(*) as partitions
       from pg_inherits i
       join pg_class p on p.oid = i.inhparent
       join pg_namespace n on n.oid = p.relnamespace
      where n.nspname = 'realtime' and p.relname = 'messages'`,
  );
  if (Number(partitions) === 0) {
    throw new Error(
      'realtime.messages has no partitions — broadcasts will be silently dropped. ' +
        'Connect a Realtime client to the project once so the tenant provisions them.',
    );
  }
});

beforeEach(async () => {
  await cleanChat();
  resetSendRateLimits();
});

const asAlice = () => authHeader(alice.token);

function send(conversationId: string, body: string) {
  return api
    .post(`/api/chat/conversations/${conversationId}/messages`)
    .set(asAlice())
    .send({ body, clientMessageId: crypto.randomUUID() });
}

async function spaceWith(members: ConsoleUser[]): Promise<string> {
  const res = await api
    .post('/api/chat/conversations/spaces')
    .set(asAlice())
    .send({ name: 'Broadcast test', userIds: members.map((m) => m.id) });
  return res.body.id as string;
}

/* ------------------------------------------------------------------ */

describe('fan-out', () => {
  it('writes one broadcast per member, on their own private topic', async () => {
    const id = await spaceWith([bob, carol]);
    await send(id, 'hello everyone');

    const rows = await broadcasts();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.topic).sort()).toEqual(
      [inboxOf(alice), inboxOf(bob), inboxOf(carol)].sort(),
    );

    for (const row of rows) {
      expect(row.event).toBe('chat.message.created');
      expect(row.private).toBe(true);
      expect(row.extension).toBe('broadcast');
    }
  });

  it('emits the same JSON the REST endpoint returns', async () => {
    // If these ever diverge, the client's sort and dedupe break in a way that
    // looks exactly like message loss. One parser, one shape.
    const id = await spaceWith([bob]);
    const sent = await send(id, 'parity check');

    const [row] = await broadcasts();
    expect(row.payload).toEqual({
      id: sent.body.id,
      conversationId: sent.body.conversationId,
      senderId: sent.body.senderId,
      type: sent.body.type,
      body: sent.body.body,
      clientMessageId: sent.body.clientMessageId,
      createdAt: sent.body.createdAt,
      // null for a plain text message, and the same object when a file is
      // attached — see the attachment case below.
      attachment: sent.body.attachment,
    });
  });

  it('broadcasts nothing when the transaction rolls back', async () => {
    const id = await spaceWith([bob]);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.chatMessage.create({
          data: {
            conversationId: id,
            senderId: alice.id,
            body: 'never committed',
            clientMessageId: crypto.randomUUID(),
          },
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await broadcasts()).toHaveLength(0);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('stops broadcasting to someone the moment they are removed', async () => {
    const id = await spaceWith([bob, carol]);

    await api.delete(`/api/chat/conversations/${id}/members/${bob.id}`).set(asAlice());
    await send(id, 'after bob left');

    const topics = (await broadcasts()).map((r) => r.topic);
    expect(topics).toContain(inboxOf(alice));
    expect(topics).toContain(inboxOf(carol));
    // The whole reason topics are per-user rather than per-conversation:
    // channel authorization is cached for the life of a connection, so a
    // per-conversation topic would keep delivering to Bob until he
    // disconnected.
    expect(topics).not.toContain(inboxOf(bob));
  });

  it('skips a member who has been demoted to driver', async () => {
    const id = await spaceWith([bob]);

    try {
      // A demotion leaves the membership row behind. REST is covered by
      // requireMinRole; the broadcast path is only covered by the join in
      // the trigger.
      await prisma.user.update({ where: { id: bob.id }, data: { role: 'driver' } });
      await send(id, 'bob should not hear this');

      const topics = (await broadcasts()).map((r) => r.topic);
      expect(topics).toEqual([inboxOf(alice)]);
    } finally {
      await prisma.user.update({ where: { id: bob.id }, data: { role: 'operator' } });
    }
  });

  it('tells someone they were added to a space, with no message sent', async () => {
    // Without this the newcomer's sidebar stays stale until they refresh —
    // adding a member writes a member row and nothing else.
    const id = await spaceWith([bob]);

    const events = await membershipBroadcasts();
    const added = events.filter((e) => e.payload.action === 'ADDED');

    expect(added.map((e) => e.topic).sort()).toEqual([inboxOf(alice), inboxOf(bob)].sort());
    expect(added.every((e) => e.private)).toBe(true);
    void id;
  });

  it('tells someone they were removed, and nobody else', async () => {
    const id = await spaceWith([bob, carol]);
    await api.delete(`/api/chat/conversations/${id}/members/${bob.id}`).set(asAlice());

    const removed = (await membershipBroadcasts()).filter(
      (e) => e.payload.action === 'REMOVED',
    );

    expect(removed).toHaveLength(1);
    expect(removed[0].topic).toBe(inboxOf(bob));
  });

  it('skips a deactivated member', async () => {
    const id = await spaceWith([bob]);

    try {
      await prisma.user.update({ where: { id: bob.id }, data: { active: false } });
      await send(id, 'bob is gone');

      const topics = (await broadcasts()).map((r) => r.topic);
      expect(topics).toEqual([inboxOf(alice)]);
    } finally {
      await prisma.user.update({ where: { id: bob.id }, data: { active: true } });
    }
  });

  it('carries attachment metadata but never the storage path', async () => {
    const id = await spaceWith([bob]);

    await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asAlice())
      .field('clientMessageId', crypto.randomUUID())
      .attach('file', Buffer.from('%PDF-1.7\nhello'), { filename: 'note.pdf' });

    const [row] = await broadcasts();
    expect(row.payload.attachment).toMatchObject({
      name: 'note.pdf',
      mime: 'application/octet-stream',
      isImage: false,
    });
    // The path is server-only; a client asks for a signed URL instead.
    expect(JSON.stringify(row.payload)).not.toContain('attachmentPath');
  });

  it('does not broadcast twice for an idempotent replay', async () => {
    const id = await spaceWith([bob]);
    const clientMessageId = crypto.randomUUID();

    await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: 'once only', clientMessageId });
    await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: 'once only', clientMessageId });

    // Two members, one message — the retry must not fan out again.
    expect(await broadcasts()).toHaveLength(2);
  });
});
