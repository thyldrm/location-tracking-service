import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { RequestContext } from '../context/request-context.js';
import { PROBLEM_CONTENT_TYPE, resolveProblem } from './problem-details.js';

/**
 * The single place where an exception becomes an HTTP response. Every error, whether thrown on
 * purpose, by the framework or by a bug, is returned as an RFC 9457 problem document that carries the
 * request's correlation id. Internal details never leave the service; they go to the logs instead.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(ProblemDetailsFilter.name) private readonly logger: PinoLogger,
    private readonly requestContext: RequestContext,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const { problem, headers, expected } = resolveProblem(exception);
    const body = {
      ...problem,
      instance: request.url.split('?')[0],
      correlationId: this.requestContext.correlationId,
    };

    if (!expected) {
      this.logger.error({ err: exception, status: problem.status }, 'Request failed');
    } else {
      this.logger.debug({ status: problem.status, type: problem.type }, problem.detail);
    }

    void reply
      .status(problem.status)
      .headers({ ...headers, 'content-type': PROBLEM_CONTENT_TYPE })
      .send(body);
  }
}
