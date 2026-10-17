// PlainGrade Pro (Polar) — one place for the product slug, key prefix, price and the checkout-URL check. Pattern:
// CertGuard src/pro.js. Keys are validated READ-ONLY against the shared LICENSES KV (written only by the license
// gateway); no Polar HTTP and no Polar token in this Worker. Never log, store or echo a raw key.
import { sha256hex } from './limits.js';

export const PRO_PRODUCT_SLUG = 'plaingrade-pro';
export const PRO_KEY_PREFIX = 'PGPR';
export const PRO_PRICE_USD = 5;
/** Polar customer portal (manage / cancel), same org as the other shared Pro products. */
export const PRO_PORTAL_URL = 'https://polar.sh/digital-promo/portal';

/** PRO_CHECKOUT_URL is a wrangler var (placeholder "" until the Polar product exists). Only a Polar checkout link
 * (https://buy.polar.sh/polar_cl_…) is accepted; anything else → null → the CTA renders without a link. */
export function proCheckoutUrl(env) {
  const u = typeof env.PRO_CHECKOUT_URL === 'string' ? env.PRO_CHECKOUT_URL.trim() : '';
  return /^https:\/\/buy\.polar\.sh\/polar_cl_[A-Za-z0-9]{20,80}$/.test(u) ? u : null;
}

/** Case-insensitive product prefix before the first dash (Polar license-key benefit prefix). */
export function looksLikeProKey(key) {
  if (!key || typeof key !== 'string') return false;
  return (key.trim().split('-')[0] || '').toUpperCase() === PRO_KEY_PREFIX;
}

/** Stable, non-reversible id for a license (limiter + daily quota). Never store or return the raw key. */
export async function proKeyIdFor(rawKey) {
  return 'pro:' + (await sha256hex('plaingrade-pro:' + rawKey)).slice(0, 32);
}
