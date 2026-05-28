export class StorageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

export function toStorageError(error: unknown) {
  if (error instanceof StorageError) {
    return error;
  }

  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;

    if (code === "ENOENT") {
      return new StorageError("Requested item was not found.", 404);
    }
  }

  return new StorageError("Storage operation failed.", 500);
}
