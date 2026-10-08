import { startHttpApp } from './bootstrap/start-http-app.js';
import { loadEnv } from './core/config/load-env.js';
import { createBootstrapLogger } from './core/logging/bootstrap-logger.js';
import { WorkerModule } from './worker.module.js';

try {
  const env = loadEnv();
  await startHttpApp(WorkerModule.forRoot(env), 'worker', env);
} catch (error) {
  createBootstrapLogger('worker').fatal({ err: error }, 'Worker role failed to start');
  process.exit(1);
}
