class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status || 500;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
    this.cause = options.cause;
  }
}

function asAppError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, error?.message || 'Unexpected error', {
    status: 500,
    cause: error
  });
}

function errorResponse(error) {
  const appError = asAppError(error);
  return {
    error: {
      code: appError.code,
      message: appError.code === 'INTERNAL_ERROR' ? 'Internal server error' : redactText(appError.message),
      retryable: appError.retryable,
      details: redact(appError.details)
    }
  };
}

module.exports = {
  AppError,
  asAppError,
  errorResponse
};
const { redact, redactText } = require('./security/redaction');
