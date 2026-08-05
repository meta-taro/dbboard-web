import { IsNotEmpty, IsOptional, IsString } from "class-validator";

// Query schema for GET /connections/:id/table-schema.
//
// The table name is a query parameter rather than a path segment because a
// Postgres identifier may legally contain `/`, `%`, `?` and `#` — a table
// named `a/b` would split the path, and one named `a%2Fb` would decode
// into it. That failure would only ever show up against one user's schema.
//
// `schema` is optional; omitted means "the engine's default", which the
// adapter resolves (`public` on Postgres). Present-but-empty is rejected
// rather than treated as omitted: `?schema=` almost certainly means the
// caller meant to send something and lost it, and querying the catalog
// for a schema named "" would answer "relation does not exist" — a
// misleading way to report a client-side bug.
export class TableSchemaQueryDto {
  @IsString()
  @IsNotEmpty()
  table!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  schema?: string;
}
