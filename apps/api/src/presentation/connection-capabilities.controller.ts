import { Controller, Get, Param } from "@nestjs/common";
import type { GetCapabilitiesOutput } from "../usecase/get-capabilities.use-case";
import { GetConnectionCapabilities } from "../usecase/get-connection-capabilities.use-case";

// Same response shape as GET /capabilities, so a client can hold one type
// for both. A web-only surface: the desktop has no HTTP capabilities route
// to mirror, and docs/api-contract.md is not touched.
@Controller("connections")
export class ConnectionCapabilitiesController {
  constructor(private readonly getConnectionCapabilities: GetConnectionCapabilities) {}

  @Get(":id/capabilities")
  get(@Param("id") id: string): GetCapabilitiesOutput {
    return this.getConnectionCapabilities.execute(id);
  }
}
