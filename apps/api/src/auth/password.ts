import bcrypt from 'bcryptjs';

/** Length beats composition rules; 10 is the floor the UI also enforces. */
export const MIN_PASSWORD_LENGTH = 10;

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);

export const verifyPassword = (plain: string, hash: string) =>
  bcrypt.compare(plain, hash);
