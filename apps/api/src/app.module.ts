import { Module } from "@nestjs/common";
import { DATABASE_ADAPTER } from "./domain/database-adapter.port";
import { InMemoryConnectionRegistry } from "./infrastructure/in-memory-connection-registry";
import { InMemoryHistoryStore } from "./infrastructure/in-memory-history-store";
import { NullAdapter } from "./infrastructure/null-adapter";
import { StaticAdapterFactory } from "./infrastructure/static-adapter-factory";
import { CapabilitiesController } from "./presentation/capabilities.controller";
import { ConnectionsController } from "./presentation/connections.controller";
import { HealthController } from "./presentation/health.controller";
import { HistoryRecordingInterceptor } from "./presentation/interceptors/history-recording.interceptor";
import { QueryController } from "./presentation/query.controller";
import { TablesController } from "./presentation/tables.controller";
import { ADAPTER_FACTORY } from "./usecase/adapter-factory.port";
import { CONNECTION_REGISTRY } from "./usecase/connection-registry.port";
import { DeleteConnection } from "./usecase/delete-connection.use-case";
import { ExecuteQuery } from "./usecase/execute-query.use-case";
import { GetCapabilities } from "./usecase/get-capabilities.use-case";
import { GetHealth } from "./usecase/get-health.use-case";
import { HISTORY_STORE, type HistoryStore } from "./usecase/history-store.port";
import { ListConnections } from "./usecase/list-connections.use-case";
import { ListTables } from "./usecase/list-tables.use-case";
import { RecordHistory } from "./usecase/record-history.use-case";
import { RegisterConnection } from "./usecase/register-connection.use-case";

// Layered structure (per AI_AGENT_RULES.md §3):
//   src/domain          — business rules, entities, value objects
//   src/usecase         — application orchestration
//   src/infrastructure  — DB drivers, external APIs, file I/O
//   src/presentation    — controllers and HTTP wiring
//
// 0003 ships the NullAdapter as the default. 0004 will replace
// DATABASE_ADAPTER's useClass / useFactory with the Postgres adapter
// without touching controllers or use cases.

@Module({
  controllers: [
    HealthController,
    TablesController,
    CapabilitiesController,
    QueryController,
    ConnectionsController,
  ],
  providers: [
    { provide: DATABASE_ADAPTER, useClass: NullAdapter },
    { provide: CONNECTION_REGISTRY, useClass: InMemoryConnectionRegistry },
    { provide: ADAPTER_FACTORY, useClass: StaticAdapterFactory },
    GetHealth,
    {
      provide: ListTables,
      useFactory: (adapter: NullAdapter) => new ListTables(adapter),
      inject: [DATABASE_ADAPTER],
    },
    {
      provide: GetCapabilities,
      useFactory: (adapter: NullAdapter) => new GetCapabilities(adapter),
      inject: [DATABASE_ADAPTER],
    },
    {
      provide: ExecuteQuery,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new ExecuteQuery(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: RegisterConnection,
      useFactory: (registry: InMemoryConnectionRegistry, factory: StaticAdapterFactory) =>
        new RegisterConnection(registry, factory),
      inject: [CONNECTION_REGISTRY, ADAPTER_FACTORY],
    },
    {
      provide: ListConnections,
      useFactory: (registry: InMemoryConnectionRegistry) => new ListConnections(registry),
      inject: [CONNECTION_REGISTRY],
    },
    {
      provide: DeleteConnection,
      useFactory: (registry: InMemoryConnectionRegistry) => new DeleteConnection(registry),
      inject: [CONNECTION_REGISTRY],
    },
    { provide: HISTORY_STORE, useClass: InMemoryHistoryStore },
    {
      provide: RecordHistory,
      useFactory: (store: HistoryStore) => new RecordHistory(store),
      inject: [HISTORY_STORE],
    },
    HistoryRecordingInterceptor,
  ],
})
export class AppModule {}
