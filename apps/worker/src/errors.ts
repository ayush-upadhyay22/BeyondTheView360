/**
 * An error that retrying cannot fix (bad image, wrong aspect ratio, missing upload).
 * Its message is shown to the user, so keep it friendly and actionable.
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}
