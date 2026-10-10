'use strict';

class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function ensure(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}

module.exports = { AppError, ensure };
