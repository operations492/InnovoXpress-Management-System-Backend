import { z } from 'zod';
import { ConsignmentStatus } from '@prisma/client';
import { MAP_TABS } from '../constants/mapTabs.js';

export const listConsignmentsQuerySchema = z
  .object({
    status: z.enum(ConsignmentStatus).optional(),
    /** Client scoping — the primary lens for this system. */
    clientId: z.string().min(1).optional(),
    driverId: z.string().min(1).optional(),
    unassigned: z.enum(['true', 'false']).optional(),

    /** Dispatch map sidebar grouping — an enum over MAP_TABS so the two cannot drift. */
    tab: z.enum(MAP_TABS).optional(),

    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),

    /** Free text across order no, client ref, sender/receiver name and city. */
    q: z.string().trim().min(1).max(120).optional(),

    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),

    sort: z
      .enum(['createdAt', 'orderNo', 'status', 'readyBy', 'deliverBy'])
      .default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export type ListConsignmentsQuery = z.infer<typeof listConsignmentsQuerySchema>;
