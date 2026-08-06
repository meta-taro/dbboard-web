import Anthropic from "@anthropic-ai/sdk";
import { Module } from "@nestjs/common";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./bootstrap/config";
import { AI_PROVIDER, type AiProvider } from "./domain/ai/ai-provider.port";
import { DATABASE_ADAPTER } from "./domain/database-adapter.port";
import { AnthropicProvider, type AnthropicClient } from "./infrastructure/anthropic-provider";
import { InMemoryConnectionRegistry } from "./infrastructure/in-memory-connection-registry";
import { InMemoryHistoryStore } from "./infrastructure/in-memory-history-store";
import { NullAdapter } from "./infrastructure/null-adapter";
import { StaticAdapterFactory } from "./infrastructure/static-adapter-factory";
import { AiController } from "./presentation/ai.controller";
import { CapabilitiesController } from "./presentation/capabilities.controller";
import { ConnectionCapabilitiesController } from "./presentation/connection-capabilities.controller";
import { ConnectionDumpController } from "./presentation/connection-dump.controller";
import { ConnectionRestoreController } from "./presentation/connection-restore.controller";
import { ConnectionRowsController } from "./presentation/connection-rows.controller";
import { ConnectionSchemaController } from "./presentation/connection-schema.controller";
import { ConnectionTablesController } from "./presentation/connection-tables.controller";
import { ConnectionsController } from "./presentation/connections.controller";
import { HealthController } from "./presentation/health.controller";
import { HistoryController } from "./presentation/history.controller";
import { HistoryRecordingInterceptor } from "./presentation/interceptors/history-recording.interceptor";
import { QueryController } from "./presentation/query.controller";
import { TablesController } from "./presentation/tables.controller";
import { ADAPTER_FACTORY } from "./usecase/adapter-factory.port";
import { CONNECTION_REGISTRY } from "./usecase/connection-registry.port";
import { DeleteConnection } from "./usecase/delete-connection.use-case";
import { DescribeTable } from "./usecase/describe-table.use-case";
import { DumpDatabase } from "./usecase/dump-database.use-case";
import { ExecuteQuery } from "./usecase/execute-query.use-case";
import { ExplainSql } from "./usecase/explain-sql.use-case";
import { ExportHistory } from "./usecase/export-history.use-case";
import { GetCapabilities } from "./usecase/get-capabilities.use-case";
import { GetConnectionCapabilities } from "./usecase/get-connection-capabilities.use-case";
import { GetHealth } from "./usecase/get-health.use-case";
import { HISTORY_STORE, type HistoryStore } from "./usecase/history-store.port";
import { ListConnectionTables } from "./usecase/list-connection-tables.use-case";
import { ListConnections } from "./usecase/list-connections.use-case";
import { ListDrivers } from "./usecase/list-drivers.use-case";
import { ListTables } from "./usecase/list-tables.use-case";
import { RecordHistory } from "./usecase/record-history.use-case";
import { RegisterConnection } from "./usecase/register-connection.use-case";
import { RestoreDatabase } from "./usecase/restore-database.use-case";
import { SuggestSql } from "./usecase/suggest-sql.use-case";
import { UpdateConnection } from "./usecase/update-connection.use-case";
import { UpdateRow } from "./usecase/update-row.use-case";

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
    ConnectionTablesController,
    ConnectionCapabilitiesController,
    ConnectionSchemaController,
    ConnectionRowsController,
    ConnectionDumpController,
    ConnectionRestoreController,
    HistoryController,
    AiController,
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
      provide: ListConnectionTables,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new ListConnectionTables(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: DescribeTable,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new DescribeTable(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: DumpDatabase,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new DumpDatabase(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    // The write-side counterpart of DumpDatabase (ticket 0030). Same
    // per-request resolution: a restore always runs on the adapter the
    // connection currently holds.
    {
      provide: RestoreDatabase,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new RestoreDatabase(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    // The one write path (ticket 0028). Resolved per request like every
    // other scoped use case, so an edit always runs on the adapter the
    // connection currently holds — never one cached across a rebuild
    // (ticket 0027).
    {
      provide: UpdateRow,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new UpdateRow(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: GetConnectionCapabilities,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new GetConnectionCapabilities(adapter, registry),
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
    {
      provide: UpdateConnection,
      useFactory: (registry: InMemoryConnectionRegistry, factory: StaticAdapterFactory) =>
        new UpdateConnection(registry, factory),
      inject: [CONNECTION_REGISTRY, ADAPTER_FACTORY],
    },
    {
      provide: ListDrivers,
      useFactory: (factory: StaticAdapterFactory) => new ListDrivers(factory),
      inject: [ADAPTER_FACTORY],
    },
    { provide: HISTORY_STORE, useClass: InMemoryHistoryStore },
    // AI provider (Phase 6 Slice 1). Returns `undefined` when no API
    // key is configured — consumers MUST mark the injection
    // `@Optional()`. The `as unknown as AnthropicClient` cast adapts
    // the SDK's overloaded `messages.create` to the narrow non-
    // streaming slice the provider depends on (see anthropic-provider.ts
    // for why the structural assertion lives at the wiring seam).
    {
      provide: AI_PROVIDER,
      useFactory: (): AnthropicProvider | undefined => {
        if (ANTHROPIC_API_KEY === undefined) return undefined;
        const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        return new AnthropicProvider(client as unknown as AnthropicClient, ANTHROPIC_MODEL);
      },
    },
    // ExplainSql / SuggestSql consume the AI_PROVIDER token, which may
    // resolve to `undefined` when no API key is configured. The use
    // case translates that absence into AiDisabledError (→ 404) at
    // call time, so the wiring stays simple here. `optional: true`
    // belt-and-braces against a future refactor that removes the
    // AI_PROVIDER registration entirely.
    //
    // `RecordHistory` is injected, not optional: since history v:2
    // (ticket 0023) AI calls are recorded alongside SQL calls, and a
    // provider-less deployment still resolves this fine because the
    // recorder is only reached once a provider has answered.
    {
      provide: ExplainSql,
      useFactory: (provider: AiProvider | undefined, history: RecordHistory) =>
        new ExplainSql(provider, history),
      inject: [{ token: AI_PROVIDER, optional: true }, RecordHistory],
    },
    {
      provide: SuggestSql,
      useFactory: (provider: AiProvider | undefined, history: RecordHistory) =>
        new SuggestSql(provider, history),
      inject: [{ token: AI_PROVIDER, optional: true }, RecordHistory],
    },
    {
      provide: RecordHistory,
      useFactory: (store: HistoryStore) => new RecordHistory(store),
      inject: [HISTORY_STORE],
    },
    {
      provide: ExportHistory,
      useFactory: (store: HistoryStore) => new ExportHistory(store),
      inject: [HISTORY_STORE],
    },
    HistoryRecordingInterceptor,
  ],
})
export class AppModule {}
