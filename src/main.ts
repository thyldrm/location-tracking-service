import { Logger } from '@nestjs/common';
import { ApiModule } from './api.module.js';
import { startHttpApp } from './bootstrap/start-http-app.js';
import { loadEnv } from './core/config/load-env.js';

try {
  const env = loadEnv();
  await startHttpApp(ApiModule.forRoot(env), 'api', env);
} catch (error) {
  new Logger('Bootstrap').error(
    'API role failed to start',
    error instanceof Error ? error.stack : error,
  );
  process.exit(1);
}
