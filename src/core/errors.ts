export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SandboxError extends AppError {}
export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class TooLargeError extends AppError {}
export class InvalidContentError extends AppError {}

