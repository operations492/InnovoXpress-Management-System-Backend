import express from 'express';
import cors from 'cors';
import { corsOrigins, env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import referenceRoutes from './modules/reference/reference.routes.js';
import consignmentRoutes from './modules/consignments/consignments.routes.js';
import driverRoutes from './modules/drivers/drivers.routes.js';
import userRoutes from './modules/users/users.routes.js';
import chatRoutes from './modules/chat/chat.routes.js';
import routePlanRoutes from './modules/routes/routes.routes.js';
import mapRoutes from './modules/map/map.routes.js';

const app = express();

app.use(
  cors({
    // Allowlist rather than wide-open: the API is authenticated and will soon
    // accept file uploads.
    origin: env.NODE_ENV === 'test' ? true : corsOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get(
  '/health',
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  }),
);

app.use('/api/auth', authRoutes);
app.use('/api/reference', referenceRoutes);
app.use('/api/consignments', consignmentRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/routes', routePlanRoutes);

// keep last
app.use(notFound);
app.use(errorHandler);

export default app;
