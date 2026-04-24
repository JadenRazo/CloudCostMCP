/**
 * CSV cell escaping that neutralizes both formula injection and row injection.
 *
 * Why this is not just the obvious "quote if the value contains , or \"":
 *
 *   1. Formula injection (CWE-1236): when a cell starts with =, +, -, @, TAB,
 *      or CR, Excel / LibreOffice / Google Sheets may interpret it as a
 *      formula on open. A resource name like `=HYPERLINK("http://x")` will
 *      execute and can exfiltrate adjacent cells. The OWASP-recommended
 *      mitigation is to prefix the cell with a single quote, which forces
 *      text interpretation.
 *
 *   2. CR row injection (CWE-93): bare \r is treated as a row terminator by
 *      some CSV parsers. Quoting on \r keeps the cell contained.
 *
 * Numeric inputs are rendered without the formula prefix: a real number like
 * -0.50 is a legitimate value, not an attacker-supplied formula trigger.
 */
export function csvEscape(value: string | number): string {
  if (typeof value === "number") {
    // Finite numbers serialize directly; non-finite emit an empty cell
    // (Excel has no useful representation of NaN/Infinity).
    return Number.isFinite(value) ? String(value) : "";
  }

  let str = String(value);

  // Formula-injection neutralization: prefix with ' if the cell opens with a
  // trigger character. Excel strips the leading ' on display while treating
  // the content as text; other viewers show it but do not execute.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }

  // Quote on ", comma, or any newline (LF or CR). Internal " becomes "".
  if (/["\n\r,]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}
