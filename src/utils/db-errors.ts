// src/utils/db-errors.ts

/**
 * Detects a SQLite/libSQL UNIQUE constraint violation for a specific
 * column. SQLite's own error text — "UNIQUE constraint failed:
 * <table>.<column>" — is consistent across drivers (libSQL HTTP client,
 * embedded replica, better-sqlite3 in tests), so matching on the message
 * is the most portable way to distinguish "username taken" from
 * "email taken" from any other error without depending on driver-specific
 * error shapes.
 */
export function isUniqueConstraintError(
    err: unknown,
    columnName: string
): boolean {
    const message: unknown =
        (err as any)?.message ?? (err as any)?.cause?.message ?? "";
    if (typeof message !== "string") return false;

    return (
        /unique constraint failed/i.test(message) &&
        message.toLowerCase().includes(columnName.toLowerCase())
    );
}