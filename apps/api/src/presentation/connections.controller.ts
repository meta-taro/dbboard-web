import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { DeleteConnection } from "../usecase/delete-connection.use-case";
import {
  ListConnections,
  type ConnectionView,
  type ListConnectionsOutput,
} from "../usecase/list-connections.use-case";
import { ListDrivers, type ListDriversOutput } from "../usecase/list-drivers.use-case";
import {
  RegisterConnection,
  type RegisterConnectionOutput,
} from "../usecase/register-connection.use-case";
import { UpdateConnection } from "../usecase/update-connection.use-case";
import { RegisterConnectionDto } from "./dto/register-connection.dto";
import { UpdateConnectionDto } from "./dto/update-connection.dto";

@Controller("connections")
export class ConnectionsController {
  constructor(
    private readonly registerConnection: RegisterConnection,
    private readonly listConnections: ListConnections,
    private readonly deleteConnection: DeleteConnection,
    private readonly updateConnection: UpdateConnection,
    private readonly listDrivers: ListDrivers,
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

  // Declared before any `:id` route so a literal path segment is never
  // read as an id. Nothing routes `GET /connections/:id` today, but the
  // ordering costs nothing and slice G adds a sibling that would.
  @Get("drivers")
  drivers(): ListDriversOutput {
    return this.listDrivers.execute();
  }

  // PATCH rather than PUT: the body is allowed to name only what changed,
  // and a password it does not name is kept rather than removed (ADR-0080).
  // The response is the same view `GET /connections` lists, so a form that
  // just saved has the record it should now be showing without re-fetching.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateConnectionDto): Promise<ConnectionView> {
    return this.updateConnection.execute(id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.deleteConnection.execute(id);
  }
}
