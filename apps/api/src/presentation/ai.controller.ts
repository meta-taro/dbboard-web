import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import type { AiResponse } from "../domain/ai/ai-provider.port";
import { ExplainSql } from "../usecase/explain-sql.use-case";
import { SuggestSql } from "../usecase/suggest-sql.use-case";
import { AiExplainRequestDto } from "./dto/ai-explain-request.dto";
import { AiSuggestRequestDto } from "./dto/ai-suggest-request.dto";

// The wire body, documented in docs/deployment.md as `200 { text, model }`.
// `AiResponse` grew token counts and a stop reason with history v:2
// (ticket 0023), but those exist to be *recorded*, not returned: widening
// the response by accident would make an internal refactor a wire change.
// If the UI ever needs usage figures, that is a deliberate contract edit.
interface AiResponseBody {
  text: string;
  model: string;
}

function toBody(response: AiResponse): AiResponseBody {
  return { text: response.text, model: response.model };
}

// Web-only AI surface — POST /ai/explain and POST /ai/suggest. These
// routes are NOT in docs/api-contract.md per desktop ADR-0023
// Decision 3 (AI stays in-process on desktop; web exposes a thin
// HTTP wrapper).
//
// Still NOT decorated with `@UseInterceptors(
// HistoryRecordingInterceptor)` — but the reason changed with ticket
// 0023. AI calls *are* recorded now: the v:1 → v:2 bump landed with
// desktop ADR-0027, and history v:2 has a `kind: "ai"` record for
// exactly this. What has not changed is where the recording happens.
// The interceptor reads `req.body.sql` and maps a `QueryResult`; an AI
// call has neither. ExplainSql / SuggestSql own the timing boundary and
// the AiError taxonomy, so they record — see record-ai-call.ts.
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
  async explain(@Body() body: AiExplainRequestDto): Promise<AiResponseBody> {
    return toBody(await this.explainSql.execute({ sql: body.sql, dialect: body.dialect }));
  }

  @Post("suggest")
  @HttpCode(200)
  async suggest(@Body() body: AiSuggestRequestDto): Promise<AiResponseBody> {
    return toBody(
      await this.suggestSql.execute({
        prompt: body.prompt,
        dialect: body.dialect,
        // An entry may arrive without a `schema` key at all; the domain
        // value spells "unqualified" as null, so normalise here rather
        // than leaving two ways to say the same thing past the boundary.
        schema: body.schema?.map((table) => ({ schema: table.schema ?? null, name: table.name })),
      }),
    );
  }
}
