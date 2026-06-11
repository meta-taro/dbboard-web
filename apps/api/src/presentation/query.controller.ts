import { Body, Controller, HttpCode, Param, Post, UseInterceptors } from "@nestjs/common";
import type { QueryResult } from "../domain/values";
import { ExecuteQuery } from "../usecase/execute-query.use-case";
import { QueryRequestDto } from "./dto/query-request.dto";
import { HistoryRecordingInterceptor } from "./interceptors/history-recording.interceptor";

@Controller()
@UseInterceptors(HistoryRecordingInterceptor)
export class QueryController {
  constructor(private readonly executeQuery: ExecuteQuery) {}

  // docs/api-contract.md pins POST /query at 200 OK on success — NestJS
  // would otherwise default to 201 Created for POST handlers.
  @Post("query")
  @HttpCode(200)
  run(@Body() body: QueryRequestDto): Promise<QueryResult> {
    return this.executeQuery.execute(body.sql);
  }

  @Post("connections/:id/query")
  @HttpCode(200)
  runOn(@Param("id") id: string, @Body() body: QueryRequestDto): Promise<QueryResult> {
    return this.executeQuery.execute(body.sql, id);
  }
}
