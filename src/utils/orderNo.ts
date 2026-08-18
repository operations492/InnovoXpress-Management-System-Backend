import type { Prisma } from '@prisma/client';

/** YYYYMMDD in server-local time. */
export function dateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Allocate the next order number for a client, e.g. `DRZ-20260813-0001`.
 *
 * The sequence comes from a single atomic UPSERT rather than reading the current
 * maximum and adding one: under READ COMMITTED two concurrent creates would both
 * read the same max, both compute `-0001`, and one would die on the unique index.
 * A single INSERT .. ON CONFLICT DO UPDATE .. RETURNING takes a row lock and is
 * correct at any level of concurrency.
 *
 * Call this OUTSIDE the insert transaction. The counter row serializes every
 * create for one client on one day, so holding its lock for a whole transaction
 * makes concurrent creates queue behind each other. Run standalone, the lock is
 * released as soon as the statement commits.
 *
 * The cost is that an insert which then fails leaves a gap in the sequence.
 * Acceptable: these are identifiers, not a gapless financial series.
 */
export async function generateOrderNo(
  tx: Prisma.TransactionClient,
  params: { clientId: string; clientCode: string; now?: Date },
): Promise<string> {
  const dateKey = dateKeyOf(params.now ?? new Date());

  const rows = await tx.$queryRaw<Array<{ lastSeq: number }>>`
    INSERT INTO order_counters ("clientId", "dateKey", "lastSeq")
    VALUES (${params.clientId}, ${dateKey}, 1)
    ON CONFLICT ("clientId", "dateKey")
    DO UPDATE SET "lastSeq" = order_counters."lastSeq" + 1
    RETURNING "lastSeq"
  `;

  const seq = rows[0]?.lastSeq;
  if (seq == null) throw new Error('Failed to allocate an order number');

  return `${params.clientCode}-${dateKey}-${String(seq).padStart(4, '0')}`;
}
