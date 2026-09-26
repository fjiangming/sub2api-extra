'use strict';

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status || 500;
    this.details = options.details || null;
    this.retryable = Boolean(options.retryable);
  }
}

function publicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {})
        }
      }
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }
  };
}

module.exports = { AppError, publicError };
