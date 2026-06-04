// Liveness probe behind the contract surface. Stays a use case rather
// than living in the controller so the dependency graph (controllers
// only ever call use cases) is uniform.
export interface HealthStatus {
  status: "ok";
}

export class GetHealth {
  execute(): HealthStatus {
    return { status: "ok" };
  }
}
