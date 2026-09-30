import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { env } from './env.js';
import { mockupUrl } from './mockupHost.js';

/**
 * View grants: the row that makes `https://<id>.mockup.m-root.com/` open
 * (journeys build plan J9, PD-9). A grant is **one viewer's window onto one
 * published mockup build**, and its id is the credential — so this file is
 * where an id is made, how long it lives, and when an old one is reused
 * instead of a new one minted.
 */

/** 12 hours (J9): long enough for a review session and the walk to lunch, short
 *  enough that a URL pasted somewhere it should not have been dies by tomorrow. */
export const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A grant with less than this left is not reused: the viewer opening the
 * mockup would get a URL that dies while they are browsing it, and every asset
 * request after that would 404 with nothing on screen to explain why. A
 * fifteen-minute floor means a reused grant always outlives a normal look, and
 * costs at most one extra row per viewer per ~11¾ hours of continuous use.
 */
export const GRANT_REUSE_FLOOR_MS = 15 * 60 * 1000;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 128 random bits as 32 lowercase hex characters — the shape `grantIdFromHost`
 * parses and the `MockupViewGrant_id_shape` CHECK holds. From `crypto`, never
 * `Math.random()`: guessing one is guessing into somebody's mockup.
 */
export function newGrantId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The viewer's grant on this build: an unexpired one if they have it (with
 * room to spare, `GRANT_REUSE_FLOOR_MS`), otherwise a new one.
 *
 * Reusing is what keeps a page-load-per-click portal from writing a row per
 * click ("Grants accumulate", J9's fourth trap). Expired rows are removed
 * **when minting**, and only this viewer's — the lazy clean-up J9 asks for, no
 * scheduler. Two calls racing can each mint one; both are valid and both
 * expire, which is harmless and cheaper than a lock.
 */
export async function grantFor(
  db: Db,
  buildId: string,
  viewerId: string,
  now: Date = new Date(),
): Promise<{ id: string; expiresAt: Date }> {
  const reusable = await db.mockupViewGrant.findFirst({
    where: { buildId, viewerId, expiresAt: { gt: new Date(now.getTime() + GRANT_REUSE_FLOOR_MS) } },
    orderBy: { expiresAt: 'desc' },
    select: { id: true, expiresAt: true },
  });
  if (reusable) return reusable;

  await db.mockupViewGrant.deleteMany({ where: { viewerId, expiresAt: { lte: now } } });
  return db.mockupViewGrant.create({
    data: { id: newGrantId(), buildId, viewerId, expiresAt: new Date(now.getTime() + GRANT_TTL_MS) },
    select: { id: true, expiresAt: true },
  });
}

/**
 * The URL a grant is reached at. Production is `https://<id>.<base>/`; every
 * other environment is plain `http` on **the API's own port**, because a
 * mockup is served by the API directly (the Vite dev server and `vite preview`
 * proxy only `/graphql`, `/upload` and `/files`, and a wildcard host reaches
 * none of them) — `http://<id>.mockup.localhost:<PORT>/`, which a real browser
 * resolves to loopback with no DNS.
 */
export function viewUrlFor(grantId: string): string {
  return env.NODE_ENV === 'production'
    ? mockupUrl(grantId, env.MOCKUP_BASE_DOMAIN)
    : mockupUrl(grantId, env.MOCKUP_BASE_DOMAIN, { protocol: 'http', port: env.PORT });
}
