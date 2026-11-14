/** An error with an HTTP status; the server sends it as `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
