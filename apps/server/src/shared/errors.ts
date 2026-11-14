/** A referenced record (message, file, session, ...) doesn't exist or isn't the caller's. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}
