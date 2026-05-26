import { Module } from "@nestjs/common";
import { HealthController } from "./presentation/health.controller";

// Layered structure (per AI_AGENT_RULES.md §3):
//   src/domain          — business rules, entities, value objects
//   src/usecase         — application orchestration
//   src/infrastructure  — DB drivers, external APIs, file I/O
//   src/presentation    — controllers and HTTP wiring
// The contract surface (docs/api-contract.md) lands here in issue 0003.

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
