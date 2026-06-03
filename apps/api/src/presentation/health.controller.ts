import { Controller, Get } from "@nestjs/common";
import type { GetHealth} from "../usecase/get-health.use-case";
import { type HealthStatus } from "../usecase/get-health.use-case";

@Controller("health")
export class HealthController {
  constructor(private readonly getHealth: GetHealth) {}

  @Get()
  status(): HealthStatus {
    return this.getHealth.execute();
  }
}
