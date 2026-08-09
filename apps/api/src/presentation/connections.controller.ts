import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { DeleteConnection } from "../usecase/delete-connection.use-case";
import {
  ListConnections,
  type ConnectionView,
  type ListConnectionsOutput,
} from "../usecase/list-connections.use-case";
import { ListDrivers, type ListDriversOutput } from "../usecase/list-drivers.use-case";
import {
  ProbeSshHostKey,
  type ProbeSshHostKeyOutput,
} from "../usecase/probe-ssh-host-key.use-case";
import {
  RegisterConnection,
  type RegisterConnectionOutput,
} from "../usecase/register-connection.use-case";
import { UpdateConnection } from "../usecase/update-connection.use-case";
import { ProbeSshHostKeyDto } from "./dto/probe-ssh-host-key.dto";
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
    private readonly probeSshHostKeyUseCase: ProbeSshHostKey,
  ) {}

  @Post()
  async register(@Body() body: RegisterConnectionDto): Promise<RegisterConnectionOutput> {
    // Forward the whole validated DTO — class-validator's whitelist:true
    // pipe has already dropped any non-declared fields, so this is the
    // contract surface that reaches the use case.
    //
    // Awaited since 0031 slice D: registering a connection behind an SSH
    // tunnel opens the forward first. The HTTP contract is unchanged — Nest
    // resolves a returned promise either way — but the failure has to surface
    // here, as a rejected request, and not as an unhandled rejection.
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

  // Under `/connections` because it serves the connection form, and before
  // the `:id` routes on the same rule as `drivers`.
  //
  // POST rather than GET despite reading nothing: it dials a host named in
  // the request, and a GET is the shape browsers and proxies feel free to
  // prefetch and cache. 200 rather than the 201 Nest would default to —
  // nothing is created, which is half of what makes the probe safe (see the
  // use case).
  //
  // It is an outbound dial on request, but not a new capability for this
  // API: `POST /connections` already connects wherever the body says. The
  // exposure is the same one `docs/deployment.md` describes, and the same
  // bearer gate covers it.
  @Post("ssh/host-key")
  @HttpCode(200)
  probeSshHostKey(@Body() body: ProbeSshHostKeyDto): Promise<ProbeSshHostKeyOutput> {
    return this.probeSshHostKeyUseCase.execute(body);
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
