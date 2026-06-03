import { Controller, Get } from "@nestjs/common";
import type { GetCapabilities} from "../usecase/get-capabilities.use-case";
import { type GetCapabilitiesOutput } from "../usecase/get-capabilities.use-case";

@Controller("capabilities")
export class CapabilitiesController {
  constructor(private readonly getCapabilities: GetCapabilities) {}

  @Get()
  get(): GetCapabilitiesOutput {
    return this.getCapabilities.execute();
  }
}
