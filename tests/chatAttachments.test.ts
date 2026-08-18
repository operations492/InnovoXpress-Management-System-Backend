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
 * File sharing, against real Supabase Storage.
 *
 * The point of these tests is the security model rather than the happy path:
 * any file type is accepted, but only a verified image may ever be served
 * inline, and a message id alone must never be enough to reach a file.
 */

interface ConsoleUser {
  id: string;
  email: string;
  token: string;
}

let alice: ConsoleUser;
let bob: ConsoleUser;
let carol: ConsoleUser;

const uuid = () => crypto.randomUUID();

/** Eight bytes is all sniffImage reads — enough to be a genuine PNG header. */
const pngBuffer = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

const pdfBuffer = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);

beforeAll(async () => {
  await seedReference();
  alice = await ensureConsoleUser({ email: `att-alice@${TEST_DOMAIN}`, name: 'Att Alice' });
  bob = await ensureConsoleUser({ email: `att-bob@${TEST_DOMAIN}`, name: 'Att Bob' });
  carol = await ensureConsoleUser({ email: `att-carol@${TEST_DOMAIN}`, name: 'Att Carol' });
});

beforeEach(async () => {
  await cleanChat();
  resetSendRateLimits();
});

const asAlice = () => authHeader(alice.token);
const asBob = () => authHeader(bob.token);
const asCarol = () => authHeader(carol.token);

async function directWithBob(): Promise<string> {
  const res = await api
    .post('/api/chat/conversations/direct')
    .set(asAlice())
    .send({ userId: bob.id });
  return res.body.id as string;
}

function upload(conversationId: string, file: Buffer, filename: string, contentType: string) {
  return api
    .post(`/api/chat/conversations/${conversationId}/attachments`)
    .set(asAlice())
    .field('clientMessageId', uuid())
    .attach('file', file, { filename, contentType });
}

/* ------------------------------------------------------------------ */

describe('uploading', () => {
  it('accepts an image and marks it previewable', async () => {
    const id = await directWithBob();

    const res = await upload(id, pngBuffer(), 'photo.png', 'image/png');

    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({
      name: 'photo.png',
      mime: 'image/png',
      isImage: true,
    });
    expect(res.body.attachment.bytes).toBeGreaterThan(0);
  });

  it('accepts a non-image and refuses to call it previewable', async () => {
    const id = await directWithBob();

    const res = await upload(id, pdfBuffer(), 'invoice.pdf', 'application/pdf');

    expect(res.status).toBe(201);
    expect(res.body.attachment.isImage).toBe(false);
    // Content-Type is client-supplied, so it is never echoed back as truth.
    expect(res.body.attachment.mime).toBe('application/octet-stream');
  });

  it('is not fooled by a lie about the content type', async () => {
    const id = await directWithBob();

    // A PDF announcing itself as a PNG must not become previewable, or it
    // would be served inline from the storage origin.
    const res = await upload(id, pdfBuffer(), 'notreally.png', 'image/png');

    expect(res.status).toBe(201);
    expect(res.body.attachment.isImage).toBe(false);
  });

  it('allows a file with no caption', async () => {
    const id = await directWithBob();

    const res = await upload(id, pdfBuffer(), 'silent.pdf', 'application/pdf');

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('');
  });

  it('keeps a caption alongside the file', async () => {
    const id = await directWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asAlice())
      .field('clientMessageId', uuid())
      .field('body', 'signed copy attached')
      .attach('file', pdfBuffer(), { filename: 'contract.pdf' });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('signed copy attached');
    expect(res.body.attachment.name).toBe('contract.pdf');
  });

  it('rejects anything over the 5 MB cap', async () => {
    const id = await directWithBob();
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);

    const res = await upload(id, tooBig, 'huge.bin', 'application/octet-stream');

    // Multer aborts on its own size limit, which the error handler maps to
    // 413 — the file never reaches Storage or the database.
    expect(res.status).toBe(413);
    expect(await prisma.chatMessage.count({ where: { conversationId: id } })).toBe(0);
  });

  it('rejects a request with no file', async () => {
    const id = await directWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asAlice())
      .field('clientMessageId', uuid());

    expect(res.status).toBe(400);
  });

  it('refuses a non-member', async () => {
    const id = await directWithBob();

    const res = await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asCarol())
      .field('clientMessageId', uuid())
      .attach('file', pdfBuffer(), { filename: 'nope.pdf' });

    expect(res.status).toBe(403);
  });

  it('does not store a second message for a repeated clientMessageId', async () => {
    const id = await directWithBob();
    const clientMessageId = uuid();

    const first = await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asAlice())
      .field('clientMessageId', clientMessageId)
      .attach('file', pdfBuffer(), { filename: 'retry.pdf' });
    const retry = await api
      .post(`/api/chat/conversations/${id}/attachments`)
      .set(asAlice())
      .field('clientMessageId', clientMessageId)
      .attach('file', pdfBuffer(), { filename: 'retry.pdf' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(await prisma.chatMessage.count({ where: { conversationId: id } })).toBe(1);
  });
});

describe('downloading', () => {
  it('hands a member a signed download link', async () => {
    const id = await directWithBob();
    const sent = await upload(id, pdfBuffer(), 'report.pdf', 'application/pdf');

    const res = await api
      .get(`/api/chat/conversations/${id}/messages/${sent.body.id}/attachment`)
      .set(asBob());

    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toContain('/storage/v1/object/sign/chat-attachments/');
    expect(res.body.downloadUrl).toContain('token=');
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    expect(res.body.name).toBe('report.pdf');
  });

  it('the link actually resolves', async () => {
    const id = await directWithBob();
    const sent = await upload(id, pdfBuffer(), 'live.pdf', 'application/pdf');

    const links = await api
      .get(`/api/chat/conversations/${id}/messages/${sent.body.id}/attachment`)
      .set(asAlice());

    const fetched = await fetch(links.body.downloadUrl);
    expect(fetched.status).toBe(200);
    // The download disposition is what makes accepting any file type safe.
    expect(fetched.headers.get('content-disposition')).toContain('attachment');
  });

  it('offers a preview link for an image and none for anything else', async () => {
    const id = await directWithBob();
    const image = await upload(id, pngBuffer(), 'pic.png', 'image/png');
    const doc = await upload(id, pdfBuffer(), 'doc.pdf', 'application/pdf');

    const imageLinks = await api
      .get(`/api/chat/conversations/${id}/messages/${image.body.id}/attachment`)
      .set(asAlice());
    const docLinks = await api
      .get(`/api/chat/conversations/${id}/messages/${doc.body.id}/attachment`)
      .set(asAlice());

    expect(imageLinks.body.previewUrl).toBeTruthy();
    expect(docLinks.body.previewUrl).toBeNull();
  });

  it('refuses a non-member', async () => {
    const id = await directWithBob();
    const sent = await upload(id, pdfBuffer(), 'private.pdf', 'application/pdf');

    const res = await api
      .get(`/api/chat/conversations/${id}/messages/${sent.body.id}/attachment`)
      .set(asCarol());

    expect(res.status).toBe(403);
  });

  it('refuses a message id borrowed from another conversation', async () => {
    // Carol is a member of her own space, so the route guard lets her past —
    // only the conversation check on the message stops her here.
    const mine = await directWithBob();
    const sent = await upload(mine, pdfBuffer(), 'secret.pdf', 'application/pdf');

    const hers = await api
      .post('/api/chat/conversations/spaces')
      .set(asCarol())
      .send({ name: 'Carol space', userIds: [] });

    const res = await api
      .get(`/api/chat/conversations/${hers.body.id}/messages/${sent.body.id}/attachment`)
      .set(asCarol());

    expect(res.status).toBe(404);
  });

  it('404s for a message that carries no file', async () => {
    const id = await directWithBob();
    const text = await api
      .post(`/api/chat/conversations/${id}/messages`)
      .set(asAlice())
      .send({ body: 'just words', clientMessageId: uuid() });

    const res = await api
      .get(`/api/chat/conversations/${id}/messages/${text.body.id}/attachment`)
      .set(asAlice());

    expect(res.status).toBe(404);
  });
});

describe('a space shares files with every member', () => {
  it('lets a second member download what someone else uploaded', async () => {
    const space = await api
      .post('/api/chat/conversations/spaces')
      .set(asAlice())
      .send({ name: 'Docs', userIds: [bob.id] });

    const sent = await upload(space.body.id, pdfBuffer(), 'shared.pdf', 'application/pdf');

    const res = await api
      .get(`/api/chat/conversations/${space.body.id}/messages/${sent.body.id}/attachment`)
      .set(asBob());

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('shared.pdf');
  });

  it('stops someone who was removed from the space', async () => {
    const space = await api
      .post('/api/chat/conversations/spaces')
      .set(asAlice())
      .send({ name: 'Docs', userIds: [bob.id] });
    const sent = await upload(space.body.id, pdfBuffer(), 'shared.pdf', 'application/pdf');

    await api
      .delete(`/api/chat/conversations/${space.body.id}/members/${bob.id}`)
      .set(asAlice());

    const res = await api
      .get(`/api/chat/conversations/${space.body.id}/messages/${sent.body.id}/attachment`)
      .set(asBob());

    expect(res.status).toBe(403);
  });
});

describe('the message row', () => {
  it('never exposes the storage path', async () => {
    const id = await directWithBob();
    const sent = await upload(id, pdfBuffer(), 'hidden.pdf', 'application/pdf');

    const listed = await api
      .get(`/api/chat/conversations/${id}/messages`)
      .set(asAlice());

    const body = JSON.stringify(listed.body);
    expect(body).not.toContain('attachmentPath');
    // The uuid the object is keyed by must not appear anywhere in the payload.
    const stored = await prisma.chatMessage.findUnique({
      where: { id: sent.body.id },
      select: { attachmentPath: true },
    });
    expect(stored?.attachmentPath).toBeTruthy();
    expect(body).not.toContain(stored!.attachmentPath!.split('/')[1]);
  });
});
