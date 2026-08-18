import app from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🚚 Innovo TMS API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
