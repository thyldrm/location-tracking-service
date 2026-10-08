import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConnectedGuard, DatabaseConnection } from './database-connection.js';
import { createDataSourceOptions, type DatabaseEnv } from './data-source-options.js';

@Module({})
export class DatabaseModule {
  static forRoot(env: DatabaseEnv): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      // Connected by DatabaseConnection, which does not block startup while PostgreSQL is unreachable.
      imports: [
        TypeOrmModule.forRoot({ ...createDataSourceOptions(env), manualInitialization: true }),
      ],
      providers: [DatabaseConnection, DatabaseConnectedGuard],
      exports: [DatabaseConnection, DatabaseConnectedGuard],
    };
  }
}
