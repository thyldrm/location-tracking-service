import { Global, Module } from '@nestjs/common';
import { KafkaMessageProducer } from './kafka-message-producer.js';
import { MessageProducer } from './message-producer.js';

/** Kafka access for both process roles. Consumers are added by the worker role. */
@Global()
@Module({
  providers: [
    KafkaMessageProducer,
    // The abstraction resolves to the same (single) Kafka producer instance.
    { provide: MessageProducer, useExisting: KafkaMessageProducer },
  ],
  exports: [MessageProducer],
})
export class MessagingModule {}
