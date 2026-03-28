/**
 * Parse a single CSV line into an array of fields. Handles:
 *   - Fields wrapped in double-quotes
 *   - Embedded commas inside quoted fields
 *   - Escaped double-quotes represented as two consecutive double-quotes ("")
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const len = line.length;

  while (i <= len) {
    if (i === len) {
      // Trailing empty field after a terminal comma
      if (fields.length > 0 && line[len - 1] === ",") {
        fields.push("");
      }
      break;
    }

    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            // Escaped double-quote
            field += '"';
            i += 2;
          } else {
            // Closing quote
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // Skip the comma separator (or end of string)
      if (i < len && line[i] === ",") i++;
    } else {
      // Unquoted field — read until next comma or end
      const start = i;
      while (i < len && line[i] !== ",") i++;
      fields.push(line.slice(start, i));
      if (i < len) i++; // skip comma
    }
  }

  return fields;
}
