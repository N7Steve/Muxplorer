import {
  BadRequestException,
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
export function problem(message: string): never {
  throw new BadRequestException(message);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido';
}
@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const code = (error as NodeJS.ErrnoException)?.code;
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : code === 'ENOENT'
          ? 404
          : code === 'EEXIST'
            ? 409
            : code === 'EACCES' || code === 'EPERM'
              ? 403
              : 500;
    const message =
      code === 'ENOSPC' ? 'No hay espacio disponible en el destino.' : errorText(error);
    response.status(status).json({ message });
  }
}
