'use strict';

class AppError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function errorMiddleware(error, _req, res, _next) {
  if (res.headersSent) return;
  const invalid = [400, 413].includes(error.status);
  const status = error instanceof AppError ? error.status : invalid ? error.status : 503;
  const code = error instanceof AppError ? error.code : invalid ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE';
  if (status >= 500) console.error(`[usage-leaderboard] ${code}`);
  res.status(status).json({ error: { code, message: error instanceof AppError
    ? error.message : invalid ? '请求内容无效或过长' : '暂时无法获取用量，请稍后重试' } });
}

module.exports = { AppError, errorMiddleware };
