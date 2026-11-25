// SCRAM-SHA-256-Verifier (RFC 5802/7677, Postgres-Format) clientseitig berechnet (Review W4a): so
// erreicht nie ein Klartext-Passwort den Server (und damit kein Server-Log, auch nicht bei
// log_statement oder in einer Fehlermeldung). Postgres speichert einen Wert dieser Form unverändert.
//   SCRAM-SHA-256$<iterationen>:<salt base64>$<StoredKey base64>:<ServerKey base64>
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;

export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
): string {
  // SASLprep: für druckbare ASCII-Passwörter ohne Leerzeichen ist die Normalisierung die Identität.
  if (!/^[\x21-\x7e]+$/.test(password))
    throw new Error('nur druckbare ASCII-Passwörter ohne Leerzeichen unterstützt');
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (b: Buffer) => b.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/** `ALTER ROLE … PASSWORD '<Verifier>'` – enthält nie den Klartext. */
export function alterRolePasswordSql(role: string, password: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Rollenname ${role} ungültig`);
  const v = scramSha256Verifier(password);
  if (!/^[A-Za-z0-9+/=:$-]+$/.test(v)) throw new Error('Verifier mit unerwarteten Zeichen');
  return `ALTER ROLE "${role}" PASSWORD '${v}'`;
}
