import { describe, it, expect, beforeAll } from 'vitest';
import { ensureConsoleUser, prisma, seedReference, TEST_DOMAIN } from './helpers/api.js';

/*
 * This suite protects the project's security doctrine rather than any feature.
 *
 * The whole chat design rests on two claims:
 *   1. The browser can read NOTHING from the chat tables directly.
 *   2. A signed-in user may join their own Realtime inbox topic and no other.
 *
 * Both are enforced in Postgres, so both are asserted in Postgres — as the
 * `authenticated` role, with a crafted JWT claim set, exactly as Supabase
 * would present a real user.
 */

interface ConsoleUser {
  id: string;
  email: string;
  token: string;
}

let alice: ConsoleUser;
let bob: ConsoleUser;

beforeAll(async () => {
  await seedReference();
  alice = await ensureConsoleUser({ email: `rls-alice@${TEST_DOMAIN}`, name: 'RLS Alice' });
  bob = await ensureConsoleUser({ email: `rls-bob@${TEST_DOMAIN}`, name: 'RLS Bob' });
});

/**
 * Runs `fn` as the `authenticated` Postgres role with `auth.uid()` resolving
 * to `userId` — the same context Supabase establishes for a signed-in caller.
 *
 * Claims are set BEFORE the role switch, because afterwards we no longer have
 * the privileges to set them.
 */
async function asAuthenticated<T>(
  userId: string,
  fn: (tx: Omit<typeof prisma, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `select set_config('request.jwt.claims', $1, true)`,
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    );
    await tx.$executeRawUnsafe(`set local role authenticated`);
    return fn(tx as never);
  });
}

/* ------------------------------------------------------------------ */

describe('the chat tables are invisible to the browser', () => {
  it.each(['chat_conversations', 'chat_members', 'chat_messages'])(
    'denies authenticated any SELECT on %s',
    async (table) => {
      await expect(
        asAuthenticated(alice.id, (tx) =>
          tx.$queryRawUnsafe(`select count(*) from public.${table}`),
        ),
      ).rejects.toThrow(/permission denied/i);
    },
  );

  it('denies authenticated any INSERT into chat_messages', async () => {
    // Express is the only writer. If this ever passes, a browser can forge a
    // message from anyone.
    await expect(
      asAuthenticated(alice.id, (tx) =>
        tx.$executeRawUnsafe(
          `insert into public.chat_messages (id, "conversationId", "senderId", body)
           values ('forged', 'x', 'y', 'forged')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('confirms the tables carry RLS with no policies, like the other nine', async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; policies: bigint }[]
    >(
      `select c.relname,
              c.relrowsecurity,
              (select count(*) from pg_policies p
                where p.schemaname = 'public' and p.tablename = c.relname) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname in ('chat_conversations', 'chat_members', 'chat_messages')
        order by c.relname`,
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(Number(row.policies)).toBe(0);
    }
  });
});

describe('Realtime channel authorization', () => {
  /// Evaluates the exact predicate of the "chat inbox read own" policy.
  function mayJoin(userId: string, topic: string): Promise<boolean> {
    return asAuthenticated(userId, async (tx) => {
      await tx.$executeRawUnsafe(`select set_config('realtime.topic', $1, true)`, topic);
      const [row] = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(
        `select (lower(realtime.topic()) = 'chat:' || (select auth.uid())::text || ':inbox')
                  as allowed`,
      );
      return row.allowed;
    });
  }

  it('lets a user join their own inbox', async () => {
    expect(await mayJoin(alice.id, `chat:${alice.id}:inbox`)).toBe(true);
  });

  it("refuses another user's inbox", async () => {
    // The one that matters. If this ever returns true, every private message
    // in the company is readable by anyone holding the publishable key.
    expect(await mayJoin(alice.id, `chat:${bob.id}:inbox`)).toBe(false);
  });

  it('is not fooled by casing', async () => {
    expect(await mayJoin(alice.id, `CHAT:${alice.id.toUpperCase()}:INBOX`)).toBe(true);
    expect(await mayJoin(alice.id, `CHAT:${bob.id.toUpperCase()}:INBOX`)).toBe(false);
  });

  it('refuses a topic that merely contains the id', async () => {
    expect(await mayJoin(alice.id, `chat:${alice.id}:inbox:extra`)).toBe(false);
    expect(await mayJoin(alice.id, `chat:${alice.id}`)).toBe(false);
  });

  it('reads inboxes through a SELECT-only policy', async () => {
    const rows = await prisma.$queryRawUnsafe<{ policyname: string; cmd: string }[]>(
      `select policyname, cmd from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and policyname = 'chat inbox read own'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].cmd).toBe('SELECT');
  });

  it('lets nothing on realtime.messages be written by a client', async () => {
    /*
     * The invariant that actually matters, and the reason this is not a policy
     * count: no policy anywhere on realtime.messages may permit INSERT. That is
     * what stops a browser broadcasting a forged event onto ANY topic — its own
     * inbox, the dispatch feed, or whatever is added next.
     *
     * Stated this way it survives new features. The earlier version asserted
     * "exactly one policy exists", and the dispatch map legitimately adding a
     * second broke it while the security property was never in question.
     */
    const writable = await prisma.$queryRawUnsafe<{ policyname: string; cmd: string }[]>(
      `select policyname, cmd from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and cmd <> 'SELECT'`,
    );

    expect(writable).toEqual([]);
  });
});
