import { Body, Controller, Param, Post } from "@nestjs/common";
import type { QueryResult } from "../domain/values";
import type { ExecuteQuery } from "../usecase/execute-query.use-case";
import type { QueryRequestDto } from "./dto/query-request.dto";

@Controller()
export class QueryController {
  constructor(private readonly executeQuery: ExecuteQuery) {}

  @Post("query")
  run(@Body() body: QueryRequestDto): Promise<QueryResult> {
    return this.executeQuery.execute(body.sql);
  }

  @Post("connections/:id/query")
  runOn(@Param("id") id: string, @Body() body: QueryRequestDto): Promise<QueryResult> {
    return this.executeQuery.execute(body.sql, id);
  }
}
