/**
 * Translate DuckDB's pushed-down filters into an ArcGIS `where` clause.
 *
 * Correctness rule: the server-side `where` may return MORE rows than DuckDB
 * asked for, never fewer. DuckDB removes pushed predicates from its own plan;
 * `arcgis_query` sets `autoApplyFilters` so the SDK re-applies all of them to
 * every batch, which trims any extra rows. So only predicates whose ArcGIS
 * meaning is at least as permissive are sent:
 *
 * - numeric columns: `= <> < <= > >=`, `IN`, `NOT IN` against numbers;
 * - string columns: `=` and `IN` only. Many ArcGIS back ends compare strings
 *   case-insensitively and ignore trailing spaces, which can only widen an
 *   equality match; `<>`, `NOT IN` and ranges could drop rows, so they stay
 *   in DuckDB. `starts_with` / `contains` / `ends_with` become `LIKE` when the
 *   text has no LIKE wildcards;
 * - any column: `IS [NOT] NULL`;
 * - `AND` keeps the children it can translate; `OR` only if all of them translate.
 *
 * Dates, casts on columns, functions and expressions are left to DuckDB.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

const NUMERIC = new Set([
  "esriFieldTypeOID",
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeBigInteger",
  "esriFieldTypeDouble",
  "esriFieldTypeSingle",
]);
const STRING = new Set(["esriFieldTypeString", "esriFieldTypeGUID", "esriFieldTypeGlobalID"]);
const SQL_OP: Record<string, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" };
const FLIP: Record<string, string> = { eq: "eq", ne: "ne", gt: "lt", ge: "le", lt: "gt", le: "ge" };
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Literal value, looking through casts DuckDB wraps around constants. */
function literal(e: Expr): { value: unknown } | undefined {
  if (e.node === "literal") return { value: e.value };
  if (e.node === "cast") return literal(e.expression);
  return undefined;
}

function sqlNumber(v: unknown): string | undefined {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function sqlString(v: unknown): string | undefined {
  return typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : undefined;
}

export class WhereBuilder {
  /** @param fieldTypes attribute column name -> Esri field type */
  constructor(private readonly fieldTypes: ReadonlyMap<string, string>) {}

  /** The column an expression names, if it is a bare reference to a known attribute. */
  private column(e: Expr): { name: string; type: string } | undefined {
    if (e.node !== "column_ref") return undefined;
    const type = this.fieldTypes.get(e.columnName);
    if (!type || !SAFE_IDENT.test(e.columnName)) return undefined;
    return { name: e.columnName, type };
  }

  private value(type: string, v: unknown): string | undefined {
    if (NUMERIC.has(type)) return sqlNumber(v);
    if (STRING.has(type)) return sqlString(v);
    return undefined;
  }

  /** One predicate as ArcGIS SQL, or undefined to leave it to DuckDB. */
  translate(e: Expr): string | undefined {
    switch (e.node) {
      case "and": {
        const parts = e.children.map((c) => this.translate(c)).filter((p) => p !== undefined);
        return parts.length ? parts.map((p) => `(${p})`).join(" AND ") : undefined;
      }
      case "or": {
        const parts = e.children.map((c) => this.translate(c));
        return parts.length && parts.every((p) => p !== undefined)
          ? parts.map((p) => `(${p})`).join(" OR ")
          : undefined;
      }
      case "comparison": {
        let op: string = e.op;
        let col = this.column(e.left);
        let lit = literal(e.right);
        if (!col || !lit) {
          col = this.column(e.right);
          lit = literal(e.left);
          op = FLIP[op] ?? op;
        }
        if (!col || !lit || !(op in SQL_OP)) return undefined;
        if (STRING.has(col.type) && op !== "eq") return undefined;
        const v = this.value(col.type, lit.value);
        return v === undefined ? undefined : `${col.name} ${SQL_OP[op]} ${v}`;
      }
      case "in": {
        const col = this.column(e.expression);
        if (!col || e.set.kind !== "literal" || e.set.values.length === 0) return undefined;
        if (e.negated && !NUMERIC.has(col.type)) return undefined;
        const values = e.set.values.map((v) => this.value(col.type, v));
        if (values.some((v) => v === undefined)) return undefined;
        return `${col.name} ${e.negated ? "NOT IN" : "IN"} (${values.join(", ")})`;
      }
      case "is_null": {
        const col = this.column(e.expression);
        return col ? `${col.name} IS ${e.negated ? "NOT " : ""}NULL` : undefined;
      }
      case "call": {
        const fn = e.function;
        if (typeof fn !== "string" || !["starts_with", "contains", "ends_with"].includes(fn)) return undefined;
        const [target, pattern] = e.arguments;
        const col = target && this.column(target);
        const lit = pattern && literal(pattern);
        if (!col || !lit || !STRING.has(col.type) || typeof lit.value !== "string") return undefined;
        if (/[%_[\]]/.test(lit.value)) return undefined;
        const body = lit.value.replace(/'/g, "''");
        const like = fn === "starts_with" ? `${body}%` : fn === "ends_with" ? `%${body}` : `%${body}%`;
        return `${col.name} LIKE '${like}'`;
      }
      default:
        return undefined;
    }
  }

  /** All top-level predicates AND-ed together; `1=1` when nothing translates. */
  where(filters: readonly Expr[]): string {
    const parts = filters.map((f) => this.translate(f)).filter((p) => p !== undefined);
    if (parts.length === 0) return "1=1";
    return parts.length === 1 ? (parts[0] as string) : parts.map((p) => `(${p})`).join(" AND ");
  }
}
