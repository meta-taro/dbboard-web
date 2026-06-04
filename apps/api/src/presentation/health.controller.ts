import { Controller, Get } from "@nestjs/common";
import { GetHealth, type HealthStatus } from "../usecase/get-health.use-case";

@Controller("health")
export class HealthController {
  constructor(private readonly getHealth: GetHealth) {}

  @Get()
  status(): HealthStatus {
    return this.getHealth.execute();
  }
}
