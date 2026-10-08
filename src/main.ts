import { ApiModule } from './api.module.js';
import { startHttpApp } from './bootstrap/start-http-app.js';
import { loadEnv } from './core/config/load-env.js';
import { createBootstrapLogger } from './core/logging/bootstrap-logger.js';

try {
  const env = loadEnv();
  await startHttpApp(ApiModule.forRoot(env), 'api', env);
} catch (error) {
  createBootstrapLogger('api').fatal({ err: error }, 'API role failed to start');
  process.exit(1);
}
