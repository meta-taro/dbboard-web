import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import type { AiResponse } from "../domain/ai/ai-provider.port";
import { ExplainSql } from "../usecase/explain-sql.use-case";
import { SuggestSql } from "../usecase/suggest-sql.use-case";
import { AiExplainRequestDto } from "./dto/ai-explain-request.dto";
import { AiSuggestRequestDto } from "./dto/ai-suggest-request.dto";

// Web-only AI surface — POST /ai/explain and POST /ai/suggest. These
// routes are NOT in docs/api-contract.md per desktop ADR-0023
// Decision 3 (AI stays in-process on desktop; web exposes a thin
// HTTP wrapper).
//
// Deliberately NOT decorated with `@UseInterceptors(
// HistoryRecordingInterceptor)`. AI calls must not enter
// `history.jsonl` — that would force a v:1 → v:2 schema bump ahead
// of cross-repo coordination. An integration spec
// (test/ai-routes.integration.spec.ts) asserts /history/export.jsonl
// stays empty after an AI call.
@Controller("ai")
export class AiController {
  constructor(
    private readonly explainSql: ExplainSql,
    private readonly suggestSql: SuggestSql,
  ) {}

  // Nest defaults POST to 201 Created; the AI routes are 200 OK
  // because the response is the result of a synchronous query, not
  // the creation of a new resource.
  @Post("explain")
  @HttpCode(200)
  explain(@Body() body: AiExplainRequestDto): Promise<AiResponse> {
    return this.explainSql.execute({ sql: body.sql, dialect: body.dialect });
  }

  @Post("suggest")
  @HttpCode(200)
  suggest(@Body() body: AiSuggestRequestDto): Promise<AiResponse> {
    return this.suggestSql.execute({ prompt: body.prompt, dialect: body.dialect });
  }
}
