'use strict';

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status || 500;
    this.details = options.details;
    this.expose = options.expose !== false;
  }
}

function errorMiddleware(error, _req, res, _next) {
  const status = Number(error?.status) || 500;
  const expose = error instanceof AppError ? error.expose : status < 500;
  const payload = {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: expose ? error.message : '服务暂时不可用'
    }
  };
  if (expose && error?.details !== undefined) payload.error.details = error.details;
  if (status >= 500) console.error(error);
  res.status(status).json(payload);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { AppError, errorMiddleware, asyncRoute };
