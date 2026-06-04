import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { DeleteConnection } from "../usecase/delete-connection.use-case";
import { ListConnections, type ListConnectionsOutput } from "../usecase/list-connections.use-case";
import {
  RegisterConnection,
  type RegisterConnectionOutput,
} from "../usecase/register-connection.use-case";
import { RegisterConnectionDto } from "./dto/register-connection.dto";

@Controller("connections")
export class ConnectionsController {
  constructor(
    private readonly registerConnection: RegisterConnection,
    private readonly listConnections: ListConnections,
    private readonly deleteConnection: DeleteConnection,
  ) {}

  @Post()
  register(@Body() body: RegisterConnectionDto): RegisterConnectionOutput {
    // Forward the whole validated DTO — class-validator's whitelist:true
    // pipe has already dropped any non-declared fields, so this is the
    // contract surface that reaches the use case.
    return this.registerConnection.execute(body);
  }

  @Get()
  list(): ListConnectionsOutput {
    return this.listConnections.execute();
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.deleteConnection.execute(id);
  }
}
