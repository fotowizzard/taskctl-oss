/**
 * Prompt-pack loader — WP2 Stage 2b.
 *
 * Selects a PROJECT-NEUTRAL prompt pack by language. Both packs carry the same
 * neutral engineering semantics; only the phrasing differs. Selecting a
 * language never selects project behavior (I2). Unknown languages fall back to
 * English.
 */

import { pack as en } from './en.mjs';
import { pack as ru } from './ru.mjs';

const PACKS = { en, ru };

/**
 * @param {'en'|'ru'} [language] prompt language (default 'en')
 * @returns the prompt pack object (builders return arrays of lines)
 */
export function loadPromptPack(language) {
  return PACKS[language] ?? en;
}
