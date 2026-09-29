import bcrypt from 'bcryptjs';

/** Length beats composition rules; 10 is the floor the UI also enforces. */
export const MIN_PASSWORD_LENGTH = 10;

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);

export const verifyPassword = (plain: string, hash: string) =>
  bcrypt.compare(plain, hash);

/**
 * A real bcrypt hash of a random string nobody holds, at the same cost as
 * every stored one. `signIn` compares against it when the identifier matches
 * no usable account, so a wrong identifier and a wrong password take the
 * same time — without it, "no such account" came back before bcrypt ever ran
 * and the response time alone said which identifiers exist (J1 review;
 * true of the email-only sign-in before J1 too). Computed once, lazily.
 */
let dummyHash: Promise<string> | null = null;
export const burnPasswordCheck = async (plain: string): Promise<void> => {
  dummyHash ??= bcrypt.hash(`no-account-${Math.random()}-${Date.now()}`, 12);
  await bcrypt.compare(plain, await dummyHash);
};
