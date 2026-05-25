import { Controller, Get } from "@nestjs/common";

// Stub for the contract's GET /health endpoint.
// The real liveness logic (binding state, adapter readiness) ships with issue 0003.
@Controller("health")
export class HealthController {
  @Get()
  status(): { status: "ok" } {
    return { status: "ok" };
  }
}
