import { buildApp } from './app.js';
import { config } from './config/index.js';
import { buildStartupFailureMessage } from './config/startup-diagnostics.js';

async function start(): Promise<void> {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`GateKit API server running on port ${config.port}`);
  } catch (err) {
    const message = buildStartupFailureMessage(err, {
      service: 'API',
      databaseUrl: config.databaseUrl,
      temporalAddress: config.temporalAddress,
    });
    if (app) {
      app.log.error(message);
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}

start();
