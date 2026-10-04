'use strict';

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status || 500;
    this.details = options.details;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorResponse(error, requestId) {
  const status = Number(error?.status) || 500;
  const body = {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: status >= 500 ? '服务暂时不可用，请稍后重试' : String(error?.message || '请求失败'),
      requestId
    }
  };
  if (status < 500 && error?.details != null) body.error.details = error.details;
  return body;
}

module.exports = { AppError, asyncRoute, errorResponse };
