import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Server-side Supabase client, used ONLY for Storage.
 *
 * Authenticated with the service-role key, which bypasses RLS — that is exactly
 * why the `pod` bucket can stay private with no policies: nothing except this
 * process can read or write it. The key must never reach a browser or a phone;
 * clients talk to our API, and our API talks to Supabase.
 *
 * `persistSession: false` because there is no user session here — this is a
 * stateless backend, not a logged-in browser.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const POD_BUCKET = env.SUPABASE_STORAGE_BUCKET;

/**
 * Chat attachments live in their own private bucket, never the `pod` one.
 * POD restricts uploads to images because a signature must be an image; chat
 * accepts anything, so mixing them would weaken evidence handling.
 */
export const CHAT_BUCKET = env.CHAT_STORAGE_BUCKET;

/**
 * Profile photos. Private, like everything else here.
 *
 * A face is personal data even when the person is an employee, and object paths
 * in this codebase are deterministic — so a public bucket would mean anyone who
 * guessed a user id could fetch that driver's photo. Reads go through a signed
 * URL the API mints, exactly as proof-of-delivery images do.
 *
 * Its own bucket rather than a folder in `pod`: that bucket is evidence, with a
 * retention story and a seed script that empties it, and a profile photo is
 * neither.
 */
export const AVATAR_BUCKET = env.AVATAR_STORAGE_BUCKET;
