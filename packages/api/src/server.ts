import { buildApp } from './app.js';
import { config } from './config/index.js';
import { buildStartupFailureMessage } from './config/startup-diagnostics.js';

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`GateKit API server running on port ${config.port}`);
  } catch (err) {
    app.log.error(
      buildStartupFailureMessage(err, {
        service: 'API',
        databaseUrl: config.databaseUrl,
        temporalAddress: config.temporalAddress,
      }),
    );
    process.exit(1);
  }
}

start();
