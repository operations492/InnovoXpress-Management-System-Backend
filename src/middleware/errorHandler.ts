import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { z, ZodError } from 'zod';
import { AppError } from '../utils/httpError.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  // Multer throws its own error type, which would otherwise fall through to the
  // 500 branch and report an oversized upload as a server fault.
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large' },
      });
    }
    return res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: `Upload rejected: ${err.message}`,
        details: { field: err.field, code: err.code },
      },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
        details: z.flattenError(err).fieldErrors,
      },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return res
        .status(409)
        .json({ error: { code: 'CONFLICT', message: `Duplicate value for ${target}` } });
    }
    if (err.code === 'P2025') {
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Related record does not exist (foreign key)',
        },
      });
    }
    // Write conflict / deadlock — the caller can safely retry.
    if (err.code === 'P2034') {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'Write conflict, please retry',
        },
      });
    }
    // Transaction timed out or was closed.
    if (err.code === 'P2028') {
      return res.status(503).json({
        error: {
          code: 'TRANSACTION_TIMEOUT',
          message: 'The operation took too long, please retry',
        },
      });
    }
  }

  console.error('Unhandled error:', err);
  return res
    .status(500)
    .json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
