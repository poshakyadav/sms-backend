// src/modules/super/turso-dbs/utils.ts

import { createClient } from "@libsql/client/web";

/**
 * Attempts a trivial `SELECT 1` against a Turso database using the given
 * credentials. Used to sanity-check a url/authToken pair before it's
 * persisted, so a typo or a stale/revoked token can never silently get
 * saved and strand a school's connection.
 *
 * Deliberately swallows every error — bad URL, bad token, network blip —
 * and just reports "not reachable". The caller decides what to do with that.
 */
export async function verifyTursoConnection(
    url: string,
    authToken: string
): Promise<boolean> {
    try {
        const client = createClient({ url, authToken });
        await client.execute("select 1");
        client.close();
        return true;
    } catch {
        return false;
    }
}

/**
 * Strips the raw auth token out of anything sent back to the browser. The
 * frontend never needs the full secret — only a short preview so an admin
 * can visually confirm which token is currently active after a rotation.
 */
export function redactTursoDb<T extends { authToken: string }>(
    row: T
): Omit<T, "authToken"> & { authTokenPreview: string } {
    const { authToken, ...rest } = row;
    const authTokenPreview =
        authToken.length > 4 ? `••••${authToken.slice(-4)}` : "••••";
    return { ...rest, authTokenPreview };
}