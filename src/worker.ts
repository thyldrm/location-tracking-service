import { Logger } from '@nestjs/common';
import { startHttpApp } from './bootstrap/start-http-app.js';
import { loadEnv } from './core/config/load-env.js';
import { WorkerModule } from './worker.module.js';

try {
  const env = loadEnv();
  await startHttpApp(WorkerModule.forRoot(env), 'worker', env);
} catch (error) {
  new Logger('Bootstrap').error(
    'Worker role failed to start',
    error instanceof Error ? error.stack : error,
  );
  process.exit(1);
}
