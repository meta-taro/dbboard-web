import { Controller, Get } from "@nestjs/common";
import { GetCapabilities, type GetCapabilitiesOutput } from "../usecase/get-capabilities.use-case";

@Controller("capabilities")
export class CapabilitiesController {
  constructor(private readonly getCapabilities: GetCapabilities) {}

  @Get()
  get(): GetCapabilitiesOutput {
    return this.getCapabilities.execute();
  }
}
