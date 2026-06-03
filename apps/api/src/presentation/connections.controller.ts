import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import type { DeleteConnection } from "../usecase/delete-connection.use-case";
import type { ListConnections} from "../usecase/list-connections.use-case";
import { type ListConnectionsOutput } from "../usecase/list-connections.use-case";
import type {
  RegisterConnection} from "../usecase/register-connection.use-case";
import {
  type RegisterConnectionOutput,
} from "../usecase/register-connection.use-case";
import type { RegisterConnectionDto } from "./dto/register-connection.dto";

@Controller("connections")
export class ConnectionsController {
  constructor(
    private readonly registerConnection: RegisterConnection,
    private readonly listConnections: ListConnections,
    private readonly deleteConnection: DeleteConnection,
  ) {}

  @Post()
  register(@Body() body: RegisterConnectionDto): RegisterConnectionOutput {
    return this.registerConnection.execute({ label: body.label, driver: body.driver });
  }

  @Get()
  list(): ListConnectionsOutput {
    return this.listConnections.execute();
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string): void {
    this.deleteConnection.execute(id);
  }
}
