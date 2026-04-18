/**
 * Sanitize a user-supplied string before echoing it back into an error message
 * or warning returned to the MCP client.
 *
 * Why: any field the server returns flows into the LLM context, so unescaped
 * control characters, zero-width characters, or long payloads in user-supplied
 * filenames or paths can be used as a prompt-injection vector
 * ("Poison Everywhere" / output-channel injection).
 *
 * Strips ASCII control characters (except tab), Unicode zero-width and
 * directionality-override characters, then caps the length.
 */
export function sanitizeForMessage(input: unknown, maxLen = 256): string {
  const s = typeof input === "string" ? input : String(input);

  // Strip ASCII control chars (0x00-0x08, 0x0B-0x1F, 0x7F) — keep \t and \n stripped too
  // to avoid breaking single-line error messages.
  // eslint-disable-next-line no-control-regex
  const noControl = s.replace(/[\x00-\x1F\x7F]/g, "");

  // Strip zero-width and bidi-override characters commonly used in
  // hidden-instruction injection.
  const noInvisible = noControl.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g,
    "",
  );

  if (noInvisible.length <= maxLen) return noInvisible;
  return `${noInvisible.slice(0, maxLen)}…`;
}
