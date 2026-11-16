'use strict';

class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function errorMiddleware(error, _req, res, _next) {
  const known = error instanceof AppError;
  const invalid = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
  res.status(known ? error.status : invalid ? 400 : 500).json({ error: {
    code: known ? error.code : invalid ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
    message: known ? error.message : invalid ? '请求参数无效' : '服务暂时不可用，请稍后重试'
  } });
}

module.exports = { AppError, errorMiddleware };
