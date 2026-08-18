import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api,
  authHeader,
  cleanChat,
  ensureConsoleUser,
  getDriverToken,
  prisma,
  seedReference,
  TEST_DOMAIN,
  type Reference,
} from './helpers/api.js';
import { resetSendRateLimits } from '../src/modules/chat/chat.rateLimit.js';

/*
 * Chat is the one feature where an operator is NOT allowed to see everything.
 * Most of what is asserted below is refusal.
 */

interface ConsoleUser {
  id: string;
  email: string;
  token: string;
}

let ref: Reference;
let alice: ConsoleUser;
let bob: ConsoleUser;
let carol: ConsoleUser;
let driverToken: string;

beforeAll(async () => {
  ref = await seedReference();
  alice = await ensureConsoleUser({ email: `chat-alice@${TEST_DOMAIN}`, name: 'Chat Alice' });
  bob = await ensureConsoleUser({ email: `chat-bob@${TEST_DOMAIN}`, name: 'Chat Bob' });
  // Carol belongs to nothing — she is how we prove the ownership guard.
  carol = await ensureConsoleUser({ email: `chat-carol@${TEST_DOMAIN}`, name: 'Chat Carol' });
  driverToken = await getDriverToken(ref.driverId);
});

beforeEach(async () => {
  await cleanChat();
  resetSendRateLimits();
});

const asAlice = () => authHeader(alice.token);
const asBob = () => authHeader(bob.token);
const asCarol = () => authHeader(carol.token);
const asDriver = () => authHeader(driverToken);

async function directWithBob(): Promise<string> {
  const res = await api
    .post('/api/chat/conversations/direct')
    .set(asAlice())
    .send({ userId: bob.id });
  return res.body.id as string;
}

async function spaceWithBob(name = 'Dispatch floor'): Promise<string> {
  const res = await api
    .post('/api/chat/conversations/spaces')
    .set(asAlice())
    .send({ name, userIds: [bob.id] });
  return res.body.id as string;
}

function send(conversationId: string, header: { Authorization: string }, body: string) {
  return api
    .post(`/api/chat/conversations/${conversationId}/messages`)
    .set(header)
    .send({ body, clientMessageId: crypto.randomUUID() });
}

/* ------------------------------------------------------------------ */

describe('drivers are excluded from chat entirely', () => {
  it('refuses a driver token on every chat route', async () => {
    const routes = [
      api.get('/api/chat/directory'),
      api.get('/api/chat/conversations'),
      api.post('/api/chat/conversations/direct').send({ userId: alice.id }),
      api.post('/api/chat/conversations/spaces').send({ name: 'x', userIds: [] }),
    ];

    for (const route of routes) {
      const res = await route.set(asDriver());
      expect(res.status).toBe(403);
    }
  });

  it('never lists a driver in the directory', async () => {
    const res = await api.get('/api/chat/directory').set(asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.every((u: { role: string }) => u.role !== 'driver')).toBe(true);
  });

  it('refuses to open a direct message with a driver', async () => {
    const driverUser = await prisma.user.findFirst({
      where: { driverId: ref.driverId },
      select: { id: true },
    });

    const res = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: driverUser?.id });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/chat/directory', () => {
  it('excludes the caller', async () => {
    const res = await api.get('/api/chat/directory').set(asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.some((u: { id: string }) => u.id === alice.id)).toBe(false);
    expect(res.body.data.some((u: { id: string }) => u.id === bob.id)).toBe(true);
  });

  it('rejects an unknown query parameter', async () => {
    const res = await api.get('/api/chat/directory?nope=1').set(asAlice());
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chat/conversations/direct', () => {
  it('creates a two-person conversation', async () => {
    const res = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: bob.id });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('DIRECT');
    expect(res.body.memberCount).toBe(2);
    // A DM has no stored name — it is labelled with the other person.
    expect(res.body.name).toBe('Chat Bob');
    expect(res.body.counterpart.id).toBe(bob.id);
  });

  it('is idempotent — the second call returns the same conversation with 200', async () => {
    const first = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: bob.id });
    const second = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: bob.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('returns the same conversation whichever end opens it', async () => {
    const fromAlice = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: bob.id });
    const fromBob = await api
      .post('/api/chat/conversations/direct')
      .set(asBob())
      .send({ userId: alice.id });

    expect(fromBob.body.id).toBe(fromAlice.body.id);
  });

  it('creates exactly one conversation when both people press it at once', async () => {
    // The unique index on directKey is the real serializer; the pre-read is
    // only an optimisation. One of these must lose with P2002 and re-read.
    await Promise.all([
      api.post('/api/chat/conversations/direct').set(asAlice()).send({ userId: bob.id }),
      api.post('/api/chat/conversations/direct').set(asBob()).send({ userId: alice.id }),
    ]);

    expect(await prisma.chatConversation.count({ where: { type: 'DIRECT' } })).toBe(1);
  });

  it('refuses a direct message with yourself', async () => {
    const res = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: alice.id });

    expect(res.status).toBe(400);
  });

  it('gives the same error for an unknown user as for an ineligible one', async () => {
    const res = await api
      .post('/api/chat/conversations/direct')
      .set(asAlice())
      .send({ userId: 'does-not-exist' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat/conversations/spaces', () => {
  it('adds the creator as OWNER alongside the invited members', async () => {
    const res = await api
      .post('/api/chat/conversations/spaces')
      .set(asAlice())
      .send({ name: 'Dispatch floor', userIds: [bob.id] });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('SPACE');
    expect(res.body.memberCount).toBe(2);

    const owner = res.body.members.find((m: { userId: string }) => m.userId === alice.id);
    expect(owner.role).toBe('OWNER');
  });

  it('refuses to seed a space with a driver', async () => {
    const driverUser = await prisma.user.findFirst({
      where: { driverId: ref.driverId },
      select: { id: true },
    });

    const res = await api
      .post('/api/chat/conversations/spaces')
      .set(asAlice())
      .send({ name: 'Nope', userIds: [driverUser?.id] });

    expect(res.status).toBe(404);
    expect(await prisma.chatConversation.count()).toBe(0);
  });
});

describe('ownership', () => {
  it('returns 403 to a non-member, not 404', async () => {
    const id = await directWithBob();

    const res = await api.get(`/api/chat/conversations/${id}`).set(asCarol());
    expect(res.status).toBe(403);
  });

  it('returns 403 for a conversation that does not exist, so ids cannot be probed', async () => {
    const real = await api.get('/api/chat/conversations/totally-made-up').set(asCarol());
    expect(real.status).toBe(403);
  });

  it('guards the send path too', async () => {
    const id = await directWithBob();

    const res = await send(id, asCarol(), 'let me in');
    expect(res.status).toBe(403);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('guards reading history', async () => {
    const id = await directWithBob();

    const res = await api.get(`/api/chat/conversations/${id}/messages`).set(asCarol());
    expect(res.status).toBe(403);
  });
});

describe('messages', () => {
  it('sends and reads back', async () => {
    const id = await directWithBob();

    const sent = await send(id, asAlice(), 'morning');
    expect(sent.status).toBe(201);
    expect(sent.body.body).toBe('morning');
    expect(sent.body.senderId).toBe(alice.id);

    const list = await api.get(`/api/chat/conversations/${id}/messages`).set(asBob());
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('treats a repeated clientMessageId as the same message', async () => {
    const id = await directWithBob();
    const clientMessageId = crypto.randomUUID();

    const first = await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: 'sent once', clientMessageId });
    const retry = await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: 'sent once', clientMessageId });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(await prisma.chatMessage.count({ where: { conversationId: id } })).toBe(1);
  });

  it('rejects an empty body', async () => {
    const id = await directWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: '   ', clientMessageId: crypto.randomUUID() });

    expect(res.status).toBe(400);
  });

  it('returns newest first and pages backwards with the cursor', async () => {
    const id = await directWithBob();
    for (const word of ['one', 'two', 'three', 'four', 'five']) {
      await send(id, asAlice(), word);
    }

    const first = await api
      .get(`/api/chat/conversations/${id}/messages?limit=2`)
      .set(asAlice());

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].body).toBe('five');
    expect(first.body.meta.hasMore).toBe(true);

    const second = await api
      .get(`/api/chat/conversations/${id}/messages?limit=2&before=${first.body.meta.nextCursor}`)
      .set(asAlice());

    expect(second.body.data.map((m: { body: string }) => m.body)).toEqual(['three', 'two']);
  });

  it('does not lose or repeat a message when two share a millisecond', async () => {
    const id = await directWithBob();
    // createdAt is timestamp(3), so a tie is entirely possible. The id
    // tiebreak in the ORDER BY is what stops the cursor skipping a row.
    const sameInstant = new Date();
    await prisma.chatMessage.createMany({
      data: ['aaa', 'bbb', 'ccc'].map((suffix) => ({
        id: `tie-${suffix}`,
        conversationId: id,
        senderId: alice.id,
        body: suffix,
        createdAt: sameInstant,
      })),
    });

    const firstPage = await api
      .get(`/api/chat/conversations/${id}/messages?limit=2`)
      .set(asAlice());
    const secondPage = await api
      .get(
        `/api/chat/conversations/${id}/messages?limit=2&before=${firstPage.body.meta.nextCursor}`,
      )
      .set(asAlice());

    const seen = [...firstPage.body.data, ...secondPage.body.data].map(
      (m: { id: string }) => m.id,
    );
    expect(new Set(seen).size).toBe(3);
  });

  it('rejects a malformed cursor rather than passing it to the database', async () => {
    const id = await directWithBob();

    const res = await api
      .get(`/api/chat/conversations/${id}/messages?before=not-a-cursor`)
      .set(asAlice());

    expect(res.status).toBe(400);
  });

  it('rejects before and after together', async () => {
    const id = await directWithBob();

    const res = await api
      .get(`/api/chat/conversations/${id}/messages?before=a&after=b`)
      .set(asAlice());

    expect(res.status).toBe(400);
  });

  it('fetches everything after a cursor, for reconnect reconciliation', async () => {
    const id = await directWithBob();
    const first = await send(id, asAlice(), 'before the drop');
    await send(id, asAlice(), 'missed one');
    await send(id, asAlice(), 'missed two');

    const cursor = Buffer.from(
      `${new Date(first.body.createdAt).toISOString()}|${first.body.id}`,
      'utf8',
    ).toString('base64url');

    const res = await api
      .get(`/api/chat/conversations/${id}/messages?after=${cursor}`)
      .set(asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { body: string }) => m.body).sort()).toEqual([
      'missed one',
      'missed two',
    ]);
  });
});

describe('members', () => {
  it('adds someone to a space', async () => {
    const id = await spaceWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/members`)
      .set(asAlice())
      .send({ userIds: [carol.id] });

    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBe(3);
  });

  it('treats re-adding an existing member as a no-op', async () => {
    const id = await spaceWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/members`)
      .set(asAlice())
      .send({ userIds: [bob.id] });

    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBe(2);
  });

  it('refuses to add anyone to a direct message', async () => {
    const id = await directWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/members`)
      .set(asAlice())
      .send({ userIds: [carol.id] });

    expect(res.status).toBe(409);
    expect(await prisma.chatMember.count({ where: { conversationId: id } })).toBe(2);
  });

  it('removes a member, who then loses access', async () => {
    const id = await spaceWithBob();

    const removed = await api
      .delete(`/api/chat/conversations/${id}/members/${bob.id}`)
      .set(asAlice());
    expect(removed.status).toBe(200);

    const after = await api.get(`/api/chat/conversations/${id}`).set(asBob());
    expect(after.status).toBe(403);
  });

  it('lets someone leave a space themselves', async () => {
    const id = await spaceWithBob();

    const res = await api.post(`/api/chat/conversations/${id}/leave`).set(asBob());
    expect(res.status).toBe(200);

    const after = await api.get(`/api/chat/conversations/${id}`).set(asBob());
    expect(after.status).toBe(403);
  });

  it('refuses to let anyone leave a direct message', async () => {
    const id = await directWithBob();

    const res = await api.post(`/api/chat/conversations/${id}/leave`).set(asBob());
    expect(res.status).toBe(409);
  });
});

describe('GET /api/chat/conversations', () => {
  it('lists only my conversations, with a preview and unread count', async () => {
    const id = await directWithBob();
    await send(id, asAlice(), 'unread by bob');

    const forBob = await api.get('/api/chat/conversations').set(asBob());
    expect(forBob.status).toBe(200);
    expect(forBob.body.data).toHaveLength(1);
    expect(forBob.body.data[0].unreadCount).toBe(1);
    expect(forBob.body.data[0].lastMessage.body).toBe('unread by bob');
    expect(forBob.body.meta.totalUnread).toBe(1);

    const forCarol = await api.get('/api/chat/conversations').set(asCarol());
    expect(forCarol.body.data).toHaveLength(0);
  });

  it('does not count my own messages as unread', async () => {
    const id = await directWithBob();
    await send(id, asAlice(), 'my own words');

    const res = await api.get('/api/chat/conversations').set(asAlice());
    expect(res.body.data[0].unreadCount).toBe(0);
  });

  it('clears the unread count once read', async () => {
    const id = await directWithBob();
    const sent = await send(id, asAlice(), 'please read me');

    const read = await api
      .post(`/api/chat/conversations/${id}/read`)
      .set(asBob())
      .send({ lastMessageId: sent.body.id });
    expect(read.status).toBe(200);

    const res = await api.get('/api/chat/conversations').set(asBob());
    expect(res.body.data[0].unreadCount).toBe(0);
  });

  it('never moves the read marker backwards', async () => {
    const id = await directWithBob();
    const older = await send(id, asAlice(), 'older');
    const newer = await send(id, asAlice(), 'newer');

    await api
      .post(`/api/chat/conversations/${id}/read`)
      .set(asBob())
      .send({ lastMessageId: newer.body.id });
    // An out-of-order request from a slow tab must not un-read anything.
    await api
      .post(`/api/chat/conversations/${id}/read`)
      .set(asBob())
      .send({ lastMessageId: older.body.id });

    const res = await api.get('/api/chat/conversations').set(asBob());
    expect(res.body.data[0].unreadCount).toBe(0);
  });

  it('refuses a read marker pointing at another conversation', async () => {
    const mine = await directWithBob();
    const other = await spaceWithBob('Somewhere else');
    const strayMessage = await send(other, asAlice(), 'not in the DM');

    const res = await api
      .post(`/api/chat/conversations/${mine}/read`)
      .set(asBob())
      .send({ lastMessageId: strayMessage.body.id });

    expect(res.status).toBe(404);
  });
});
