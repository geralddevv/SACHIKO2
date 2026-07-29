class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isoperational = true; // This indicates that the error is expected and can be handled.
        Error.captureStackTrace(this, this.constructor);
    }
}

export default AppError;