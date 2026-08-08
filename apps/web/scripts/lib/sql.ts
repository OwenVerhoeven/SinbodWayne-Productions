export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlNullableText(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : sqlText(value);
}

export function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("SQL integer must be safe.");
  return String(value);
}

export function sqlJson(value: unknown): string {
  return sqlText(JSON.stringify(value));
}

export function insertOrIgnore(table: string, values: Record<string, string>): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error("Unsafe SQL table identifier.");
  const columns = Object.keys(values);
  if (columns.length === 0 || columns.some((column) => !/^[a-z][a-z0-9_]*$/u.test(column))) {
    throw new Error("Unsafe SQL column identifier.");
  }
  return `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map((column) => values[column])
    .join(", ")});`;
}
