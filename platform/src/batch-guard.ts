/**
 * A condition for a statement inside a D1 batch: the statement only writes when `sql` (a boolean SQL expression) holds
 * at the moment it runs. `sql` refers to its one bound value as ?2 (the guarded statement keeps ?1 for its own value).
 *
 * Used where a batch starts with a conditional write (UPDATE ... WHERE <expected state>) and the statements after it
 * must do nothing when that write changed no row, e.g. a lost race in src/routes/move.ts.
 */
export interface BatchGuard {
  sql: string;
  value: string | number;
}
