import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  api,
  prisma,
  seedReference,
  getToken,
  authHeader,
  TEST_ADMIN_EMAIL,
} from './helpers/api.js';

/**
 * There is no login suite any more.
 *
 * Signing in happens against Supabase Auth, not this API — so the tests that
 * used to cover wrong passwords and unknown emails now cover somebody else's
 * code. What is still ours, and still worth pinning, is what this backend does
 * with the token it is handed.
 */

beforeAll(async () => {
  await seedReference();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('who am I', () => {
  it('accepts a genuine Supabase token', async () => {
    const token = await getToken();
    const res = await api.get('/api/auth/me').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_ADMIN_EMAIL);
    expect(res.body.user.role).toBe('admin');
  });

  it('never leaks a credential', async () => {
    const res = await api.get('/api/auth/me').set(authHeader(await getToken()));
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('rejects a request with no token', async () => {
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token that is not a JWT', async () => {
    const res = await api.get('/api/auth/me').set({ Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
  });

  it('rejects a forged token rather than reporting an outage', async () => {
    // Signed with a key Supabase never published. This must be 401 — an earlier
    // version classified it as 503, which reads as "Supabase is down" and sends
    // you debugging the wrong system entirely.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.' +
      'not-a-real-signature';
    const res = await api.get('/api/auth/me').set({ Authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
  });
});

describe('the removed sign-in routes', () => {
  it('POST /api/auth/login no longer exists', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: 'anything' });
    expect(res.status).toBe(404);
  });

  it('the password-free driver bypass is gone', async () => {
    const token = await getToken();
    // Authenticated, so a 404 here means the route is genuinely absent rather
    // than merely guarded.
    expect((await api.get('/api/drivers/roster').set(authHeader(token))).status).toBe(404);
    expect(
      (await api.post('/api/drivers/session').set(authHeader(token)).send({ driverId: 'x' })).status,
    ).toBe(404);
  });
});
