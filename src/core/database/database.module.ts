import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDataSourceOptions, type DatabaseEnv } from './data-source-options.js';

@Module({})
export class DatabaseModule {
  static forRoot(env: DatabaseEnv): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [TypeOrmModule.forRoot(createDataSourceOptions(env))],
    };
  }
}
