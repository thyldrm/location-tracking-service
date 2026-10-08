import { Module } from '@nestjs/common';
import { ApiDocs, DocsController } from './docs.controller.js';

@Module({
  controllers: [DocsController],
  providers: [ApiDocs],
})
export class DocsModule {}
